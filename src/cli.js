#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAdminServer, MIN_PASSWORD_LENGTH } from './admin/server.js';
import { createAlerter, createRunNotifier, ALERT_LABEL } from './alerts.js';
import { assertValidMapping, ConfigError, loadMapping, loadSettings } from './config.js';
import { migrate, openDatabase } from './db/index.js';
import { ensureAlertSettings, getAlertSettings, getRun, lastRun } from './db/store.js';
import { restoreContactAssociations, runContactCleanup } from './engine/contactCleanup.js';
import { executeRun } from './engine/run.js';
import { HubSpotApi } from './hubspot/api.js';
import { HubSpotClient } from './hubspot/client.js';
import { createLogger } from './logger.js';
import { runDiscover, runPreflight } from './preflight.js';
import { summaryLines, writeRunReport } from './report.js';
import { effectiveSchedule } from './schedule.js';
import { startScheduler } from './scheduler.js';
import { runStamp } from './util.js';

const USAGE = `Industrious association cleanup middleware (Option B v3)

Usage: node src/cli.js <command> [options]

Commands
  start              The service: admin page on PORT plus one run every RUN_INTERVAL_MINUTES
                     (or as set on the admin page).
  run                One scheduled-style run.
  reconcile          Full run: re-reads everything from HubSpot and writes a before/after
                     reconciliation report.
  cleanup-contacts   Item B2 one-time removal of contact associations left by the retired workflow.
  migrate            Create or update the staging database tables.
  report [run id]    Print the stored report of the last run (or of the given run).
  preflight          Read-only check of the mapping file against the HubSpot account.
  discover           Read-only listing of custom objects, properties and association types.

Options
  --apply            Write changes to HubSpot. Without it every command is a dry run.
  --dry-run          Force a dry run even if DRY_RUN=false is set.
  --limit <n>        Change at most n records per association (and n deals, or n quote
                     headers for cleanup-contacts). For a first small live sample.
  --deal-amounts     reconcile: one-off catch-up that sets every deal amount that differs
                     from its quote header amount (not only headers whose amount changed).
  --restore <id|file>  cleanup-contacts: put back the associations a cleanup removed, by
                     cleanup run ID (from the staging database) or backup file.
  --output <dir>     Where to write report files (default: REPORTS_DIR, ./reports).
  --help             Show this text.

A dry run changes nothing in HubSpot. It still reads from HubSpot and refreshes
the staging database.
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'deal-amounts': { type: 'boolean', default: false },
      restore: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  let limit = null;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new ConfigError('--limit must be a whole number of at least 1');
  }
  return { command: positionals[0], args: positionals.slice(1), values, limit };
}

function baseSettings({ values }) {
  const env = loadSettings();
  const dryRun = values['dry-run'] ? true : values.apply ? false : env.dryRun;
  const settings = { ...env, dryRun };
  const logger = createLogger({ level: settings.logLevel });
  const outputDir = values.output ? path.resolve(values.output) : settings.reportsDir;
  return { settings, logger, outputDir };
}

async function openStagingDatabase(settings, logger) {
  if (!settings.databaseUrl) {
    throw new ConfigError('DATABASE_URL is not set. On Railway reference the Postgres service (${{Postgres.DATABASE_URL}}). For a local dry run without a Postgres server use DATABASE_URL=pglite:./data/staging');
  }
  const db = await openDatabase(settings.databaseUrl, { ssl: settings.databaseSsl });
  try {
    await migrate(db, { logger });
    await ensureAlertSettings(db, { emailRecipients: settings.alerts.emailTo, repeatMinutes: settings.alerts.minRepeatMinutes, now: new Date() });
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }
  return db;
}

function hubspot(settings, logger) {
  if (!settings.hubspotToken) throw new ConfigError('HUBSPOT_PRIVATE_APP_TOKEN is not set');
  const client = new HubSpotClient({
    token: settings.hubspotToken,
    baseUrl: settings.hubspotBaseUrl,
    dryRun: settings.dryRun,
    logger,
  });
  return new HubSpotApi(client, { apiVersion: settings.hubspotApiVersion, logger });
}

/** Everything a command that talks to HubSpot and the staging database needs. Call ctx.close() when done. */
async function buildContext(cli, { needsValidMapping = true, forCleanup = false, database = true } = {}) {
  const { settings, logger, outputDir } = baseSettings(cli);
  const mapping = loadMapping(settings.mappingFile);
  if (needsValidMapping) assertValidMapping(mapping, { forCleanup });
  const api = hubspot(settings, logger);
  const db = database ? await openStagingDatabase(settings, logger) : null;
  return { api, db, mapping, settings, logger, outputDir, close: async () => db?.close() };
}

function print(lines) {
  process.stdout.write(`${[].concat(lines).join('\n')}\n`);
}

function modeBanner(dryRun) {
  return dryRun
    ? 'DRY RUN: nothing will be changed in HubSpot. Add --apply (or set DRY_RUN=false) to write.'
    : 'LIVE: changes will be written to HubSpot.';
}

async function commandRun(cli, mode) {
  const ctx = await buildContext(cli);
  try {
    print(modeBanner(ctx.settings.dryRun));
    const summary = await executeRun(ctx, {
      mode,
      limit: cli.limit,
      dealAmounts: cli.values['deal-amounts'] ? true : undefined,
    });
    if (summary.status === 'skipped') {
      print('Nothing was done: another live run is in progress (run lock held).');
      return 1;
    }
    const files = writeRunReport(ctx.outputDir, summary);
    print(summaryLines(summary));
    print(`Report: ${files.markdown}`);
    if (summary.status !== 'ok') {
      // A one-off command reports its own failure without touching the
      // scheduled service's failing/recovered state.
      const alerts = await getAlertSettings(ctx.db).catch(() => ({ enabled: true, emailRecipients: ctx.settings.alerts.emailTo }));
      if (alerts.enabled) {
        const what = summary.status === 'failed' ? 'run FAILED' : 'run completed with errors';
        await createAlerter(ctx.settings.alerts, { logger: ctx.logger }).send(
          { subject: `${ALERT_LABEL}: manual ${what}${summary.dryRun ? ' (dry run)' : ''}`, lines: summaryLines(summary) },
          { recipients: alerts.emailRecipients },
        );
      }
    }
    return summary.status === 'ok' ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

async function commandStart(cli) {
  const ctx = await buildContext(cli);
  const { settings, logger, db } = ctx;
  const alerter = createAlerter(settings.alerts, { logger });
  const notifier = createRunNotifier({ db, alerter, defaults: settings.alerts, logger });
  // The admin page starts runs and changes the schedule through the scheduler, which is started further down.
  let scheduler = null;
  const runs = {
    status: () => scheduler?.status() ?? null,
    runNow: () => (scheduler ? scheduler.runNow() : { started: false, reason: 'starting' }),
    setSchedule: (schedule) => scheduler?.setSchedule(schedule),
  };
  const admin = createAdminServer({ db, settings, alerter, logger, runs });
  const address = await admin.listen(settings.port);
  const alertSettings = await getAlertSettings(db);
  const channels = alerter.status(alertSettings.emailRecipients);
  // Also applies the recovery rule: a new ADMIN_PASSWORD value replaces a password set on the page.
  const signInWith = await admin.passwordSource();
  // RUN_INTERVAL_MINUTES, until the schedule is changed on the admin page.
  const schedule = await effectiveSchedule(db, settings);

  logger.info('service starting', {
    intervalMinutes: schedule.intervalMinutes,
    schedule: schedule.enabled ? 'on' : 'paused',
    scheduleFrom: schedule.source === 'page' ? 'the admin page' : 'RUN_INTERVAL_MINUTES variable',
    dryRun: settings.dryRun,
    port: address.port,
    adminPage: admin.enabled ? 'on' : 'off',
    adminSignIn: signInWith === 'page' ? 'password set on the admin page' : signInWith === 'variable' ? 'ADMIN_PASSWORD variable' : 'off',
    alertsEnabled: alertSettings.enabled,
    alertEmail: channels.email,
    alertSlack: channels.slack,
  });
  if (settings.dryRun) logger.warn(modeBanner(true));
  if (!admin.enabled) logger.warn(`ADMIN_PASSWORD is not set (or shorter than ${MIN_PASSWORD_LENGTH} characters); the admin page is switched off`);
  if (!channels.email && !channels.slack) logger.warn('no alert channel is set up; failures will only appear in the log and on the admin page');
  if (!schedule.enabled) logger.warn('scheduled runs are paused on the admin page; runs only start with Sync now');

  scheduler = startScheduler({
    intervalMs: schedule.intervalMinutes * 60_000,
    enabled: schedule.enabled,
    logger,
    task: async () => {
      const summary = await executeRun(ctx, { mode: 'incremental' });
      await notifier.afterRun(summary);
    },
  });

  await new Promise((resolve) => {
    const shutdown = (signal) => {
      logger.info('shutting down after the current run', { signal });
      Promise.allSettled([scheduler.stop(), admin.close()]).then(resolve);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
  await ctx.close();
  return 0;
}

async function commandCleanup(cli) {
  const ctx = await buildContext(cli, { forCleanup: true });
  try {
    print(modeBanner(ctx.settings.dryRun));
    let summary;
    if (cli.values.restore) {
      const source = cli.values.restore;
      summary = await restoreContactAssociations(ctx, UUID.test(source) ? { runId: source.toLowerCase() } : { file: path.resolve(source) });
    } else {
      summary = await runContactCleanup(ctx, { limit: cli.limit, outputDir: ctx.outputDir });
    }
    const file = path.join(ctx.outputDir, `contact-cleanup-summary-${runStamp()}${summary.dryRun ? '-dryrun' : ''}.json`);
    fs.mkdirSync(ctx.outputDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    print(JSON.stringify(summary, null, 2));
    print(`Summary: ${file}`);
    if (summary.runId && !summary.dryRun && summary.status !== 'skipped') {
      print(`To put these associations back: node src/cli.js cleanup-contacts --restore ${summary.runId} --apply`);
    }
    return summary.status === 'ok' ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

async function commandMigrate(cli) {
  const { settings, logger } = baseSettings(cli);
  const db = await openStagingDatabase(settings, logger);
  await db.close();
  print('Staging database is up to date.');
  return 0;
}

async function commandReport(cli) {
  const { settings, logger } = baseSettings(cli);
  const db = await openStagingDatabase(settings, logger);
  try {
    const id = cli.args[0];
    if (id && !UUID.test(id)) throw new ConfigError('report: the run ID is not valid');
    const run = id ? await getRun(db, id.toLowerCase()) : await lastRun(db, { modes: ['incremental', 'full'] });
    if (!run) {
      print(id ? `No run with ID ${id} in the staging database.` : 'No run has been recorded yet.');
      return 1;
    }
    print(run.reportMarkdown || JSON.stringify(run.summary ?? { runId: run.runId, status: run.status }, null, 2));
    return 0;
  } finally {
    await db.close();
  }
}

async function commandPreflight(cli) {
  const ctx = await buildContext({ ...cli, values: { ...cli.values, 'dry-run': true } }, { needsValidMapping: false, database: false });
  const result = await runPreflight(ctx);
  for (const check of result.checks) {
    print(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}${check.detail ? `  -  ${check.detail}` : ''}`);
  }
  print(result.ok ? 'Preflight passed.' : 'Preflight found problems.');
  return result.ok ? 0 : 1;
}

async function commandDiscover(cli) {
  const ctx = await buildContext({ ...cli, values: { ...cli.values, 'dry-run': true } }, { needsValidMapping: false, database: false });
  const result = await runDiscover(ctx);
  fs.mkdirSync(ctx.outputDir, { recursive: true });
  const file = path.join(ctx.outputDir, `discover-${runStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  print(JSON.stringify(result, null, 2));
  print(`Saved: ${file}`);
  return result.errors.length ? 1 : 0;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.values.help || !cli.command) {
    print(USAGE);
    return cli.command || cli.values.help ? 0 : 2;
  }
  switch (cli.command) {
    case 'start':
      return commandStart(cli);
    case 'run':
      return commandRun(cli, 'incremental');
    case 'reconcile':
      return commandRun(cli, 'full');
    case 'cleanup-contacts':
      return commandCleanup(cli);
    case 'migrate':
      return commandMigrate(cli);
    case 'report':
      return commandReport(cli);
    case 'preflight':
      return commandPreflight(cli);
    case 'discover':
      return commandDiscover(cli);
    default:
      print(USAGE);
      throw new ConfigError(`Unknown command: ${cli.command}`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : err?.stack || err}\n`);
    process.exitCode = err instanceof ConfigError ? 2 : 1;
  },
);
