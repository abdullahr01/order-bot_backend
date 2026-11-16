import { COUNTRIES, REGIONS } from '../shared/rules/region.js';
import { localDay, zonedToUtc } from '../shared/time.js';
import { RUN_HOUR } from './job.service.js';

// Node can't wait longer than about 24.8 days in one timer; ours never waits a day.
const MAX_WAIT_MS = 2 ** 31 - 1;
const AFTER_THE_HOUR_MS = 5_000;

/** The next 9 am (plus a few seconds) in any of the countries' time zones. */
export function nextWake(now, { zones = COUNTRIES.map((country) => REGIONS[country].timezone), hour = RUN_HOUR } = {}) {
  let best = null;
  for (const zone of zones) {
    for (const offset of [0, 1]) {
      const at = new Date(zonedToUtc(localDay(now, zone, offset), hour * 60, zone).getTime() + AFTER_THE_HOUR_MS);
      if (at > now) {
        if (!best || at < best) best = at;
        break;
      }
    }
  }
  return best;
}

/**
 * Wakes the server once a day at 9 am Pakistan time and 9 am UK time (agreed
 * 2026-11-14), and once when it starts, to catch up after a restart. The dates live in
 * the database, so nothing is lost when the server restarts. Runs never overlap.
 */
export class JobScheduler {
  #jobs;
  #logger;
  #clock;
  #timer = null;
  #running = Promise.resolve();
  #stopped = false;

  constructor({ jobs, logger, clock = () => new Date() }) {
    this.#jobs = jobs;
    this.#logger = logger.child({ module: 'JobScheduler' });
    this.#clock = clock;
  }

  start() {
    this.#logger.info({ operation: 'start' }, 'Daily jobs scheduled for 9 am Pakistan and UK time; catching up now');
    this.#run('startup');
    this.#arm();
  }

  #arm() {
    if (this.#stopped) return;
    const now = this.#clock();
    const at = nextWake(now);
    this.#timer = setTimeout(() => {
      this.#run('schedule');
      this.#arm();
    }, Math.min(Math.max(at.getTime() - now.getTime(), 1_000), MAX_WAIT_MS));
    this.#timer.unref?.();
    this.#logger.info({ operation: 'arm', nextRunAt: at.toISOString() }, 'Next daily run scheduled');
  }

  #run(reason) {
    // A run already queued still happens; stop() waits for it.
    if (this.#stopped) return this.#running;
    this.#running = this.#running.then(async () => {
      try {
        await this.#jobs.runDaily({ now: this.#clock(), log: this.#logger.child({ operation: reason }) });
      } catch (error) {
        this.#logger.error({ operation: reason, err: error }, 'Daily run failed; the next one tries again');
      }
    });
    return this.#running;
  }

  /** Stops the timer and waits for a run in progress to finish. */
  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }
}
