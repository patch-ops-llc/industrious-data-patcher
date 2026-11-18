/**
 * Runs a task on a fixed interval, measured from the start of one run to the
 * start of the next. A run that takes longer than the interval delays the next
 * one; two runs never overlap.
 */
export function startScheduler({ intervalMs, task, logger, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let timer = null;
  let running = null;

  async function tick() {
    if (stopped) return;
    const started = Date.now();
    running = (async () => {
      try {
        await task();
      } catch (err) {
        logger?.error('scheduled run threw', { error: err?.message || String(err) });
      }
    })();
    await running;
    running = null;
    if (stopped) return;
    const wait = Math.max(0, intervalMs - (Date.now() - started));
    timer = setTimer(tick, wait);
  }

  tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      if (running) await running;
    },
  };
}
