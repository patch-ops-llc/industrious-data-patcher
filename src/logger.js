const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Structured JSON-lines logger. One line per event on stdout, which is what
 * Railway captures as the service log.
 */
export function createLogger({ level = 'info', bindings = {}, write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink = write ?? ((line) => process.stdout.write(`${line}\n`));

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...fields }));
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, write: sink }),
  };
}
