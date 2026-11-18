import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HubSpotApi } from '../src/hubspot/api.js';
import { DryRunViolation, HubSpotApiError, HubSpotClient } from '../src/hubspot/client.js';
import { endpoints } from '../src/hubspot/endpoints.js';
import { FakeHubSpot } from './fake-hubspot.js';
import { seedSchema, T } from './helpers.js';

function setup({ dryRun = false, apiVersion = '2026-09', token = 'test-token', fakeOptions = {} } = {}) {
  const fake = new FakeHubSpot(fakeOptions);
  seedSchema(fake);
  const sleeps = [];
  const client = new HubSpotClient({
    token,
    baseUrl: 'https://fake.hubspot.test/',
    dryRun,
    fetchImpl: fake.fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    minIntervalMs: 0,
    searchMinIntervalMs: 0,
  });
  return { fake, client, sleeps, api: new HubSpotApi(client, { apiVersion }) };
}

test('client is in dry run unless told otherwise, and a dry-run client cannot send a write', async () => {
  const fake = new FakeHubSpot();
  seedSchema(fake);
  const client = new HubSpotClient({ token: 'test-token', baseUrl: 'https://fake.hubspot.test', fetchImpl: fake.fetch, minIntervalMs: 0 });
  assert.equal(client.dryRun, true);
  const api = new HubSpotApi(client);
  const a = fake.addRecord(T.line, { epicor_quote_num: 'Q' });
  const b = fake.addRecord(T.header, { epicor_quote_num: 'Q' });

  assert.equal(await client.write('POST', '/crm/associations/2026-09/x/y/batch/create', { body: {} }), null);
  await api.createAssociations(T.line, T.header, [{ fromId: a, toId: b }], { category: 'USER_DEFINED', typeId: 101 });
  await api.archiveAssociations(T.line, T.header, [{ fromId: a, toId: b }]);
  await api.updateObjects('deals', [{ id: '1', properties: { amount: '1' } }]);
  assert.equal(fake.requests.length, 0);
  assert.equal(client.stats.writesSkippedInDryRun, 4);
  assert.equal(new DryRunViolation('POST', '/x').name, 'DryRunViolation');
});

test('requests carry the bearer token; a rejected token surfaces as an error and is not retried', async () => {
  const { api, fake, client } = setup({ token: 'wrong-token' });
  await assert.rejects(() => api.searchAll(T.line, {}), (err) => err instanceof HubSpotApiError && err.status === 401);
  assert.equal(fake.requests.length, 1);
  assert.equal(client.stats.retries, 0);
});

test('429 and 5xx responses are retried, honouring Retry-After; the daily limit is not retried', async () => {
  const { api, fake, client, sleeps } = setup();
  fake.addRecord(T.line, { epicor_quote_num: 'Q' });

  fake.failNext({ pathIncludes: '/search', status: 429, body: { status: 'error', message: 'slow down', policyName: 'TEN_SECONDLY_ROLLING' }, headers: { 'retry-after': '3' } });
  fake.failNext({ pathIncludes: '/search', status: 502, body: { status: 'error', message: 'bad gateway' } });
  const found = await api.searchAll(T.line, {});
  assert.equal(found.length, 1);
  assert.equal(client.stats.retries, 2);
  assert.equal(sleeps[0], 3000);
  assert.ok(sleeps[1] >= 1000);

  fake.failNext({ pathIncludes: '/search', status: 429, body: { status: 'error', message: 'daily limit', policyName: 'DAILY' }, times: 5 });
  const before = fake.requests.length;
  await assert.rejects(() => api.searchAll(T.line, {}), (err) => err.status === 429);
  assert.equal(fake.requests.length, before + 1);
});

test('a request that keeps failing gives up after the configured attempts; network errors are retried too', async () => {
  const { api, fake, client } = setup();
  fake.failNext({ pathIncludes: '/search', status: 500, times: 50 });
  await assert.rejects(() => api.searchAll(T.line, {}), (err) => err.status === 500);
  assert.equal(fake.requests.length, client.maxAttempts);

  let calls = 0;
  const flaky = new HubSpotClient({
    token: 'test-token',
    baseUrl: 'https://fake.hubspot.test',
    dryRun: false,
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (...args) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return fake.fetch(...args);
    },
  });
  fake.failures.length = 0;
  const result = await new HubSpotApi(flaky).searchAll(T.line, {});
  assert.deepEqual(result, []);
  assert.equal(calls, 2);
});

test('requests are spaced: search calls wait for the search interval', async () => {
  const fake = new FakeHubSpot();
  seedSchema(fake);
  const sleeps = [];
  const client = new HubSpotClient({ token: 'test-token', baseUrl: 'https://fake.hubspot.test', dryRun: false, fetchImpl: fake.fetch, sleep: async (ms) => { sleeps.push(ms); }, minIntervalMs: 110, searchMinIntervalMs: 260 });
  const api = new HubSpotApi(client);
  await api.searchAll(T.line, {});
  await api.searchAll(T.line, {});
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 200 && sleeps[0] <= 260);
});

test('findByPropertyIn lower-cases values, removes duplicates and splits long lists to fit the search limits', async () => {
  const { api, fake } = setup();
  const ids = [];
  for (let i = 0; i < 450; i += 1) ids.push(fake.addRecord(T.header, { epicor_quote_num: `Quote-Number-${String(i).padStart(6, '0')}` }));
  const values = [];
  for (let i = 0; i < 450; i += 1) values.push(`QUOTE-NUMBER-${String(i).padStart(6, '0')}`, `quote-number-${String(i).padStart(6, '0')}`);

  const found = await api.findByPropertyIn(T.header, 'epicor_quote_num', values, ['epicor_quote_num']);
  assert.equal(found.length, 450);
  const searches = fake.requests.filter((r) => r.path.endsWith('/search'));
  assert.ok(searches.length >= 5);
  for (const request of searches) {
    assert.ok(JSON.stringify(request.body).length <= 3000);
    const inFilter = request.body.filterGroups[0].filters.find((f) => f.operator === 'IN');
    assert.ok(inFilter.values.length <= 100);
    assert.ok(inFilter.values.every((v) => v === v.toLowerCase()));
  }
});

test('matching on the record ID reads by ID and ignores values that cannot be an ID', async () => {
  const { api, fake } = setup();
  const deal = fake.addRecord('deals', { amount: '5' });
  const found = await api.findByPropertyIn('deals', 'hs_object_id', [deal, ` ${deal} `, 'abc', '', '12345678901234567890123', '424242'], ['amount']);
  assert.deepEqual(found.map((r) => r.id), [deal]);
  assert.equal(found[0].properties.hs_object_id, deal);
  assert.equal(fake.requests.length, 1);
  assert.match(fake.requests[0].path, /\/deals\/batch\/read$/);
  assert.deepEqual(fake.requests[0].body.inputs.map((i) => i.id).sort(), [deal, '424242'].sort());
});

test('legacy API version uses the v3/v4 paths; the date version uses the dated paths', async () => {
  const legacy = setup({ apiVersion: 'legacy' });
  const a = legacy.fake.addRecord(T.line, { epicor_quote_num: 'Q' });
  const b = legacy.fake.addRecord(T.header, { epicor_quote_num: 'Q' });
  await legacy.api.searchAll(T.line, {});
  await legacy.api.readAssociations(T.line, T.header, [a]);
  await legacy.api.createAssociations(T.line, T.header, [{ fromId: a, toId: b }], { category: 'USER_DEFINED', typeId: 101 });
  await legacy.api.associationLabels(T.line, T.header);
  await legacy.api.customObjectSchemas();
  await legacy.api.properties(T.line);
  assert.deepEqual(legacy.fake.requests.map((r) => r.path), [
    `/crm/v3/objects/${T.line}/search`,
    `/crm/v4/associations/${T.line}/${T.header}/batch/read`,
    `/crm/v4/associations/${T.line}/${T.header}/batch/create`,
    `/crm/v4/associations/${T.line}/${T.header}/labels`,
    '/crm/v3/schemas',
    `/crm/v3/properties/${T.line}`,
  ]);
  assert.deepEqual(legacy.fake.associated(T.line, a, T.header), [b]);

  const dated = endpoints('2026-09');
  assert.equal(dated.search('deals'), '/crm/objects/2026-09/deals/search');
  assert.equal(dated.associationsCreate('2-1', 'deals'), '/crm/associations/2026-09/2-1/deals/batch/create');
  assert.equal(dated.associationsArchive('2-1', 'deals'), '/crm/associations/2026-09/2-1/deals/batch/archive');
  assert.equal(dated.batchUpdate('deals'), '/crm/objects/2026-09/deals/batch/update');
  assert.equal(dated.schemas(), '/crm-object-schemas/2026-09/schemas');
});

test('association writes are sent in batches of at most 100, and archives group the pairs per source record', async () => {
  const { api, fake } = setup();
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q' });
  const lines = [];
  for (let i = 0; i < 230; i += 1) lines.push(fake.addRecord(T.line, { epicor_quote_num: 'Q' }));
  const troubled = await api.createAssociations(T.line, T.header, lines.map((fromId) => ({ fromId, toId: header })), { category: 'USER_DEFINED', typeId: 101 });
  assert.deepEqual(troubled, []);
  assert.deepEqual(fake.writes.map((w) => w.inputs.length), [100, 100, 30]);
  assert.deepEqual(fake.writes[0].inputs[0].types, [{ associationCategory: 'USER_DEFINED', associationTypeId: 101 }]);

  fake.writes.length = 0;
  await api.archiveAssociations(T.header, T.line, lines.slice(0, 5).map((toId) => ({ fromId: header, toId })));
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0].inputs.length, 1);
  assert.equal(fake.writes[0].inputs[0].to.length, 5);
  assert.equal(fake.associated(T.header, header, T.line).length, 225);
});
