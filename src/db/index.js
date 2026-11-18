import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const MIGRATION_LOCK = 4711001;

function sslOption(mode) {
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') return true;
  return undefined;
}

async function openPostgres(url, { ssl = 'disable', max = 5 } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max, ssl: sslOption(ssl), connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
  // An idle connection dropping (database restart) must not crash the service.
  pool.on('error', () => {});
  const wrap = (runner) => ({
    async query(text, params = []) {
      const result = await runner.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  });
  return {
    kind: 'postgres',
    ...wrap(pool),
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          ...wrap(client),
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Embedded Postgres (PGlite) for the test suite and for dry runs on a machine
 * without a Postgres server. It is a development dependency and is never
 * used on Railway.
 */
async function openEmbedded(location) {
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error('DATABASE_URL uses pglite: but @electric-sql/pglite is not installed (it is a development dependency; run npm install without --omit=dev)');
  }
  const db = location && location !== 'memory' ? new PGlite(location) : new PGlite();
  await db.waitReady;
  const wrap = (runner) => ({
    async query(text, params = []) {
      const result = await runner.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
    async exec(sql) {
      await runner.exec(sql);
    },
  });
  return {
    kind: 'pglite',
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    async close() {
      await db.close();
    },
  };
}

/**
 * Opens the staging database. url is a Postgres connection string, or
 * "pglite:memory" / "pglite:<directory>" for the embedded database.
 */
export async function openDatabase(url, options = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (url.startsWith('pglite:')) return openEmbedded(url.slice('pglite:'.length));
  return openPostgres(url, options);
}

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
}

/**
 * Applies the SQL files in migrations/ that have not been applied yet, in
 * name order, each in its own transaction. Safe to run on every start and
 * from two processes at once.
 */
export async function migrate(db, { dir = MIGRATIONS_DIR, logger } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = [];
  for (const name of migrationFiles(dir)) {
    const done = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const existing = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rows.length) return false;
      await tx.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (done) {
      applied.push(name);
      logger?.info('database migration applied', { name });
    }
  }
  return applied;
}
