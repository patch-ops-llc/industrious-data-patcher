/**
 * Runs a task on a fixed interval, measured from the start of one run to the
 * start of the next. A run that takes longer than the interval delays the next
 * one; two runs never overlap.
 *
 * The schedule can be paused and its interval changed while the service runs
 * (setSchedule), and a run can be started by hand (runNow). A run started by
 * hand counts like any other: the next scheduled run is one interval after it
 * started. With the schedule paused, runs only start by hand.
 */
export function startScheduler({ intervalMs, enabled = true, task, logger, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let stopped = false;
  let timer = null;
  let nextRunAt = null;
  let running = null;
  let lastStartedAt = null;

  function clearPlan() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextRunAt = null;
  }

  /** Sets the timer for the next scheduled run, when there should be one. */
  function plan() {
    clearPlan();
    if (stopped || running || !enabled) return;
    const at = now();
    const due = lastStartedAt === null ? at : lastStartedAt + intervalMs;
    const wait = Math.max(0, due - at);
    nextRunAt = at + wait;
    timer = setTimer(() => {
      timer = null;
      start('schedule');
    }, wait);
  }

  function start(trigger) {
    if (stopped || running) return false;
    clearPlan();
    lastStartedAt = now();
    const run = { startedAt: lastStartedAt, trigger, promise: null };
    running = run;
    run.promise = (async () => {
      try {
        await task({ trigger });
      } catch (err) {
        logger?.error('scheduled run threw', { error: err?.message || String(err) });
      }
      running = null;
      plan();
    })();
    return true;
  }

  if (enabled) start('schedule');

  return {
    /** Starts a run now unless one is in progress. Returns { started } and, when not started, why. */
    runNow() {
      if (stopped) return { started: false, reason: 'stopping' };
      if (running) return { started: false, reason: 'running' };
      start('manual');
      return { started: true };
    },
    /** Switches the schedule on or off and sets the interval. Takes effect at once; a run in progress is left to finish. */
    setSchedule({ enabled: on, intervalMs: every }) {
      enabled = Boolean(on);
      intervalMs = every;
      plan();
    },
    status() {
      return {
        enabled,
        intervalMs,
        running: Boolean(running),
        runningSince: running ? running.startedAt : null,
        runningTrigger: running ? running.trigger : null,
        nextRunAt,
        lastStartedAt,
      };
    },
    async stop() {
      stopped = true;
      clearPlan();
      if (running) await running.promise;
    },
  };
}
