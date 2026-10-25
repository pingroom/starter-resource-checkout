import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../src/client.js';
import { ROOM, TOKEN, id } from './fixtures.js';

test('transport refuses message writes and side-effecting room detail reads', async () => {
  let calls = 0;
  const client = makeClient({ token: TOKEN, fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(client.rooms.get(ROOM));
  await assert.rejects(client.actions.trigger(ROOM, 1));
  assert.equal(calls, 0);
});

test('full body deadline interrupts headers-complete stalled responses', async () => {
  const client = makeClient({ token: TOKEN, deadlineMs: 15, fetchImpl: async () => new Response(new ReadableStream({ pull() {} })) });
  const at = performance.now(); await assert.rejects(client.rooms.list()); assert.ok(performance.now() - at < 1000);
});

test('monotonic deadline also interrupts endless zero-length body chunks', async () => {
  const client = makeClient({ token: TOKEN, deadlineMs: 15, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); } })) });
  const at = performance.now(); await assert.rejects(client.rooms.list()); assert.ok(performance.now() - at < 1000);
});

test('body size and invalid UTF-8 reject before SDK JSON use', async () => {
  for (const bytes of [new Uint8Array(512 * 1024 + 1), Uint8Array.of(0xff)]) {
    const client = makeClient({ token: TOKEN, fetchImpl: async () => new Response(bytes) });
    await assert.rejects(client.rooms.list());
  }
});

test('redirects are manual and rejected', async () => {
  let options;
  const client = makeClient({ token: TOKEN, fetchImpl: async (_url, init) => { options = init; return new Response(null, { status: 302, headers: { location: 'https://example.com' } }); } });
  await assert.rejects(client.rooms.list()); assert.equal(options.redirect, 'manual');
});

test('caller cancellation interrupts a fetch that ignores abort signals', async () => {
  const controller = new AbortController();
  const client = makeClient({ token: TOKEN, signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  const pending = client.notifications.wait({ after: id(0), timeout: 20, limit: 50 });
  setTimeout(() => controller.abort(new Error('cancel')), 10);
  await assert.rejects(pending);
});

test('SDK wait uses public path/query and forwards authorization only to approved API', async () => {
  let seen;
  const client = makeClient({ token: TOKEN, fetchImpl: async (url, init) => { seen = { url: new URL(url), init }; return Response.json({ notifications: [], cursor: id(5) }); } });
  assert.deepEqual(await client.notifications.wait({ after: id(5), timeout: 20, limit: 50 }), { notifications: [], cursor: id(5) });
  assert.equal(seen.url.origin, 'https://api.pingroom.io'); assert.equal(seen.url.pathname, '/api/agent/notifications/wait');
  assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(seen.url.searchParams.get('after'), id(5));
});
