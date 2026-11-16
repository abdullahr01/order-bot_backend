// Times the reads the apps repeat most, against a running API:
//   npm run check:speed -- https://your-api.up.railway.app
// Optional, read from the environment and never printed:
//   CHECK_TABLE_TOKEN   a table's QR token: times the diner page
//   CHECK_DEVICE_TOKEN  and CHECK_STAFF_TOKEN (an unlocked counter): times the floor, orders and requests
// Reports the 50th and 95th percentile of the whole trip and of the server's own time
// (its Server-Timing header). The target is the server's p95 under 150 ms.
const [base] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: npm run check:speed -- https://your-api-address');
  process.exit(1);
}
const api = base.replace(/\/$/, '');
const ROUNDS = 30;
const WARM_UP = 3;

const targets = [{ name: 'Health (no database)', path: '/health', headers: {} }];
if (process.env.CHECK_TABLE_TOKEN) {
  targets.push({ name: 'Diner page', path: `/public/tables/${encodeURIComponent(process.env.CHECK_TABLE_TOKEN)}`, headers: {} });
}
if (process.env.CHECK_DEVICE_TOKEN && process.env.CHECK_STAFF_TOKEN) {
  const headers = { 'x-counter-device': process.env.CHECK_DEVICE_TOKEN, authorization: `Bearer ${process.env.CHECK_STAFF_TOKEN}` };
  targets.push(
    { name: 'Counter: floor', path: '/portal/dine-in/floor', headers },
    { name: 'Counter: orders', path: '/portal/orders', headers },
    { name: 'Counter: requests', path: '/portal/dine-in/requests', headers },
  );
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

let slow = false;
for (const target of targets) {
  const trips = [];
  const server = [];
  let failed = null;
  for (let round = 0; round < WARM_UP + ROUNDS; round += 1) {
    const started = performance.now();
    const response = await fetch(`${api}${target.path}`, { headers: target.headers });
    await response.arrayBuffer();
    const trip = performance.now() - started;
    if (!response.ok) { failed = response.status; break; }
    if (round < WARM_UP) continue;
    trips.push(trip);
    const timing = /app;dur=([\d.]+)/.exec(response.headers.get('server-timing') ?? '');
    if (timing) server.push(Number(timing[1]));
  }
  if (failed) {
    console.log(`${target.name}: answered ${failed}; check the address and tokens.`);
    continue;
  }
  const serverP95 = server.length ? percentile(server, 95) : null;
  if (serverP95 !== null && target.path !== '/health' && serverP95 > 150) slow = true;
  console.log(`${target.name}: whole trip p50 ${percentile(trips, 50).toFixed(0)} ms, p95 ${percentile(trips, 95).toFixed(0)} ms` +
    (serverP95 === null ? '' : `; server p50 ${percentile(server, 50).toFixed(0)} ms, p95 ${serverP95.toFixed(0)} ms`));
}
if (targets.length === 1) console.log('Set CHECK_TABLE_TOKEN and/or CHECK_DEVICE_TOKEN + CHECK_STAFF_TOKEN to time the busy reads.');
console.log(slow ? 'Some reads are over the 150 ms target (server p95).' : 'Server times are within the 150 ms target.');
