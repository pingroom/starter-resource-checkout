import { join } from 'node:path';
import { acquireLock, atomicJson, readJson } from './storage.js';
import { validateConnection } from './config.js';
import { configValue, roomValue, actionBinding, batchValue, stateValue, newState, ingest, report, hash, MAX_BYTES } from './model.js';

function scope(state, config, connection) {
  if (state.configHash !== hash(config) || state.room !== connection.room || state.credentialHash !== hash(connection.token)) throw new Error('Saved ledger belongs to a different configuration, room, or credential. Restore the original inputs.');
}

/** Read one feed batch, validate it completely, and atomically commit its requests and cursor. */
export async function step({ client, token, room, config, directory, signal, now = () => new Date().toISOString(), save = atomicJson }) {
  config = configValue(config);
  const connection = validateConnection({ token, room });
  const release = await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    const saved = await readJson(join(directory, 'state.json'), MAX_BYTES);
    const state = saved === null ? null : stateValue(saved);
    if (state) scope(state, config, connection);
    const metadata = roomValue(await client.rooms.list(), connection.room, config);
    if (state && state.roomId !== metadata.id) throw new Error('Room identity changed. Restore the original room.');
    const actions = actionBinding(await client.actions.list(connection.room), config);
    if (state && hash(actions) !== hash(state.actions)) throw new Error('Selected action identity or behavior changed. Restore the original actions before continuing.');
    signal?.throwIfAborted();
    const batch = batchValue(await client.notifications.wait({ ...(state ? { after: state.cursor } : {}), timeout: state ? 20 : 0, limit: 50, signal }), state?.cursor);
    // No compare-and-swap API exists: this catches observed changes, not a historical proof.
    if (hash(actionBinding(await client.actions.list(connection.room), config)) !== hash(actions)) throw new Error('Actions changed while waiting. No requests or cursor were committed.');
    const next = state ? ingest(state, batch, now()) : newState({ config, ...connection, roomId: metadata.id, actions, cursor: batch.cursor, at: now() });
    signal?.throwIfAborted();
    await save(directory, 'state.json', next, MAX_BYTES);
    return { bootstrapped: state === null, ...report(next) };
  } finally { await release(); }
}

export async function localReport(directory, { save = false } = {}) {
  const release = await acquireLock(directory);
  try {
    const state = await readJson(join(directory, 'state.json'), MAX_BYTES);
    if (state === null) throw new Error('No ledger yet. Complete setup and run npm start to establish the feed head.');
    const value = report(state);
    if (save) await atomicJson(directory, 'report.json', value, MAX_BYTES);
    return value;
  } finally { await release(); }
}
