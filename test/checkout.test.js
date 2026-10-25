import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { step, localReport } from '../src/checkout.js';
import { configValue, stateValue, newState, actionBinding, ingest, report, hash, MAX_EVENTS } from '../src/model.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateConnection, loadConnection, loadEnvironment } from '../src/config.js';
import { CONFIG, ROOM, ROOM_ID, TOKEN, AT, A, B, C, id, event, batch, ROOMS, ACTIONS, mockApi } from './fixtures.js';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'checkout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const base = () => newState({ config: CONFIG, room: ROOM, roomId: ROOM_ID, token: TOKEN, actions: actionBinding(ACTIONS, configValue(CONFIG)), cursor: id(0), at: AT });
const options = (directory, client, extra = {}) => ({ directory, client, config: CONFIG, room: ROOM, token: TOKEN, now: () => AT, ...extra });
const saved = directory => readJson(join(directory, 'state.json'));

test('public SDK bootstrap uses empty head, no after, timeout zero, and direct action arrays', async t => {
  const directory = await workspace(t), zero = '00000000-0000-0000-0000-000000000000';
  const { client, calls } = mockApi({ batches: [batch([], zero)] });
  const result = await step(options(directory, client));
  assert.equal(result.bootstrapped, true); assert.equal(result.observedCursor, zero);
  assert.deepEqual(result.assets.map(a => a.holder), [null, null]);
  assert.deepEqual(calls.map(c => c.path), ['/api/agent/rooms', `/api/agent/rooms/${ROOM}/actions`, '/api/agent/notifications/wait', `/api/agent/rooms/${ROOM}/actions`]);
  assert.deepEqual(calls[2].query, { timeout: '0', limit: '50' });
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('conflicts, repeated requests, and holder-only release commit together', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  const { client, calls } = mockApi({ batches: [batch([event(1), event(2), event(3, 1, C), event(4, 2, C), event(5, 2, B), event(6, 2, B), event(7, 1, C), event(8, 3, B)])] });
  const result = await step(options(directory, client));
  assert.deepEqual(result.requests.map(e => e.outcome), ['borrowed', 'already_held_by_you', 'unavailable', 'not_holder', 'returned', 'already_available', 'borrowed', 'borrowed']);
  assert.deepEqual(result.assets.map(a => a.holder.id), [C, B]);
  assert.deepEqual(calls[2].query, { after: id(0), timeout: '20', limit: '50' });
  const raw = await readFile(join(directory, 'state.json'), 'utf8');
  assert.ok(!raw.includes('not interpreted')); assert.ok(!raw.includes('not executed')); assert.ok(!raw.includes(TOKEN));
  assert.equal((await saved(directory)).cursor, id(8));
});

test('restart preserves holders indefinitely and later return requires original holder', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', ingest(base(), batch([event(1)]), AT));
  const empty = mockApi({ batches: [batch([], id(1))] });
  const later = '2027-01-01T00:00:00.000Z';
  const first = await step(options(directory, empty.client, { now: () => later }));
  assert.equal(first.assets[0].holder.id, B);
  const next = mockApi({ batches: [batch([event(2, 2, C), event(3, 2, B)])] });
  const result = await step(options(directory, next.client, { now: () => later }));
  assert.equal(result.assets[0].holder, null); assert.equal(result.requests[1].outcome, 'not_holder');
});

test('only explicit trusted manual human provenance affects assets', () => {
  const variants = [
    { room: { code: 'OTHERROOM123' } }, { sender: { id: A } }, { action_number: 9 }, { trigger_source: 'api' },
    { trigger_source: null }, { trigger_source: undefined }, { origin_agent: { handle: 'robot' } }, { origin_agent: undefined },
    { question: {} }, { question: undefined }, { is_handoff: true }, { is_handoff: undefined }
  ];
  const rows = variants.map((v, i) => event(i + 1, 1, B, v));
  const result = ingest(base(), batch(rows), AT);
  assert.equal(result.events.length, 0); assert.equal(result.cursor, id(rows.length));
  assert.deepEqual(Object.values(result.holders), [null, null]);
});

test('connected observer rows are not expected to be delivered by the API', () => {
  // The real wait endpoint excludes account A. Even a malformed fixture returning A is untrusted here.
  const result = ingest(base(), batch([event(1, 1, A)]), AT);
  assert.equal(result.events.length, 0); assert.equal(result.holders.camera, null);
});

test('malformed eligible event after a valid borrow leaves prior batch unchanged', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  const { client } = mockApi({ batches: [batch([event(1), event(2, 2, B, { created_at: '2026-02-30T00:00:00Z' })])] });
  await assert.rejects(step(options(directory, client)), /timestamp/);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
});

test('duplicate, old, unordered, and mismatched cursor batches cannot mutate state', () => {
  const state = ingest(base(), batch([event(1)]), AT), before = JSON.stringify(state);
  for (const invalid of [batch([event(2), event(2)]), batch([event(1)]), batch([event(3), event(2)]), batch([event(2)], id(3)), batch([], id(0)), batch([], id(2))]) {
    assert.throws(() => ingest(state, invalid, AT)); assert.equal(JSON.stringify(state), before);
  }
});

test('uncommitted batch can replay after save failure; committed duplicate cannot reapply', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  const first = mockApi({ batches: [batch([event(1)])] });
  await assert.rejects(step(options(directory, first.client, { save: async () => { throw new Error('disk full'); } })), /disk full/);
  assert.equal((await saved(directory)).cursor, id(0));
  const replay = mockApi({ batches: [batch([event(1)])] });
  await step(options(directory, replay.client));
  assert.equal((await saved(directory)).events.length, 1);
  const duplicate = mockApi({ batches: [batch([event(1)])] });
  await assert.rejects(step(options(directory, duplicate.client)), /Repeated/);
  assert.equal((await saved(directory)).events.length, 1);
});

test('bootstrap rejects a historical batch and creates no state', async t => {
  const directory = await workspace(t), { client } = mockApi({ batches: [batch([event(1)])] });
  await assert.rejects(step(options(directory, client)), /Bootstrap/); assert.equal(await saved(directory), null);
});

test('scope binding refuses changed config, room, or token before any API call', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  for (const change of [{ token: 'other-token' }, { room: 'ABCDEF654321' }, { config: { ...CONFIG, ledgerId: 'new-ledger' } }]) {
    const { client, calls } = mockApi();
    await assert.rejects(step(options(directory, client, change)), /different configuration/); assert.equal(calls.length, 0);
  }
});

test('changed room identity or departed borrower prevents polling', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  for (const rooms of [[{ ...ROOMS[0], id: id(999) }], [{ ...ROOMS[0], members: ROOMS[0].members.slice(0, 2) }], [{ ...ROOMS[0], is_public: true }]]) {
    const { client, calls } = mockApi({ rooms });
    await assert.rejects(step(options(directory, client))); assert.equal(calls.length, 1);
  }
  assert.equal((await saved(directory)).cursor, id(0));
});

test('selected action identity, label, or required input drift prevents polling', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  for (const patch of [{ id: id(999) }, { label: 'Borrow something else' }, { input_type: 'text' }, { requires_ack: true }]) {
    const { client, calls } = mockApi({ actions: ACTIONS.map((a, i) => i ? a : { ...a, ...patch }) });
    await assert.rejects(step(options(directory, client))); assert.equal(calls.length, 2);
  }
  assert.equal((await saved(directory)).cursor, id(0));
});

test('post-poll action change discards the entire otherwise valid batch', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  const { client } = mockApi({ batches: [batch([event(1)])], actions: read => read ? ACTIONS.map((a, i) => i ? a : { ...a, id: id(999) }) : ACTIONS });
  await assert.rejects(step(options(directory, client)), /changed while waiting/);
  assert.equal((await saved(directory)).events.length, 0);
});

test('feed failure and cancellation preserve the checkpoint', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'state.json', base());
  const bad = mockApi({ handler: url => url.pathname.endsWith('/wait') ? Response.json({ message: 'private raw detail' }, { status: 503 }) : undefined });
  await assert.rejects(step(options(directory, bad.client)));
  const controller = new AbortController();
  const cancelled = mockApi({ batches: [batch([event(1)])], handler: url => { if (url.pathname.endsWith('/wait')) controller.abort(new Error('stop')); } });
  await assert.rejects(step(options(directory, cancelled.client, { signal: controller.signal })), /stop/);
  assert.equal((await saved(directory)).cursor, id(0));
});

test('capacity rejects whole batch rather than silently pruning custody evidence', () => {
  const state = base();
  let current = state;
  for (let i = 0; i < MAX_EVENTS; i += 50) current = ingest(current, batch(Array.from({ length: 50 }, (_, n) => event(i + n + 1))), AT);
  assert.equal(current.events.length, MAX_EVENTS);
  assert.throws(() => ingest(current, batch([event(MAX_EVENTS + 1, 2)]), AT), /Invalid checkout state/);
  assert.equal(current.holders.camera, B);
});

test('corrupted holder/outcome/config/action evidence is rejected locally', () => {
  const state = ingest(base(), batch([event(1)]), AT);
  const mutations = [s => { s.holders.camera = C; }, s => { s.events[0].outcome = 'returned'; }, s => { s.events[0].holderBefore = C; },
    s => { s.configHash = hash('wrong'); }, s => { s.actions[0].slot = 4; }, s => { s.roomId = 'invalid'; }];
  for (const mutate of mutations) { const copy = structuredClone(state); mutate(copy); assert.throws(() => stateValue(copy)); }
});

test('future request timestamps and a backwards local clock reject without changes', () => {
  assert.throws(() => ingest(base(), batch([event(1, 1, B, { created_at: '2026-10-25T05:02:00Z' })]), AT), /ahead/);
  assert.throws(() => ingest(base(), batch([], id(0)), '2026-10-25T04:00:00Z'), /backwards/);
});

test('config bounds and duplicate slots/identities reject before use', () => {
  for (const change of [{ initiallyAvailable: false }, { assets: [] }, { borrowers: [] }, { borrowers: [CONFIG.borrowers[0], CONFIG.borrowers[0]] },
    { assets: [{ ...CONFIG.assets[0], returnAction: 1 }] }, { assets: [{ ...CONFIG.assets[0], name: 'Camera\nRUN' }] }]) assert.throws(() => configValue({ ...CONFIG, ...change }));
  const reversed = { ...CONFIG, borrowers: [...CONFIG.borrowers].reverse(), assets: [...CONFIG.assets].reverse() };
  assert.deepEqual(configValue(reversed), configValue(CONFIG));
});

test('offline report uses saved evidence and exports no message, raw data, or token', async t => {
  const directory = await workspace(t), state = ingest(base(), batch([event(1)]), AT);
  await atomicJson(directory, 'state.json', state);
  const value = await localReport(directory, { save: true });
  assert.deepEqual(value, report(state)); assert.equal(value.sendsConfirmation, false);
  assert.equal(value.completeFeedHistory, false); assert.equal(value.confirmsPhysicalPossession, false);
  assert.deepEqual(await readJson(join(directory, 'report.json')), value);
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
});

test('null, malformed JSON, invalid UTF-8, and symlink state cannot reset a ledger', async t => {
  const directory = await workspace(t);
  for (const content of ['null', '{', Buffer.from([0xff])]) {
    await writeFile(join(directory, 'state.json'), content);
    const { client, calls } = mockApi(); await assert.rejects(step(options(directory, client))); assert.equal(calls.length, 0);
  }
  await rm(join(directory, 'state.json')); await writeFile(join(directory, 'other.json'), '{}');
  await symlink(join(directory, 'other.json'), join(directory, 'state.json'));
  const { client, calls } = mockApi(); await assert.rejects(step(options(directory, client))); assert.equal(calls.length, 0);
});

test('single-process lock fails closed and releases only its own lock', async t => {
  const directory = await workspace(t), release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /lock exists/);
  await release(); const second = await acquireLock(directory); await second();
});

test('explicit environment presence requires a complete pair and cannot borrow saved values', async t => {
  const directory = await workspace(t); await atomicJson(directory, 'credentials.json', { token: TOKEN, room: ROOM });
  assert.deepEqual(await loadConnection(directory, {}), { token: TOKEN, room: ROOM });
  for (const env of [{ PINGROOM_TOKEN: '' }, { PINGROOM_ROOM: ROOM }, { PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: '' }]) {
    await assert.rejects(loadConnection(directory, env), /complete/); await assert.rejects(loadEnvironment(env, join(directory, '.env')), /complete/);
  }
  assert.equal(validateConnection({ token: TOKEN, room: ROOM.toLowerCase() }).room, ROOM);
  await writeFile(join(directory, '.env'), `PINGROOM_TOKEN=${TOKEN}\nPINGROOM_ROOM=${ROOM}\n`);
  const env = {}; await loadEnvironment(env, join(directory, '.env')); assert.equal(env.PINGROOM_TOKEN, TOKEN);
});
