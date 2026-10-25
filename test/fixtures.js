import { makeClient } from '../src/client.js';

export const ROOM = 'ABCDEF123456';
export const TOKEN = 'offline-observer-token';
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const ROOM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const id = number => `019a0300-0000-7000-8000-${String(number).padStart(12, '0')}`;
export const AT = '2026-10-25T05:00:00.000Z';
export const CONFIG = { ledgerId: 'shared-kit', initiallyAvailable: true, borrowers: [{ id: B, label: 'Alex' }, { id: C, label: 'Sam' }],
  assets: [{ id: 'camera', name: 'Camera', borrowAction: 1, returnAction: 2 }, { id: 'tripod', name: 'Tripod', borrowAction: 3, returnAction: 4 }] };
export const ROOMS = [{ id: ROOM_ID, invite_code: ROOM, name: 'Equipment', type: 'standard', is_public: false,
  members: [A, B, C].map((user_id, i) => ({ user_id, role: i ? 'member' : 'owner', user: { name: ['Observer', 'Alex', 'Sam'][i] } })) }];
export const ACTIONS = ['Borrow Camera', 'Return Camera', 'Borrow Tripod', 'Return Tripod'].map((label, index) => ({ id: id(900 + index), action_number: index + 1, label, icon: '📦', input_type: 'none', requires_ack: false }));
export const event = (number, action = 1, sender = B, extra = {}) => ({ id: id(number), created_at: AT, action_number: action, trigger_source: 'manual',
  room: { code: ROOM }, sender: { id: sender, name: 'not an authority' }, origin_agent: null, question: null, is_handoff: false,
  message: 'not executed or persisted', data: { command: 'not interpreted' }, ...extra });
export const batch = (events, cursor = events.at(-1)?.id) => ({ notifications: events, cursor });

export function mockApi({ batches = [], rooms = ROOMS, actions = ACTIONS, handler, signal } = {}) {
  const calls = [];
  let actionRead = 0;
  const client = makeClient({ token: TOKEN, signal, fetchImpl: async (url, init) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: init.method });
    if (handler) { const custom = await handler(parsed, init, calls); if (custom !== undefined) return custom; }
    if (init.method !== 'GET') throw new Error('Offline fixture forbids writes.');
    if (parsed.pathname === '/api/agent/rooms') return Response.json(rooms);
    if (parsed.pathname === `/api/agent/rooms/${ROOM}/actions`) return Response.json(typeof actions === 'function' ? actions(actionRead++) : actions);
    if (parsed.pathname === '/api/agent/notifications/wait') {
      if (!batches.length) throw new Error('No queued mock feed response.');
      return Response.json(batches.shift());
    }
    throw new Error('Unexpected mock request.');
  } });
  return { client, calls };
}
