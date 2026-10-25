import { createHash } from 'node:crypto';

export const ROOM = /^[A-Z0-9]{12}$/;
export const MAX_EVENTS = 500;
export const MAX_BYTES = 512 * 1024;
export const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;

export function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(value).toISOString();
}

export function configValue(raw) {
  if (!exact(raw, ['ledgerId', 'initiallyAvailable', 'borrowers', 'assets']) || !slug(raw.ledgerId) || raw.initiallyAvailable !== true
    || !Array.isArray(raw.borrowers) || raw.borrowers.length < 1 || raw.borrowers.length > 8
    || raw.borrowers.some(b => !exact(b, ['id', 'label']) || !isId(b.id) || !text(b.label, 40))
    || new Set(raw.borrowers.map(b => b.id)).size !== raw.borrowers.length
    || !Array.isArray(raw.assets) || raw.assets.length < 1 || raw.assets.length > 2
    || raw.assets.some(a => !exact(a, ['id', 'name', 'borrowAction', 'returnAction']) || !slug(a.id) || !text(a.name, 20)
      || [a.borrowAction, a.returnAction].some(n => !Number.isInteger(n) || n < 1 || n > 4))
    || new Set(raw.assets.map(a => a.id)).size !== raw.assets.length || new Set(raw.assets.map(a => a.name)).size !== raw.assets.length
    || new Set(raw.assets.flatMap(a => [a.borrowAction, a.returnAction])).size !== raw.assets.length * 2) throw new Error('Configure 1–2 initially available assets, unique slots 1–4, and 1–8 exact borrower UUIDs.');
  return { ledgerId: raw.ledgerId, initiallyAvailable: true,
    borrowers: raw.borrowers.map(b => ({ id: b.id, label: b.label })).sort((a, b) => a.id.localeCompare(b.id)),
    assets: raw.assets.map(a => ({ id: a.id, name: a.name, borrowAction: a.borrowAction, returnAction: a.returnAction })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function roomValue(rooms, code, config) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter(r => r?.invite_code === code), room = matches[0];
  if (matches.length !== 1 || !isId(room.id) || room.type !== 'standard' || room.is_public !== false || !Array.isArray(room.members)
    || room.members.length < 2 || room.members.length > 1000 || room.members.some(m => !isId(m?.user_id))) throw new Error('Use a granted standard private room shared by the observer and borrowers.');
  const ids = room.members.map(m => m.user_id);
  if (new Set(ids).size !== ids.length || config?.borrowers.some(b => !ids.includes(b.id))) throw new Error('Every configured borrower must remain a member of the room.');
  return { id: room.id, members: room.members };
}

function desiredBindings(config) {
  return config.assets.flatMap(a => ['borrow', 'return'].map(operation => ({ assetId: a.id, operation, slot: a[`${operation}Action`], label: `${operation === 'borrow' ? 'Borrow' : 'Return'} ${a.name}` })));
}
export function actionBinding(actions, config) {
  if (!Array.isArray(actions) || actions.length > 16) throw new Error('Invalid action inventory.');
  const bindings = desiredBindings(config).map(desired => {
    const matches = actions.filter(a => a?.action_number === desired.slot), action = matches[0];
    if (matches.length !== 1 || !isId(action.id) || action.label !== desired.label || ![null, undefined, 'none'].includes(action.input_type)
      || ![false, undefined].includes(action.requires_ack)) throw new Error('Configure the exact Borrow/Return labels as plain actions without input or acknowledgement.');
    return { ...desired, id: action.id };
  });
  if (new Set(bindings.map(a => a.id)).size !== bindings.length) throw new Error('Repeated action identity.');
  return bindings;
}

export function batchValue(batch, after) {
  if (!record(batch) || !isId(batch.cursor) || !Array.isArray(batch.notifications) || batch.notifications.length > 50) throw new Error('Invalid notification batch.');
  if (after === undefined) {
    if (batch.notifications.length) throw new Error('Bootstrap must skip prior notification history.');
  } else {
    let last = after;
    for (const event of batch.notifications) {
      if (!record(event) || !isId(event.id) || event.id <= last) throw new Error('Repeated, old, or unordered notification ID; no batch was committed.');
      last = event.id;
    }
    if (batch.cursor !== last) throw new Error('Notification cursor does not match its batch.');
  }
  return batch;
}

export function transition(holder, operation, borrowerId) {
  if (operation === 'borrow') {
    if (holder === null) return { outcome: 'borrowed', holder: borrowerId };
    return { outcome: holder === borrowerId ? 'already_held_by_you' : 'unavailable', holder };
  }
  if (holder === null) return { outcome: 'already_available', holder };
  if (holder !== borrowerId) return { outcome: 'not_holder', holder };
  return { outcome: 'returned', holder: null };
}
const emptyHolders = config => Object.fromEntries(config.assets.map(a => [a.id, null]));

export function stateValue(state) {
  if (!exact(state, ['version', 'config', 'configHash', 'room', 'roomId', 'credentialHash', 'actions', 'initialCursor', 'cursor', 'startedAt', 'checkedAt', 'events', 'holders'])
    || state.version !== 1 || typeof state.room !== 'string' || !ROOM.test(state.room) || !isId(state.roomId)
    || typeof state.credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.credentialHash) || !isId(state.initialCursor) || !isId(state.cursor) || state.cursor < state.initialCursor
    || !Array.isArray(state.events) || state.events.length > MAX_EVENTS || stamp(state.startedAt) !== state.startedAt || stamp(state.checkedAt) !== state.checkedAt
    || state.checkedAt < state.startedAt) throw new Error('Invalid checkout state; restore a valid backup.');
  const config = configValue(state.config);
  if (hash(config) !== hash(state.config) || state.configHash !== hash(config)) throw new Error('Saved configuration is not canonical or its hash differs.');
  const desired = desiredBindings(config);
  if (!Array.isArray(state.actions) || state.actions.length !== desired.length) throw new Error('Invalid saved action binding.');
  for (const [i, action] of state.actions.entries()) {
    if (!exact(action, ['assetId', 'operation', 'slot', 'label', 'id']) || !isId(action.id)
      || hash({ assetId: action.assetId, operation: action.operation, slot: action.slot, label: action.label }) !== hash(desired[i])) throw new Error('Invalid saved action binding.');
  }
  if (new Set(state.actions.map(a => a.id)).size !== desired.length) throw new Error('Repeated saved action identity.');
  const holders = emptyHolders(config);
  let last = state.initialCursor;
  for (const event of state.events) {
    if (!exact(event, ['id', 'assetId', 'operation', 'borrowerId', 'createdAt', 'outcome', 'holderBefore', 'holderAfter'])
      || !isId(event.id) || event.id <= last || event.id > state.cursor || !Object.hasOwn(holders, event.assetId)
      || !['borrow', 'return'].includes(event.operation) || !config.borrowers.some(b => b.id === event.borrowerId)
      || stamp(event.createdAt) !== event.createdAt || Date.parse(event.createdAt) > Date.parse(state.checkedAt) + 60000) throw new Error('Invalid saved request evidence.');
    const result = transition(holders[event.assetId], event.operation, event.borrowerId);
    if (event.holderBefore !== holders[event.assetId] || event.holderAfter !== result.holder || event.outcome !== result.outcome) throw new Error('Saved outcome contradicts the request ledger.');
    holders[event.assetId] = result.holder;
    last = event.id;
  }
  if (!record(state.holders) || hash(state.holders) !== hash(holders)) throw new Error('Saved holders contradict the request ledger.');
  if (Buffer.byteLength(JSON.stringify(state, null, 2)) + 1 > MAX_BYTES) throw new Error('Checkout state exceeds its storage limit.');
  return state;
}

export function newState({ config, room, roomId, token, actions, cursor, at }) {
  config = configValue(config);
  return stateValue({ version: 1, config, configHash: hash(config), room, roomId, credentialHash: hash(token), actions,
    initialCursor: cursor, cursor, startedAt: stamp(at), checkedAt: stamp(at), events: [], holders: emptyHolders(config) });
}

export function ingest(state, rawBatch, observedAt) {
  stateValue(state);
  const batch = batchValue(rawBatch, state.cursor), checkedAt = stamp(observedAt);
  if (checkedAt < state.checkedAt) throw new Error('Local clock moved backwards.');
  const next = structuredClone(state);
  for (const raw of batch.notifications) {
    const binding = state.actions.find(a => a.slot === raw.action_number);
    if (!binding || raw.room?.code !== state.room || !state.config.borrowers.some(b => b.id === raw.sender?.id)
      || raw.trigger_source !== 'manual' || raw.origin_agent !== null || raw.question !== null || raw.is_handoff !== false) continue;
    const createdAt = stamp(raw.created_at);
    if (Date.parse(createdAt) > Date.parse(checkedAt) + 60000) throw new Error('Request timestamp is ahead of the local clock.');
    const holderBefore = next.holders[binding.assetId];
    const result = transition(holderBefore, binding.operation, raw.sender.id);
    next.events.push({ id: raw.id, assetId: binding.assetId, operation: binding.operation, borrowerId: raw.sender.id, createdAt,
      outcome: result.outcome, holderBefore, holderAfter: result.holder });
    next.holders[binding.assetId] = result.holder;
  }
  next.cursor = batch.cursor; next.checkedAt = checkedAt;
  return stateValue(next);
}

export function report(state) {
  stateValue(state);
  const counts = {};
  for (const event of state.events) counts[event.outcome] = (counts[event.outcome] ?? 0) + 1;
  return { ledgerId: state.config.ledgerId, room: state.room, startedAt: state.startedAt, lastCheckedAt: state.checkedAt,
    observedCursor: state.cursor, requestCount: state.events.length, requestCapacity: MAX_EVENTS, outcomes: counts,
    assets: state.config.assets.map(a => ({ id: a.id, name: a.name, holder: state.config.borrowers.find(b => b.id === state.holders[a.id]) ?? null })),
    requests: state.events, completeFeedHistory: false, confirmsPhysicalPossession: false, sendsConfirmation: false };
}
