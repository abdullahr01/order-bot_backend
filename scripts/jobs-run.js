// Runs the daily jobs once, by hand: `npm run jobs:run -- --dry` lists what would happen
// and changes nothing; without --dry it does the work (safe to repeat: the notebook
// stops anything being done twice). --any-hour skips the 9 am local-time rule.
import { Database } from '../db/database.js';
import { createServices } from '../service/index.js';
import { RUN_HOUR } from '../service/job.service.js';
import logger from '../shared/logger.js';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !['--dry', '--any-hour'].includes(arg));
if (unknown.length) {
  console.error('Usage: npm run jobs:run -- [--dry] [--any-hour]');
  process.exit(1);
}
const dryRun = args.has('--dry');

const database = new Database();
try {
  const services = createServices({ database });
  const report = await services.jobs.runDaily({ dryRun, fromHour: args.has('--any-hour') ? 0 : RUN_HOUR, log: logger });
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  console.log(`\n${dryRun ? 'DRY RUN: nothing was changed.' : 'Done.'}`);
  console.log(`  1st of the month: ${count(report.billingMonth)} restaurant(s) checked${report.billingMonth?.failed ? ' (FAILED)' : ''}`);
  for (const item of report.billingMonth ?? []) console.log(`    ${item.tenantId}  ${item.month}  due ${item.due}  ${item.action}`);
  console.log(`  Unpaid ladder: ${count(report.unpaid)} restaurant(s)${report.unpaid?.failed ? ' (FAILED)' : ''}`);
  for (const item of report.unpaid ?? []) console.log(`    ${item.tenantId}  day ${item.days}  step ${item.step}  ${item.action}`);
  console.log(`  Billing periods: ${count(report.billingPeriods)} moved${report.billingPeriods?.failed ? ' (FAILED)' : ''}`);
  for (const item of report.billingPeriods ?? []) console.log(`    ${item.tenantId}  next end ${item.periodEnd}${item.planChanged ? `  plan now ${item.planChanged}` : ''}`);
  const clean = report.cleanUp ?? {};
  console.log(clean.failed ? '  Clean-up: FAILED' : `  Clean-up: ${clean.pairing_codes} pairing code(s), ${clean.diner_order_refs} diner order ref(s), ${clean.idempotency_keys} saved counter request(s), ${clean.photos?.unused ?? 0} unused photo(s) of ${clean.photos?.checked ?? 0} older than a day`);
} catch (error) {
  logger.error({ module: 'Jobs', operation: 'manualRun', err: error }, 'Manual jobs run failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
