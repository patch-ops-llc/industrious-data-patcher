import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastLinkHealth } from '../src/db/store.js';
import { linkHealth, outcomeRecorder } from '../src/engine/health.js';
import { executeRun } from '../src/engine/run.js';
import { makeHarness, makePortalHarness, P, T } from './helpers.js';

// Link health: how many records of each type are associated in HubSpot with
// the record their ID matches, as every run reports it.

const counts = ({ records, withKey, linked, pending, failed, held, noMatch, noKey }) => ({ records, withKey, linked, pending, failed, held, noMatch, noKey });
const byPair = (health) => Object.fromEntries(health.map((group) => [`${group.from}>${group.to}`, counts(group)]));

function assertAddsUp(health) {
  for (const group of health) {
    assert.equal(group.linked + group.pending + group.failed + group.held + group.noMatch, group.withKey, `${group.from}>${group.to}`);
    assert.equal(group.withKey + group.noKey, group.records, `${group.from}>${group.to}`);
  }
}

test('link health: every run counts, per kind of record, how many are linked to the record their ID matches; the portal mapping', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const company = fake.addRecord(P.company, { customer_uid: '1', epicor_customer_id: '1' });
  const quote = (properties) => fake.addRecord(P.quote, { amount: '100', ...properties });

  // A: the deal ID points at a deal that also carries the quote number. Not associated yet.
  const dealA = fake.addRecord(P.deal, { amount: '100', quote_num: '9001' });
  const qA = quote({ quote_number: '9001', customer_uid: '1', hubspot_deal_id: dealA });
  // B: no deal ID; one deal carries the quote number. Not associated yet.
  const dealB = fake.addRecord(P.deal, { amount: '100', quote_num: '9002' });
  const qB = quote({ quote_number: '9002', customer_uid: '1' });
  // C: the quote number is on two deals.
  fake.addRecord(P.deal, { amount: '100', quote_num: '9003' });
  fake.addRecord(P.deal, { amount: '100', quote_num: '9003' });
  quote({ quote_number: '9003', customer_uid: '1' });
  // D: no deal anywhere.
  quote({ quote_number: '9004', customer_uid: '1' });
  // E: associated to a deal by hand; neither the deal ID nor the quote number leads to it.
  const dealE = fake.addRecord(P.deal, { amount: '100' });
  const qE = quote({ quote_number: '9005', customer_uid: '1' });
  fake.associate(P.quote, qE, P.deal, dealE, 99);
  // F: already associated with the deal of its deal ID and with its company.
  const dealF = fake.addRecord(P.deal, { amount: '100' });
  const qF = quote({ quote_number: '9006', customer_uid: '1', hubspot_deal_id: dealF });
  fake.associate(P.quote, qF, P.deal, dealF, 99);
  fake.associate(P.quote, qF, P.company, company, 95);
  // G: a deal ID that is no deal, and no customer ID.
  quote({ quote_number: '9007', customer_uid: '', hubspot_deal_id: 'abc' });
  // H: a customer ID that is no company.
  quote({ quote_number: '9008', customer_uid: '999' });
  // I: neither a deal ID nor a quote number.
  quote({ quote_number: '', customer_uid: '1' });

  const l1 = fake.addRecord(P.line, { quote_number: '9006', amount: '50' });
  fake.associate(P.line, l1, P.quote, qF, 98);
  const l2 = fake.addRecord(P.line, { quote_number: '9006', amount: '50' });
  fake.addRecord(P.line, { quote_number: '7777', amount: '50' });
  fake.addRecord(P.line, { quote_number: '', amount: '50' });
  fake.addRecord(P.line, { quote_number: '0', amount: '50' });
  fake.addRecord(P.task, { quote_id: '0' });
  fake.addRecord(P.task, { quote_id: '9001' });
  fake.addRecord(P.ic, { customer_uid: '1' });
  fake.advance(10);

  // ---- dry run: what is linked now, and what a live run would link ----
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(dry.status, 'ok');
  assert.equal(fake.writes.length, 0);
  assert.deepEqual(dry.health.map((g) => [g.from, g.to, g.fromLabel, g.toLabel, g.rules, g.keys]), [
    ['quoteLine', 'quoteHeader', 'Epicor Quote Line Item', 'Epicor Quote', ['lines_to_header'], ['quote_number']],
    ['quoteTask', 'quoteHeader', 'Epicor Task', 'Epicor Quote', ['tasks_to_header'], ['quote_id']],
    // The two ways of finding a quote's deal are one line: a quote is linked when either found it linked.
    ['quoteHeader', 'deal', 'Epicor Quote', 'Deal', ['header_to_deal', 'header_to_deal_by_quote_number'], ['hubspot_deal_id', 'quote_number']],
    ['quoteHeader', 'company', 'Epicor Quote', 'Company', ['header_to_company'], ['customer_uid']],
    ['icCode', 'company', 'Customer IC Code', 'Company', ['ic_codes_to_company'], ['customer_uid']],
  ]);
  assert.deepEqual(byPair(dry.health), {
    'quoteLine>quoteHeader': { records: 5, withKey: 3, linked: 1, pending: 1, failed: 0, held: 0, noMatch: 1, noKey: 2 },
    'quoteTask>quoteHeader': { records: 2, withKey: 1, linked: 0, pending: 1, failed: 0, held: 0, noMatch: 0, noKey: 1 },
    // linked F; pending A and B; held C; no match D, E, G, H; no ID I.
    'quoteHeader>deal': { records: 9, withKey: 8, linked: 1, pending: 2, failed: 0, held: 1, noMatch: 4, noKey: 1 },
    'quoteHeader>company': { records: 9, withKey: 8, linked: 1, pending: 6, failed: 0, held: 0, noMatch: 1, noKey: 1 },
    'icCode>company': { records: 1, withKey: 1, linked: 0, pending: 1, failed: 0, held: 0, noMatch: 0, noKey: 0 },
  });
  assertAddsUp(dry.health);
  // Quote A: the quote number rule treats the association the deal ID rule only planned as existing.
  // It is not in HubSpot, so link health must not call it linked.
  assert.equal(h.rule(dry, 'header_to_deal_by_quote_number').alreadyAssociated, 1);
  assert.deepEqual(fake.associated(P.quote, qA, P.deal), []);

  // ---- live run: everything pending is now linked; the rest is unchanged ----
  fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(live.status, 'ok');
  const expected = {
    'quoteLine>quoteHeader': { records: 5, withKey: 3, linked: 2, pending: 0, failed: 0, held: 0, noMatch: 1, noKey: 2 },
    'quoteTask>quoteHeader': { records: 2, withKey: 1, linked: 1, pending: 0, failed: 0, held: 0, noMatch: 0, noKey: 1 },
    'quoteHeader>deal': { records: 9, withKey: 8, linked: 3, pending: 0, failed: 0, held: 1, noMatch: 4, noKey: 1 },
    'quoteHeader>company': { records: 9, withKey: 8, linked: 7, pending: 0, failed: 0, held: 0, noMatch: 1, noKey: 1 },
    'icCode>company': { records: 1, withKey: 1, linked: 1, pending: 0, failed: 0, held: 0, noMatch: 0, noKey: 0 },
  };
  assert.deepEqual(byPair(live.health), expected);
  assertAddsUp(live.health);
  assert.deepEqual(fake.associated(P.quote, qA, P.deal), [dealA]);
  assert.deepEqual(fake.associated(P.quote, qB, P.deal), [dealB]);
  assert.deepEqual(fake.associated(P.line, l2, P.quote), [qF]);
  // A hand-made association is left alone, and is not counted as linked by ID.
  assert.deepEqual(fake.associated(P.quote, qE, P.deal), [dealE]);
  // Where one rule links two objects, "linked" is what that rule found in place plus what it created.
  for (const [pair, id] of [['quoteLine>quoteHeader', 'lines_to_header'], ['quoteTask>quoteHeader', 'tasks_to_header'], ['quoteHeader>company', 'header_to_company'], ['icCode>company', 'ic_codes_to_company']]) {
    const rule = h.rule(live, id);
    assert.equal(expected[pair].linked, rule.alreadyAssociated + rule.created + rule.createdUnverified, id);
    assert.equal(expected[pair].records, rule.sources, id);
    assert.equal(expected[pair].noKey, rule.missingKey, id);
    assert.equal(expected[pair].noMatch, rule.noTarget, id);
  }

  // ---- the next scheduled run answers from the staging copy, with the same result ----
  fake.advance(30);
  const writes = fake.writes.length;
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(fake.writes.length, writes);
  assert.deepEqual(byPair(next.health), expected);
  assert.ok(h.logs.some((l) => l.msg === 'link health' && l.runId === next.runId && l.from === 'quoteHeader' && l.to === 'deal' && l.linked === 3 && l.withKey === 8));

  // ---- stored with the run, for the admin page ----
  let stored = await lastLinkHealth(h.db);
  assert.equal(stored.runId, next.runId);
  assert.equal(stored.dryRun, false);
  assert.equal(stored.mode, 'incremental');
  assert.equal(new Date(stored.finishedAt).toISOString(), next.finishedAt);
  assert.deepEqual(stored.groups, next.health);

  // A run that fails before the associations were checked has no link health; the last good one stays.
  fake.advance(30);
  fake.failNext({ pathIncludes: '/search', status: 500, times: 50 });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.health, null);
  stored = await lastLinkHealth(h.db);
  assert.equal(stored.runId, next.runId);
  await h.cleanup();
});

test('link health: before the first run there is none', async () => {
  const h = await makeHarness();
  assert.equal(await lastLinkHealth(h.db), null);
  await h.cleanup();
});

test('link health: records a limited run did not get to are pending; a refused association is failed until it goes through', async () => {
  const h = await makeHarness();
  const { fake } = h;
  fake.addRecord(T.header, { epicor_quote_num: 'Q1' });
  const lines = [1, 2, 3, 4, 5].map(() => fake.addRecord(T.line, { epicor_quote_num: 'Q1' }));
  fake.addRecord(T.line, { epicor_quote_num: 'NONE' });
  fake.advance(1);

  const limited = await executeRun(h.ctx(), { mode: 'full', limit: 2 });
  const key = Object.keys(byPair(limited.health)).find((k) => byPair(limited.health)[k].records === 6);
  assert.deepEqual(byPair(limited.health)[key], { records: 6, withKey: 6, linked: 2, pending: 3, failed: 0, held: 0, noMatch: 1, noKey: 0 });
  assert.equal((await lastLinkHealth(h.db)).limit, 2);

  fake.advance(30);
  fake.rejectInputsOnce({ pathIncludes: `/${T.line}/${T.header}/batch/create`, predicate: (input) => input.from.id === lines[4] });
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'completed_with_errors');
  assert.deepEqual(byPair(second.health)[key], { records: 6, withKey: 6, linked: 4, pending: 0, failed: 1, held: 0, noMatch: 1, noKey: 0 });

  fake.advance(30);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(byPair(third.health)[key], { records: 6, withKey: 6, linked: 5, pending: 0, failed: 0, held: 0, noMatch: 1, noKey: 0 });
  for (const run of [limited, second, third]) assertAddsUp(run.health);
  await h.cleanup();
});

test('link health: held records and records deleted in HubSpot during a run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  // Two headers share a quote number: their line is held for review.
  fake.addRecord(T.header, { epicor_quote_num: 'DUP' });
  fake.addRecord(T.header, { epicor_quote_num: 'DUP' });
  fake.addRecord(T.line, { epicor_quote_num: 'DUP' });
  const waiting = fake.addRecord(T.line, { epicor_quote_num: 'LATE' });
  fake.advance(1);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  const key = Object.keys(byPair(first.health)).find((k) => byPair(first.health)[k].records === 2);
  assert.deepEqual(byPair(first.health)[key], { records: 2, withKey: 2, linked: 0, pending: 0, failed: 0, held: 1, noMatch: 1, noKey: 0 });

  // The waiting line is deleted in HubSpot; its header arrives afterwards. The staging copy still has the line.
  fake.deleteRecord(T.line, waiting);
  fake.advance(30);
  fake.addRecord(T.header, { epicor_quote_num: 'LATE' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'ok');
  assert.equal(h.rule(second, 'lines_to_header').gone, 1);
  // A record that no longer exists is not counted at all.
  assert.deepEqual(byPair(second.health)[key], { records: 1, withKey: 1, linked: 0, pending: 0, failed: 0, held: 1, noMatch: 0, noKey: 0 });
  assertAddsUp(second.health);
  await h.cleanup();
});

test('link health: when several rules link the same two objects, the best result found for a record counts once', () => {
  const mapping = {
    objects: {
      a: { label: 'A record', properties: { one: 'prop_one', two: 'prop_two', three: 'prop_three' } },
      b: { properties: {} },
    },
  };
  const rules = [
    { id: 'first', from: 'a', to: 'b', match: [{ from: 'one', to: 'x' }] },
    { id: 'second', from: 'a', to: 'b', match: [{ from: 'two', to: 'y' }, { from: 'three', to: 'z' }] },
    { id: 'again', from: 'a', to: 'b', match: [{ from: 'one', to: 'w' }] },
  ];
  const outcomes = new Map();
  const [first, second] = rules.map((rule) => outcomeRecorder(outcomes, rule));
  const results = {
    1: ['noKey', 'noKey'],
    2: ['noKey', 'noMatch'],
    3: ['noMatch', 'held'],
    4: ['held', 'failed'],
    5: ['failed', 'pending'],
    6: ['pending', 'linked'],
    7: ['linked', 'noKey'],
    8: ['noMatch', 'gone'],
  };
  for (const [id, [a, b]] of Object.entries(results)) {
    first(id, a);
    second(id, b);
  }
  assert.deepEqual(linkHealth(mapping, rules, outcomes), [{
    from: 'a',
    to: 'b',
    fromLabel: 'A record',
    toLabel: 'b',
    rules: ['first', 'second', 'again'],
    keys: ['prop_one', 'prop_two + prop_three'],
    records: 7,
    withKey: 6,
    linked: 2,
    pending: 1,
    failed: 1,
    held: 1,
    noMatch: 1,
    noKey: 1,
  }]);
  // Without a collector (a caller that does not ask for link health) recording is a no-op.
  assert.doesNotThrow(() => outcomeRecorder(undefined, rules[0])('1', 'linked'));
  // A pair no rule reported on is all zeroes.
  assert.deepEqual(counts(linkHealth(mapping, rules.slice(0, 1), new Map())[0]), { records: 0, withKey: 0, linked: 0, pending: 0, failed: 0, held: 0, noMatch: 0, noKey: 0 });
});
