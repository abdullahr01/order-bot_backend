// Checks the live line through the hosting's proxy:
//   npm run check:live -- https://your-api.up.railway.app
// With no token it sends a made-up table code and expects the server's "table not found"
// close (4401), which proves the line reaches the API. With CHECK_TABLE_TOKEN set (never
// printed) it signs in as that table's diner page and waits for the first ping.
import { WebSocket } from 'ws';

const [base] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: npm run check:live -- https://your-api-address');
  process.exit(1);
}
const url = `${base.replace(/\/$/, '').replace(/^http/, 'ws')}/live`;
const token = process.env.CHECK_TABLE_TOKEN;
const started = performance.now();
const ws = new WebSocket(url);
const timer = setTimeout(() => { console.log('No answer within 30 seconds.'); ws.terminate(); process.exitCode = 1; }, 30_000);

ws.on('open', () => {
  console.log(`Line opened in ${(performance.now() - started).toFixed(0)} ms`);
  ws.send(JSON.stringify({ type: 'hello', app: 'diner', tableToken: token || 'made-up-table-code' }));
});
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'ready') console.log(`Signed in; ${message.pingSeconds}-second pings; waiting for one...`);
  if (message.type === 'ping') {
    console.log('Ping received: the live line works.');
    clearTimeout(timer);
    ws.close(1000);
  }
});
ws.on('close', (code, reason) => {
  clearTimeout(timer);
  if (!token && code === 4401) console.log('The server answered "table not found" as expected: the live line works.');
  else if (code !== 1000) { console.log(`Closed: ${code} ${reason.toString()}`); process.exitCode = 1; }
});
ws.on('unexpected-response', (_request, response) => {
  console.log(`Refused with HTTP ${response.statusCode}. Check the address (and CORS_ORIGINS if a browser).`);
  process.exitCode = 1;
});
ws.on('error', (error) => { if (!process.exitCode) console.log(`Could not connect: ${error.code ?? 'error'}`); process.exitCode = 1; });
