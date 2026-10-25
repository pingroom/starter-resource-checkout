import { loadEnvironment, loadConnection, loadConfig, checkoutDirectory } from './config.js';
import { makeClient } from './client.js';
import { connect } from './connect.js';
import { step, localReport } from './checkout.js';
import { roomValue } from './model.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Stopped.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let timer;
try {
  const [command, ...extra] = process.argv.slice(2);
  if (!['run', 'connect', 'inspect', 'status', 'report'].includes(command) || extra.length) throw new Error('Unexpected command or arguments.');
  timer = setTimeout(() => controller.abort(new Error('Operation deadline exceeded.')), command === 'connect' ? 600000 : 50000);
  if (['status', 'report'].includes(command)) console.log(JSON.stringify(await localReport(checkoutDirectory, { save: command === 'report' }), null, 2));
  else {
    await loadEnvironment();
    if (command === 'connect') await connect(controller.signal);
    else {
      const connection = await loadConnection();
      const client = makeClient({ token: connection.token, signal: controller.signal });
      if (command === 'inspect') {
        const room = roomValue(await client.rooms.list(), connection.room);
        console.log(JSON.stringify({ room: connection.room, people: room.members.map(member => ({ id: member.user_id,
          name: typeof member.user?.name === 'string' ? member.user.name.slice(0, 80) : null })) }, null, 2));
        console.log('Use exact member UUIDs for borrowers B/C, different from connected observer A. Verify people in the app; names alone do not establish identity.');
      } else {
        console.log(JSON.stringify(await step({ client, ...connection, config: await loadConfig(), directory: checkoutDirectory, signal: controller.signal }), null, 2));
      }
    }
  }
} catch (error) {
  if (controller.signal.aborted) console.error('Stopped or deadline reached. Keep saved state; status shows the last committed ledger.');
  else {
    const safeLocal = error instanceof Error && !('code' in error) && error.name === 'Error';
    console.error(safeLocal ? error.message : 'Operation failed. Check configuration, room/scopes, network, and private state. Raw API errors are suppressed.');
  }
  process.exitCode = 1;
} finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
