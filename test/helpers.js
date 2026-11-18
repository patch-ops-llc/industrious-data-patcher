import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMapping } from '../src/config.js';
import { HubSpotApi } from '../src/hubspot/api.js';
import { HubSpotClient } from '../src/hubspot/client.js';
import { createLogger } from '../src/logger.js';
import { ensureAlertSettings, loadBaselines, openReviewItems } from '../src/db/store.js';
import { makeTestDb } from './db.js';
import { FakeHubSpot } from './fake-hubspot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEST_MAPPING_FILE = path.join(HERE, 'fixtures', 'mapping.json');
export const SHIPPED_MAPPING_FILE = path.join(HERE, '..', 'config', 'mapping.json');

// Generic fixture: invented object types and property names, used to test the
// engine independently of any one portal. The portal-shaped fixture further
// down (P, seedPortalSchema) mirrors the Industrious portal and is used with
// the shipped config/mapping.json.
export const T = { header: '2-1001', line: '2-1002', task: '2-1003', ic: '2-1004', contact: 'contacts', company: 'companies', deal: 'deals' };

export function seedSchema(fake) {
  fake.defineObject(T.header, { name: 'quote_header', properties: ['epicor_quote_num', 'epicor_cust_id', 'epicor_quote_contact_num', 'quote_amount'] });
  fake.defineObject(T.line, { name: 'quote_line', properties: ['epicor_quote_num'] });
  fake.defineObject(T.task, { name: 'quote_task', properties: ['epicor_quote_num'] });
  fake.defineObject(T.ic, { name: 'ic_code', properties: ['epicor_cust_id'] });
  fake.defineObject('contacts', { custom: false, properties: ['epicor_contact_num', 'epicor_cust_id'] });
  fake.defineObject('companies', { custom: false, properties: ['epicor_cust_id'] });
  fake.defineObject('deals', { custom: false, properties: ['epicor_quote_num', 'amount', 'hs_is_closed'] });

  fake.defineAssociation(T.line, T.header, { aToB: 101, bToA: 102, unlabeled: true });
  fake.defineAssociation(T.task, T.header, { aToB: 103, bToA: 104, unlabeled: true });
  fake.defineAssociation(T.header, T.deal, { aToB: 105, bToA: 106, unlabeled: true });
  fake.defineAssociation(T.header, T.company, { aToB: 107, bToA: 108, unlabeled: true });
  fake.defineAssociation(T.ic, T.company, { aToB: 109, bToA: 110, unlabeled: true });
  fake.defineAssociation(T.header, T.contact, { aToB: 111, bToA: 112, unlabeled: true });
  fake.defineAssociation(T.header, T.contact, { aToB: 113, bToA: 114, label: 'Decision maker' });
}

export async function makeHarness({ fakeOptions = {}, settings = {}, mutateMapping, mappingFile = TEST_MAPPING_FILE, seed = seedSchema } = {}) {
  const fake = new FakeHubSpot(fakeOptions);
  seed(fake);
  const db = await makeTestDb();
  await ensureAlertSettings(db, { emailRecipients: [], repeatMinutes: 60, now: new Date(fake.clock) });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc-cleanup-test-'));
  const raw = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  if (mutateMapping) mutateMapping(raw);
  const mapping = normalizeMapping(raw);
  const logs = [];
  const logger = createLogger({ level: 'debug', write: (line) => logs.push(JSON.parse(line)) });
  const allSettings = {
    changeOverlapMinutes: 5,
    fullRefreshHours: 24,
    keepRunsDays: 90,
    runLockStaleMinutes: 15,
    hubspotApiVersion: '2026-09',
    ...settings,
  };

  function ctx({ dryRun = false, clientOptions = {} } = {}) {
    const client = new HubSpotClient({
      token: 'test-token',
      baseUrl: 'https://fake.hubspot.test',
      dryRun,
      fetchImpl: fake.fetch,
      sleep: async () => {},
      minIntervalMs: 0,
      searchMinIntervalMs: 0,
      logger,
      ...clientOptions,
    });
    const api = new HubSpotApi(client, { apiVersion: allSettings.hubspotApiVersion, logger });
    return { api, db, mapping, settings: allSettings, logger, now: () => new Date(fake.clock) };
  }

  return {
    fake,
    db,
    mapping,
    settings: allSettings,
    outputDir,
    logs,
    ctx,
    rule: (summary, id) => summary.rules.find((r) => r.id === id),
    /** Open review items of a rule, as { recordId: status }. */
    review: async (ruleId) => Object.fromEntries((await openReviewItems(db, ruleId)).map((item) => [item.id, item.status])),
    baselines: () => loadBaselines(db),
    count: async (table, where = 'true') => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n,
    async cleanup() {
      fs.rmSync(outputDir, { recursive: true, force: true });
      await db.close();
    },
  };
}

/** Adds one complete quote family and returns the record IDs. */
export function addQuoteFamily(fake, { quote, customer, contactNumber, amount = '1000', lines = 2, tasks = 1, withDeal = true, withCompany = true, withContact = true, dealAmount = amount }) {
  const ids = { lines: [], tasks: [] };
  if (withCompany) ids.company = fake.addRecord(T.company, { epicor_cust_id: customer });
  if (withContact) ids.contact = fake.addRecord(T.contact, { epicor_contact_num: contactNumber, epicor_cust_id: customer });
  if (withDeal) ids.deal = fake.addRecord(T.deal, { epicor_quote_num: quote, amount: dealAmount });
  ids.header = fake.addRecord(T.header, { epicor_quote_num: quote, epicor_cust_id: customer, epicor_quote_contact_num: contactNumber, quote_amount: amount });
  for (let i = 0; i < lines; i += 1) ids.lines.push(fake.addRecord(T.line, { epicor_quote_num: quote }));
  for (let i = 0; i < tasks; i += 1) ids.tasks.push(fake.addRecord(T.task, { epicor_quote_num: quote }));
  return ids;
}

// ---- portal-shaped fixture ------------------------------------------------
// Object type IDs, property names and association type IDs as read from the
// Industrious HubSpot portal on 2026-11-12. Records are invented.
export const P = {
  quote: '2-45361208',
  line: '2-45402132',
  task: '2-48899315',
  ic: '2-45358916',
  epicorContact: '2-55947981',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
};

export function seedPortalSchema(fake) {
  fake.defineObject(P.quote, { name: 'epicor_quotes', properties: ['quote_number', 'customer_uid', 'shipping_customer_id', 'hubspot_deal_id', { name: 'amount', type: 'number' }] });
  fake.defineObject(P.line, { name: 'epicor_quote_line_items', properties: ['quote_number', 'quote_line', 'line_item_id', { name: 'amount', type: 'number' }] });
  fake.defineObject(P.task, { name: 'epicor_tasks', properties: ['quote_id', 'key1', 'task_id', 'customer_id'] });
  fake.defineObject(P.ic, { name: 'customer_ic_codes', properties: ['customer_uid', 'ic_code_uid'] });
  fake.defineObject(P.epicorContact, { name: 'epicor_contacts', properties: ['custnum', 'epicor_id', 'email'] });
  fake.defineObject('companies', { custom: false, properties: ['customer_uid', 'epicor_customer_id', 'epicor_customer_number'] });
  fake.defineObject('deals', { custom: false, properties: [{ name: 'amount', type: 'number' }, 'hs_is_closed', 'quote_num'] });
  fake.defineObject('contacts', { custom: false, properties: ['email'] });

  fake.defineAssociation(P.line, P.quote, { aToB: 98, bToA: 97, unlabeled: true });
  fake.defineAssociation(P.task, P.quote, { aToB: 123, bToA: 124, unlabeled: true });
  fake.defineAssociation(P.quote, P.deal, { aToB: 99, bToA: 100, unlabeled: true });
  fake.defineAssociation(P.quote, P.company, { aToB: 95, bToA: 96, unlabeled: true });
  fake.defineAssociation(P.ic, P.company, { aToB: 93, bToA: 94, unlabeled: true });
  fake.defineAssociation(P.quote, P.epicorContact, { aToB: 148, bToA: 147, unlabeled: true });
  fake.defineAssociation(P.quote, P.contact, { aToB: 103, bToA: 104, unlabeled: true });
  fake.defineAssociation(P.epicorContact, P.contact, { aToB: 141, bToA: 142, unlabeled: true });
}

export function makePortalHarness(options = {}) {
  return makeHarness({ mappingFile: SHIPPED_MAPPING_FILE, seed: seedPortalSchema, ...options });
}
