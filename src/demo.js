import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from './checkout.js';
import { CONFIG, ROOM, TOKEN, AT, B, C, id, event, batch, mockApi } from '../test/fixtures.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-checkout-demo-'));
try {
  const { client, calls } = mockApi({ batches: [batch([], id(0)), batch([
    event(1, 1, B), event(2, 1, C), event(3, 2, C), event(4, 2, B), event(5, 1, C), event(6, 3, B)
  ])] });
  const options = { client, token: TOKEN, room: ROOM, config: CONFIG, directory, now: () => AT };
  await step(options);
  await step(options);
  const value = await localReport(directory, { save: true });
  console.log('Offline demo with a synthetic 2026-10-25 clock; the real SDK uses only a local mock transport.');
  console.log(JSON.stringify({ assets: value.assets, outcomes: value.outcomes, requests: value.requests.map(e => ({ operation: e.operation, assetId: e.assetId, outcome: e.outcome })), mockRequests: calls.length }, null, 2));
  console.log('The first conflicting borrow and wrong-person return were declined locally. No PingRoom calls or confirmations were sent.');
} finally { await rm(directory, { recursive: true, force: true }); }
