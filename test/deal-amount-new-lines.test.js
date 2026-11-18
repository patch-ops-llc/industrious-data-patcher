import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { loadMapping, mappingProblems, normalizeMapping } from '../src/config.js';
import { guardReasons } from '../src/engine/dealAmount.js';
import { executeRun } from '../src/engine/run.js';
import { changePercent, renderRunMarkdown, summaryLines, writeRunReport } from '../src/report.js';
import { makePortalHarness, P, SHIPPED_MAPPING_FILE, TEST_MAPPING_FILE } from './helpers.js';

// Zach, 2026-11-13: "lets not change those closed deals or change any amounts
// unless there are new lines and the amount isn't wildly different".

const PERCENT = 'change_over_percent';
const ZERO = 'sets_deal_to_zero';
const LARGE = 'change_over_threshold';
const amountWrites = (fake) => fake.writes.filter((w) => w.kind === 'update');
const dealAmount = (fake, ids) => fake.record(P.deal, ids.deal).properties.amount;

let seq = 0;
/** One quote with one associated deal. */
function quote(fake, { number, amount = '1000', dealAmount: deal = amount, closed = false }) {
  seq += 1;
  const uid = `U${seq}`;
  const ids = {};
  ids.company = fake.addRecord(P.company, { customer_uid: uid, epicor_customer_id: uid, epicor_customer_number: `N${seq}` });
  ids.deal = fake.addRecord(P.deal, { amount: deal, hs_is_closed: closed ? 'true' : 'false' });
  ids.quote = fake.addRecord(P.quote, { quote_number: number, customer_uid: uid, shipping_customer_id: `N${seq}`, hubspot_deal_id: ids.deal, amount });
  fake.associate(P.quote, ids.quote, P.deal, ids.deal, 99);
  fake.associate(P.quote, ids.quote, P.company, ids.company, 95);
  return ids;
}

/** A line arriving from Jitterbit. associated: HubSpot's own workflow has already linked it to the quote. */
function lineArrives(fake, number, ids, { associated = false, amount = '100' } = {}) {
  seq += 1;
  const id = fake.addRecord(P.line, { quote_number: number, quote_line: String(seq), amount });
  if (associated) fake.associate(P.line, id, P.quote, ids.quote, 98);
  return id;
}

/** HubSpot recalculating the rollup amount of a quote: the amount changes, the record is not stamped as modified. */
function rollup(fake, ids, amount) {
  fake.record(P.quote, ids.quote).properties.amount = amount;
}

async function run(h, options = {}) {
  const summary = await executeRun(h.ctx(options.ctx), { mode: 'incremental', ...options.run });
  assert.equal(summary.status, options.status || 'ok');
  return summary;
}

/** A harness whose quotes have been seen by a first live run. */
async function started(quotes, options) {
  const h = await makePortalHarness(options);
  const ids = quotes.map((q) => quote(h.fake, q));
  h.fake.advance(10);
  const first = await run(h);
  assert.equal(first.dealAmount.updated, 0);
  h.fake.advance(30);
  return { h, fake: h.fake, ids };
}

test('new rules: the shipped mapping never touches closed deals, needs a new line, and holds changes over 50%; a mapping that leaves the settings out gets the same', () => {
  const shipped = loadMapping(SHIPPED_MAPPING_FILE);
  assert.equal(shipped.dealAmount.skipClosedDeals, true);
  assert.equal(shipped.dealAmount.requireNewLines, true);
  assert.equal(shipped.dealAmount.newLinesWindowMinutes, 120);
  assert.equal(shipped.dealAmount.guard.holdPercentChange, true);
  assert.equal(shipped.dealAmount.guard.percentChangeThreshold, 50);
  assert.equal(shipped.dealAmount.backfillInFullRun, false);
  assert.deepEqual(mappingProblems(shipped), []);

  const raw = JSON.parse(fs.readFileSync(SHIPPED_MAPPING_FILE, 'utf8'));
  const bare = structuredClone(raw);
  for (const key of ['skipClosedDeals', 'requireNewLines', 'newLinesWindowMinutes', 'guard']) delete bare.dealAmount[key];
  const normal = normalizeMapping(bare);
  assert.equal(normal.dealAmount.skipClosedDeals, true);
  assert.equal(normal.dealAmount.requireNewLines, true);
  assert.equal(normal.dealAmount.newLinesWindowMinutes, 120);
  assert.equal(normal.dealAmount.guard.holdPercentChange, true);
  assert.equal(normal.dealAmount.guard.percentChangeThreshold, 50);
  assert.deepEqual(mappingProblems(normal), []);

  const problemsOf = (mutate) => {
    const m = structuredClone(raw);
    mutate(m);
    return mappingProblems(normalizeMapping(m)).join('\n');
  };
  // "New lines" needs to know which rule links lines to the quote, and that rule has to be on.
  assert.match(problemsOf((m) => { delete m.dealAmount.amountDependsOnRule; m.dealAmount.projection.enabled = false; }), /dealAmount\.requireNewLines needs dealAmount\.amountDependsOnRule/);
  assert.match(problemsOf((m) => { m.rules.find((r) => r.id === 'lines_to_header').enabled = false; }), /dealAmount\.requireNewLines needs the rule "lines_to_header" to be enabled/);
  assert.equal(problemsOf((m) => { delete m.dealAmount.amountDependsOnRule; m.dealAmount.projection.enabled = false; m.dealAmount.requireNewLines = false; }), '');
  assert.match(problemsOf((m) => { m.dealAmount.requireNewLines = 'yes'; }), /dealAmount\.requireNewLines must be true or false/);
  assert.match(problemsOf((m) => { m.dealAmount.skipClosedDeals = 'no'; }), /dealAmount\.skipClosedDeals must be true or false/);
  assert.match(problemsOf((m) => { m.dealAmount.newLinesWindowMinutes = -1; }), /dealAmount\.newLinesWindowMinutes must be a number of minutes, 0 or more/);
  assert.match(problemsOf((m) => { m.dealAmount.newLinesWindowMinutes = '120'; }), /dealAmount\.newLinesWindowMinutes must be a number of minutes, 0 or more/);
  // Never touching closed deals needs the deal property that says a deal is closed.
  assert.match(problemsOf((m) => { delete m.objects.deal.properties.isClosed; }), /dealAmount: objects\.deal\.properties\.isClosed is not defined/);

  // The generic test mapping switches the new rules off by name, so the older tests keep testing those settings.
  const generic = JSON.parse(fs.readFileSync(TEST_MAPPING_FILE, 'utf8'));
  assert.deepEqual([generic.dealAmount.skipClosedDeals, generic.dealAmount.requireNewLines, generic.dealAmount.guard.holdPercentChange], [false, false, false]);
});

test('percent guard: more than 50% of the deal\'s current amount is held, up or down; exactly 50% goes through; a deal at 0 or blank has no percentage and is held', () => {
  const guard = { holdZeroAmount: false, holdLargeChange: false, largeChangeThreshold: 1_000_000, holdPercentChange: true, percentChangeThreshold: 50, releaseDealIds: ['77'] };
  const reasons = (from, to, dealId = '1', overrides = {}) => guardReasons({ guard: { ...guard, ...overrides } }, { dealId, from, to });
  assert.deepEqual(reasons('100', '150'), []);
  assert.deepEqual(reasons('100', '150.01'), [PERCENT]);
  assert.deepEqual(reasons('100', '50'), []);
  assert.deepEqual(reasons('100', '49.99'), [PERCENT]);
  assert.deepEqual(reasons('1000', '1499.99'), []);
  assert.deepEqual(reasons('200000', '90000'), [PERCENT]);
  assert.deepEqual(reasons('1', '8288'), [PERCENT]);
  // The percentage is taken of the size of the current amount, so a negative amount works the same way.
  assert.deepEqual(reasons('-100', '-150'), []);
  assert.deepEqual(reasons('-100', '-151'), [PERCENT]);
  assert.deepEqual(reasons('-100', '100'), [PERCENT]);
  // No percentage exists for a deal at 0 or without an amount: any change is held.
  assert.deepEqual(reasons('0', '5'), [PERCENT]);
  assert.deepEqual(reasons('', '5'), [PERCENT]);
  assert.deepEqual(reasons('0.00', '0.01'), [PERCENT]);
  assert.deepEqual(reasons('0', '0'), []);
  // Settings: another percentage, the switch, and the per-deal release.
  assert.deepEqual(reasons('100', '130', '1', { percentChangeThreshold: 25 }), [PERCENT]);
  assert.deepEqual(reasons('100', '125', '1', { percentChangeThreshold: 25 }), []);
  assert.deepEqual(reasons('100', '900', '1', { percentChangeThreshold: 1000 }), []);
  assert.deepEqual(reasons('100', '900', '1', { holdPercentChange: false }), []);
  assert.deepEqual(reasons('100', '900', '77'), []);
  assert.deepEqual(reasons('100', '900', 77), []);
  // Together with the other two holds.
  const all = { holdZeroAmount: true, holdLargeChange: true };
  assert.deepEqual(reasons('500', '0', '1', all), [ZERO, PERCENT]);
  assert.deepEqual(reasons('3000000', '4200000', '1', all), [LARGE]);
  assert.deepEqual(reasons('300000', '2100000', '1', all), [LARGE, PERCENT]);
  assert.deepEqual(reasons('1500000', '0', '1', all), [ZERO, LARGE, PERCENT]);

  assert.equal(changePercent('100', '150'), 50);
  assert.equal(changePercent('1000', '875.5'), 12.5);
  assert.equal(changePercent('0', '5'), '');
  assert.equal(changePercent('', '5'), '');
});

test('new lines: a line that arrived since the last run and is already on its quote lets the deal follow, in the same run when HubSpot has recalculated and in a later run when it has not', async () => {
  const { h, fake, ids: [fast, slow] } = await started([{ number: '900' }, { number: '901', amount: '2000' }]);

  // Two lines arrive; HubSpot's own workflow links them. One quote amount is already recalculated.
  lineArrives(fake, '900', fast, { associated: true });
  lineArrives(fake, '901', slow, { associated: true });
  rollup(fake, fast, '1100');
  fake.advance(10);
  const first = await run(h);
  assert.equal(h.rule(first, 'lines_to_header').created, 0);
  assert.equal(first.dealAmount.headersWithArrivedLines, 2);
  assert.deepEqual(first.dealAmount.changes, [{ dealId: fast.deal, headerId: fast.quote, from: '1000', to: '1100' }]);
  assert.equal(first.dealAmount.headersChangedWithoutNewLines, 0);
  assert.equal(dealAmount(fake, fast), '1100');
  assert.equal(dealAmount(fake, slow), '2000');

  // The second quote is recalculated later; no line arrives in that run.
  rollup(fake, slow, '2300');
  fake.advance(30);
  const second = await run(h);
  assert.equal(second.dealAmount.headersWithArrivedLines, 0);
  assert.deepEqual(second.dealAmount.changes, [{ dealId: slow.deal, headerId: slow.quote, from: '2000', to: '2300' }]);
  assert.equal(dealAmount(fake, slow), '2300');

  // Once that change has been dealt with, a further amount change without a new line is left alone.
  rollup(fake, slow, '2500');
  fake.updateRecord(P.quote, slow.quote, { quote_number: '901' });
  fake.advance(30);
  const third = await run(h);
  assert.equal(third.dealAmount.updated, 0);
  assert.equal(third.dealAmount.headersChangedWithoutNewLines, 1);
  assert.equal(dealAmount(fake, slow), '2300');
  assert.equal(amountWrites(fake).length, 2);
  await h.cleanup();
});

test('new lines: an amount that changes with no new line is recorded and left alone, in scheduled runs and in reconcile; a line that was only modified is not a new line', async () => {
  const { h, fake, ids: [requoted, edited] } = await started([{ number: '910' }, { number: '911', amount: '500' }]);
  const existing = lineArrives(fake, '911', edited, { associated: true });
  fake.advance(10);
  await run(h);
  rollup(fake, edited, '500');
  fake.advance(200);
  await run(h);

  fake.updateRecord(P.quote, requoted.quote, { amount: '1200' });
  // An existing line is changed in Epicor and upserted again: modified, not created.
  fake.updateRecord(P.line, existing, { amount: '250' });
  fake.updateRecord(P.quote, edited.quote, { amount: '650' });
  fake.advance(10);
  const next = await run(h);
  assert.equal(next.dealAmount.headersWithAmountChange, 2);
  assert.equal(next.dealAmount.headersChangedWithoutNewLines, 2);
  assert.equal(next.dealAmount.headersWithArrivedLines, 0);
  assert.equal(next.dealAmount.updated, 0);
  assert.equal(next.dealAmount.heldCount, 0);
  assert.equal(dealAmount(fake, requoted), '1000');
  assert.equal(dealAmount(fake, edited), '500');
  assert.match(renderRunMarkdown(next), /A deal amount only follows its quote when the quote gained a new line: a line this run linked, or a line that arrived since the previous run \(dealAmount\.requireNewLines\)\. 2 quote header\(s\) changed amount without gaining a line; the new amount was recorded and the deal left alone\./);
  assert.match(summaryLines(next).join('\n'), /Deal amounts: 0 updated, held for review 0, failed 0, closed deals left alone 0, quote amount changes without a new line 2/);
  // The new amounts are recorded, so the difference is not picked up later either.
  const recorded = await h.baselines();
  assert.deepEqual([recorded[requoted.quote].amount, recorded[edited.quote].amount], ['1200', '650']);
  for (const mode of ['incremental', 'full', 'incremental']) {
    fake.advance(30);
    const later = await run(h, { run: { mode } });
    assert.equal(later.dealAmount.updated, 0);
    assert.equal(later.dealAmount.headersWithAmountChange, 0);
  }
  assert.equal(amountWrites(fake).length, 0);
  await h.cleanup();
});

test('new lines: the amount change has to show up within newLinesWindowMinutes of the quote gaining the line', async () => {
  for (const [windowMinutes, updated] of [[120, 0], [240, 1]]) {
    const { h, fake, ids: [q] } = await started([{ number: '920' }], { mutateMapping: (m) => { m.dealAmount.newLinesWindowMinutes = windowMinutes; } });
    lineArrives(fake, '920', q);
    fake.advance(10);
    const linked = await run(h);
    assert.equal(h.rule(linked, 'lines_to_header').created, 1);
    assert.equal(linked.dealAmount.headersWithLinesLinked, 1);

    // The quote is read again on every run while the mark lasts.
    fake.advance(60);
    assert.equal((await run(h)).dealAmount.updated, 0);

    // HubSpot only comes up with the new amount 180 minutes after the line was linked.
    fake.advance(110);
    rollup(fake, q, '1300');
    fake.updateRecord(P.quote, q.quote, { quote_number: '920' });
    fake.advance(10);
    const late = await run(h);
    assert.equal(late.dealAmount.updated, updated, `window ${windowMinutes}`);
    assert.equal(late.dealAmount.headersChangedWithoutNewLines, 1 - updated);
    assert.equal(dealAmount(fake, q), updated ? '1300' : '1000');
    await h.cleanup();
  }
});

test('new lines: on a new staging database nothing counts as newly arrived, and a dry run or a failed run in between does not use up a line\'s arrival', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const q = quote(fake, { number: '930' });
  // A line created a minute before the very first run, already linked by HubSpot.
  lineArrives(fake, '930', q, { associated: true });
  fake.advance(1);
  const first = await run(h);
  assert.equal(first.dealAmount.headersWithArrivedLines, 0);
  assert.equal(first.dealAmount.arrivalsSince, null);
  assert.match(renderRunMarkdown(first), /No earlier live run is recorded in this staging database, so no line counts as arrived since the previous run/);
  assert.equal(first.dealAmount.headersFirstSeen, 1);
  rollup(fake, q, '1100');
  fake.updateRecord(P.quote, q.quote, { quote_number: '930' });
  fake.advance(30);
  const second = await run(h);
  assert.equal(second.dealAmount.updated, 0);
  assert.equal(second.dealAmount.headersChangedWithoutNewLines, 1);
  assert.equal(dealAmount(fake, q), '1000');

  // A line arrives. First a dry run sees it, then a run fails, then a live run.
  fake.advance(30);
  lineArrives(fake, '930', q, { associated: true });
  rollup(fake, q, '1250');
  fake.advance(10);
  const dry = await run(h, { ctx: { dryRun: true } });
  assert.equal(dry.dealAmount.headersWithArrivedLines, 1);
  assert.equal(dry.dealAmount.arrivalsSince, second.startedAt);
  assert.ok(renderRunMarkdown(dry).includes(`Lines first read after ${second.startedAt}, the start of the last live run, count as arrived: 1 quote header(s) have such a line.`));
  assert.equal(dry.dealAmount.planned, 1);
  assert.equal(amountWrites(fake).length, 0);

  fake.advance(30);
  fake.failNext({ pathIncludes: '/search', status: 500, times: 50 });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'failed');
  fake.failures.length = 0;

  fake.advance(30);
  const live = await run(h);
  assert.equal(live.dealAmount.headersWithArrivedLines, 1);
  assert.deepEqual(live.dealAmount.changes, [{ dealId: q.deal, headerId: q.quote, from: '1000', to: '1250' }]);
  assert.equal(dealAmount(fake, q), '1250');

  // Counted once: the next run does not see the line as arrived again.
  fake.advance(30);
  assert.equal((await run(h)).dealAmount.headersWithArrivedLines, 0);
  await h.cleanup();
});

test('new lines: a deal update that fails or is held back by --limit is tried again on the next run without needing another new line', async () => {
  const { h, fake, ids: [a, b] } = await started([{ number: '940' }, { number: '941', amount: '2000' }]);
  lineArrives(fake, '940', a);
  lineArrives(fake, '941', b);
  fake.advance(10);
  assert.equal(h.rule(await run(h), 'lines_to_header').created, 2);
  rollup(fake, a, '1200');
  rollup(fake, b, '2400');
  fake.advance(30);
  fake.failNext({ method: 'POST', pathIncludes: '/deals/batch/update', status: 400, body: { status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' } });
  const failed = await run(h, { run: { limit: 1 }, status: 'completed_with_errors' });
  assert.equal(failed.dealAmount.failed, 1);
  assert.equal(failed.dealAmount.notAttempted, 1);
  assert.equal(failed.dealAmount.updated, 0);

  fake.advance(30);
  const retry = await run(h);
  assert.equal(retry.dealAmount.headersWithLinesLinked, 0);
  assert.equal(retry.dealAmount.headersWithArrivedLines, 0);
  assert.equal(retry.dealAmount.updated, 2);
  assert.equal(dealAmount(fake, a), '1200');
  assert.equal(dealAmount(fake, b), '2400');
  await h.cleanup();
});

test('new lines: lines linked by a run that fails before it reaches the deal amounts still count on the next run', async () => {
  const { h, fake, ids: [q] } = await started([{ number: '945' }]);
  lineArrives(fake, '945', q);
  fake.advance(10);
  // The lines are linked, then reading the quotes for the deal amounts fails.
  fake.failNext({ method: 'POST', pathIncludes: h.ctx().api.paths.batchRead(P.quote), status: 500, times: 50 });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(fake.associated(P.quote, q.quote, P.line).length, 1);
  fake.failures.length = 0;

  rollup(fake, q, '1350');
  fake.advance(30);
  const next = await run(h);
  assert.equal(h.rule(next, 'lines_to_header').created, 0);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: q.deal, headerId: q.quote, from: '1000', to: '1350' }]);
  assert.equal(dealAmount(fake, q), '1350');
  await h.cleanup();
});

test('new lines: a backlog line linked by a run that then fails is still remembered as a new line on the next run', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  // The line is in HubSpot from the start; its quote is not yet.
  seq += 1;
  const orphan = fake.addRecord(P.line, { quote_number: '946', quote_line: String(seq), amount: '300' });
  fake.advance(10);
  const first = await run(h);
  assert.equal(h.rule(first, 'lines_to_header').noTarget, 1);

  // The quote arrives. The run links the old line to it, then fails before the deal amounts.
  fake.advance(30);
  const q = quote(fake, { number: '946' });
  fake.advance(10);
  fake.failNext({ method: 'POST', pathIncludes: h.ctx().api.paths.batchRead(P.quote), status: 500, times: 50 });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(fake.associated(P.line, orphan, P.quote), [q.quote]);
  fake.failures.length = 0;

  // The line did not arrive since the last run and is not linked by this run; the mark saved when it was linked carries it.
  rollup(fake, q, '1300');
  fake.advance(30);
  const next = await run(h);
  assert.equal(h.rule(next, 'lines_to_header').created, 0);
  assert.equal(next.dealAmount.headersWithArrivedLines, 0);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: q.deal, headerId: q.quote, from: '1000', to: '1300' }]);
  assert.equal(dealAmount(fake, q), '1300');
  await h.cleanup();
});

test('percent guard in a run: a change over 50% is held and stays listed without new lines, exactly 50% goes through, and listing the deal ID releases it', async () => {
  const { h, fake, ids: [wild, edge, fromZero] } = await started([{ number: '950' }, { number: '951' }, { number: '952', amount: '', dealAmount: '0' }]);
  for (const [number, ids] of [['950', wild], ['951', edge], ['952', fromZero]]) lineArrives(fake, number, ids);
  fake.advance(10);
  assert.equal(h.rule(await run(h), 'lines_to_header').created, 3);
  rollup(fake, wild, '1600');
  rollup(fake, edge, '1500');
  rollup(fake, fromZero, '400');
  fake.advance(30);

  const held = await run(h);
  assert.deepEqual(held.dealAmount.changes, [{ dealId: edge.deal, headerId: edge.quote, from: '1000', to: '1500' }]);
  assert.deepEqual(held.dealAmount.held.map((c) => [c.dealId, c.from, c.to, c.reasons]).sort(), [
    [wild.deal, '1000', '1600', [PERCENT]],
    [fromZero.deal, '0', '400', [PERCENT]],
  ].sort());
  assert.equal(dealAmount(fake, wild), '1000');
  assert.equal(dealAmount(fake, fromZero), '0');
  const md = renderRunMarkdown(held);
  assert.match(md, /or it changes the deal amount by more than 50% of what the deal carries now \(any change, when the deal carries 0 or nothing\) \(dealAmount\.guard in the mapping\)/);
  assert.ok(md.includes(`| ${wild.deal} | ${wild.quote} | 1000 | 1600 | changes the deal amount by more than 50% | this run |`));
  const csv = fs.readFileSync(writeRunReport(h.outputDir, held).dealChanges, 'utf8');
  assert.ok(csv.includes(`${wild.deal},${wild.quote},1000,1600,held: ${PERCENT},`));
  assert.equal(await h.count('deal_amount_holds', 'resolved_at IS NULL'), 2);

  // Still listed on later runs, although no line arrives any more.
  for (const mode of ['incremental', 'full']) {
    fake.advance(150);
    const later = await run(h, { run: { mode } });
    assert.equal(later.dealAmount.updated, 0);
    assert.equal(later.dealAmount.heldCount, 2);
    assert.ok(later.dealAmount.held.every((c) => c.heldSince === held.startedAt));
  }

  // Released per deal ID: that deal is updated, the other stays held.
  h.mapping.dealAmount.guard.releaseDealIds = [wild.deal];
  fake.advance(30);
  const released = await run(h);
  assert.deepEqual(released.dealAmount.changes, [{ dealId: wild.deal, headerId: wild.quote, from: '1000', to: '1600' }]);
  assert.equal(released.dealAmount.heldCount, 1);
  assert.equal(released.dealAmount.holdsReleased.length, 1);
  assert.equal(dealAmount(fake, wild), '1600');
  assert.equal(dealAmount(fake, fromZero), '0');
  const rows = (await h.db.query('SELECT deal_id, resolution FROM deal_amount_holds ORDER BY id')).rows;
  assert.deepEqual(rows.map((r) => [r.deal_id, r.resolution]).sort(), [[wild.deal, 'applied'], [fromZero.deal, null]].sort());

  // Raising the percentage does not release a deal at 0; switching the percent hold off does.
  h.mapping.dealAmount.guard.percentChangeThreshold = 5000;
  fake.advance(30);
  assert.equal((await run(h)).dealAmount.heldCount, 1);
  h.mapping.dealAmount.guard.holdPercentChange = false;
  fake.advance(30);
  const off = await run(h);
  assert.equal(off.dealAmount.updated, 1);
  assert.equal(dealAmount(fake, fromZero), '400');
  assert.equal(await h.count('deal_amount_holds', 'resolved_at IS NULL'), 0);
  await h.cleanup();
});

test('closed deals: a held change whose deal closes comes off the list without being applied, also when it is released afterwards', async () => {
  const { h, fake, ids: [q] } = await started([{ number: '960' }]);
  lineArrives(fake, '960', q);
  fake.advance(10);
  await run(h);
  rollup(fake, q, '1900');
  fake.advance(30);
  assert.equal((await run(h)).dealAmount.heldCount, 1);

  fake.updateRecord(P.deal, q.deal, { hs_is_closed: 'true' });
  h.mapping.dealAmount.guard.releaseDealIds = [q.deal];
  fake.advance(30);
  const closed = await run(h);
  assert.equal(closed.dealAmount.updated, 0);
  assert.equal(closed.dealAmount.heldCount, 0);
  assert.equal(closed.dealAmount.skipped.deal_closed, 1);
  assert.equal(closed.dealAmount.holdsNoLongerApply.length, 1);
  assert.equal(dealAmount(fake, q), '1000');
  assert.equal((await h.db.query('SELECT resolution FROM deal_amount_holds')).rows[0].resolution, 'no_longer_applies');
  assert.equal(amountWrites(fake).length, 0);
  await h.cleanup();
});

test('closed deals: with skipClosedDeals off, the dry-run projection lists a closed deal as an update, marked as closed', async () => {
  for (const skip of [true, false]) {
    const h = await makePortalHarness({ mutateMapping: (m) => { m.dealAmount.skipClosedDeals = skip; } });
    const { fake } = h;
    const q = quote(fake, { number: '965', closed: true });
    lineArrives(fake, '965', q, { associated: true, amount: '1000' });
    lineArrives(fake, '965', q, { amount: '200' });
    fake.advance(10);
    const dry = await run(h, { ctx: { dryRun: true }, run: { mode: 'full' } });
    const p = dry.dealAmount.projection;
    assert.deepEqual(p.changes.map((c) => [c.dealId, c.from, c.to, c.dealClosed, c.held, c.skippedClosed]), [[q.deal, '1000', '1200', true, false, skip]]);
    assert.deepEqual([p.wouldUpdate, p.closedSkippedCount, p.skipped.deal_closed], skip ? [0, 1, 1] : [1, 0, 0]);
    assert.equal(fake.writes.length, 0);
    await h.cleanup();
  }
});

test('catch-up: reconcile --deal-amounts needs no new lines, but still leaves closed deals alone and holds what the guard catches; it stays off unless asked for', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const small = quote(fake, { number: '970', amount: '1000', dealAmount: '900' });
  const closed = quote(fake, { number: '971', amount: '1000', dealAmount: '900', closed: true });
  const wild = quote(fake, { number: '972', amount: '1000', dealAmount: '100' });
  const same = quote(fake, { number: '973', amount: '1000', dealAmount: '1000' });
  fake.advance(10);
  for (const mode of ['full', 'incremental', 'full']) {
    const plain = await run(h, { run: { mode } });
    assert.equal(plain.dealAmount.backfill, false);
    assert.equal(plain.dealAmount.updated, 0);
    fake.advance(30);
  }
  assert.equal(amountWrites(fake).length, 0);

  const catchUp = await run(h, { run: { mode: 'full', dealAmounts: true } });
  assert.equal(catchUp.dealAmount.backfill, true);
  assert.deepEqual(catchUp.dealAmount.changes, [{ dealId: small.deal, headerId: small.quote, from: '900', to: '1000' }]);
  assert.equal(catchUp.dealAmount.skipped.deal_closed, 1);
  assert.deepEqual(catchUp.dealAmount.closedSkipped, [{ dealId: closed.deal, headerId: closed.quote, from: '900', to: '1000' }]);
  assert.deepEqual(catchUp.dealAmount.held.map((c) => [c.dealId, c.reasons]), [[wild.deal, [PERCENT]]]);
  assert.equal(catchUp.dealAmount.inSync, 1);
  assert.equal(dealAmount(fake, small), '1000');
  assert.equal(dealAmount(fake, closed), '900');
  assert.equal(dealAmount(fake, wild), '100');
  assert.equal(dealAmount(fake, same), '1000');
  await h.cleanup();
});

test('settings: with requireNewLines off every quote amount change reaches the deal again, still within the guard and never on a closed deal', async () => {
  const { h, fake, ids: [open, closed, wild] } = await started(
    [{ number: '980' }, { number: '981', closed: true }, { number: '982' }],
    { mutateMapping: (m) => { m.dealAmount.requireNewLines = false; } },
  );
  for (const [ids, amount] of [[open, '1300'], [closed, '1300'], [wild, '1700']]) fake.updateRecord(P.quote, ids.quote, { amount });
  fake.advance(10);
  const next = await run(h);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: open.deal, headerId: open.quote, from: '1000', to: '1300' }]);
  assert.equal(next.dealAmount.skipped.deal_closed, 1);
  assert.deepEqual(next.dealAmount.held.map((c) => c.dealId), [wild.deal]);
  assert.equal(next.dealAmount.headersChangedWithoutNewLines, 0);
  assert.ok(!renderRunMarkdown(next).includes('dealAmount.requireNewLines'));
  await h.cleanup();
});
