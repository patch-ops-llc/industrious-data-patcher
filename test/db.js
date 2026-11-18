import crypto from 'node:crypto';
import { after } from 'node:test';
import { migrate, openDatabase } from '../src/db/index.js';

// Each harness gets its own schema, so tests never see each other's rows.
//
// Default: one embedded Postgres (PGlite) per test file.
// With TEST_DATABASE_URL set, the same tests run against a real Postgres
// server through the "pg" driver, which is what the service uses on Railway.

let embedded = null;
let currentSchema = null;

after(async () => {
  if (embedded) await embedded.close();
  embedded = null;
  currentSchema = null;
});

function schemaName() {
  return `t_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
}

async function embeddedDb(schema) {
  embedded ??= await openDatabase('pglite:memory');
  const shared = embedded;
  const use = async () => {
    if (currentSchema !== schema) {
      await shared.exec(`SET search_path TO "${schema}"`);
      currentSchema = schema;
    }
  };
  await shared.exec(`CREATE SCHEMA "${schema}"`);
  return {
    kind: shared.kind,
    async query(text, params) {
      await use();
      return shared.query(text, params);
    },
    async exec(sql) {
      await use();
      return shared.exec(sql);
    },
    async transaction(fn) {
      await use();
      return shared.transaction(fn);
    },
    async close() {
      await shared.exec(`DROP SCHEMA "${schema}" CASCADE`);
      currentSchema = null;
    },
  };
}

async function serverDb(url, schema) {
  const admin = await openDatabase(url);
  await admin.exec(`CREATE SCHEMA "${schema}"`);
  await admin.close();
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = await openDatabase(scoped.toString());
  return {
    kind: db.kind,
    url: scoped.toString(),
    query: db.query,
    exec: db.exec,
    transaction: db.transaction,
    async close() {
      await db.exec(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

/** A fresh, migrated staging database. Call close() when the test is done. */
export async function makeTestDb({ migrated = true } = {}) {
  const schema = schemaName();
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? await serverDb(url, schema) : await embeddedDb(schema);
  if (migrated) await migrate(db);
  return db;
}
