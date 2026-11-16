import test from 'node:test';
import assert from 'node:assert/strict';
import { JobScheduler, nextWake } from '../service/job-scheduler.js';
import { LADDER_STEPS, unpaidEmail } from '../service/job.service.js';
import { captureLogger } from './helpers.js';

test('the scheduler wakes at the next 9 am in Pakistan or the UK, whichever comes first', () => {
  // 03:00 UTC = 08:00 Karachi: next is 09:00 Karachi (04:00 UTC).
  assert.equal(nextWake(new Date('2026-11-14T03:00:00Z')).toISOString(), '2026-11-14T04:00:05.000Z');
  // 05:00 UTC: Karachi's 9 am has passed; London's is 09:00 UTC (no summer time in November).
  assert.equal(nextWake(new Date('2026-11-14T05:00:00Z')).toISOString(), '2026-11-14T09:00:05.000Z');
  // After London's 9 am: tomorrow's in Karachi.
  assert.equal(nextWake(new Date('2026-11-14T10:00:00Z')).toISOString(), '2026-11-15T04:00:05.000Z');
  // British summer time: 9 am London is 08:00 UTC.
  assert.equal(nextWake(new Date('2026-07-01T05:00:00Z')).toISOString(), '2026-07-01T08:00:05.000Z');
});

test('the scheduler runs once on start, never two runs at once, and stops cleanly', async () => {
  const capture = captureLogger();
  let running = 0;
  let most = 0;
  let runs = 0;
  const jobs = {
    async runDaily({ log }) {
      assert.ok(log);
      running += 1;
      most = Math.max(most, running);
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    },
  };
  const scheduler = new JobScheduler({ jobs, logger: capture.logger, clock: () => new Date('2026-11-14T03:00:00Z') });
  scheduler.start();
  await scheduler.stop();
  assert.equal(runs, 1);
  assert.equal(most, 1);
  assert.match(capture.text(), /Next daily run scheduled/);
});

test('a failing run is logged and does not stop the scheduler', async () => {
  const capture = captureLogger();
  const scheduler = new JobScheduler({ jobs: { runDaily: async () => { throw new Error('private-sentinel'); } }, logger: capture.logger });
  scheduler.start();
  await scheduler.stop();
  assert.match(capture.text(), /Daily run failed/);
  assert.doesNotMatch(capture.text(), /private-sentinel/);
});

test('the unpaid emails: one per step, plain text, the restaurant named, no amounts', () => {
  assert.deepEqual(LADDER_STEPS, [7, 30, 43, 45]);
  for (const step of LADDER_STEPS) {
    const email = unpaidEmail(step, { businessName: 'Karachi Grill', ownerName: 'Ali' });
    assert.match(email.subject, /Karachi Grill/);
    assert.match(email.text, /^Hello Ali,/);
    assert.match(email.text, new RegExp(`${step} days overdue`));
    assert.doesNotMatch(email.text, /Rs|£|PKR|GBP/);
  }
  assert.match(unpaidEmail(30, { businessName: 'X', ownerName: 'Y' }).text, /can't change your menu, tables or team/);
  assert.match(unpaidEmail(43, { businessName: 'X', ownerName: 'Y' }).text, /within 2 days/);
  assert.match(unpaidEmail(45, { businessName: 'X', ownerName: 'Y' }).text, /has been suspended/);
});
