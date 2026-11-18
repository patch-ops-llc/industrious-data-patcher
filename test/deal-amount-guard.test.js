import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { loadMapping, mappingProblems, normalizeMapping } from '../src/config.js';
import { guardReasons } from '../src/engine/dealAmount.js';
import { executeRun } from '../src/engine/run.js';
import { compactSummary, renderRunMarkdown, summaryLines, writeRunReport } from '../src/report.js';
import { addQuoteFamily, makeHarness, makePortalHarness, P, SHIPPED_MAPPING_FILE, T, TEST_MAPPING_FILE } from './helpers.js';

const amountWrites = (fake) => fake.writes.filter((w) => w.kind === 'update');
const ZERO = 'sets_deal_to_zero';
const LARGE = 'change_over_threshold';
const PERCENT = 'change_over_percent';
const GUARD_DEFAULTS = { holdZeroAmount: true, holdLargeChange: true, largeChangeThreshold: 1_000_000, holdPercentChange: true, percentChangeThreshold: 50, releaseDealIds: [] };

async function holds(h, where = 'true') {
  const { rows } = await h.db.query(
    `SELECT deal_id, header_id, amount_before, amount_after, reasons, first_held_at, last_seen_at, resolved_at, resolution
     FROM deal_amount_holds WHERE ${where} ORDER BY id`,
  );
  return rows;
}

/** One quote with one deal, already seen by a first run, so a later amount change counts as a requote. */
async function seenFamilies(h, families) {
  const out = families.map((f) => addQuoteFamily(h.fake, { customer: 'C', contactNumber: '1', lines: 0, tasks: 0, withContact: false, ...f }));
  h.fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.status, 'ok');
  assert.equal(first.dealAmount.updated, 0);
  h.fake.advance(30);
  return out;
}

function requote(h, ids, amount) {
  h.fake.updateRecord(T.header, ids.header, { quote_amount: amount });
  h.fake.advance(10);
}

const dealAmount = (h, ids) => h.fake.record(T.deal, ids.deal).properties.amount;

test('guard: the shipped mapping holds changes to 0, changes over 1,000,000 and changes over 50%; the settings default to on and are validated', () => {
  const shipped = loadMapping(SHIPPED_MAPPING_FILE);
  const { notes, ...shippedGuard } = shipped.dealAmount.guard;
  assert.deepEqual(shippedGuard, GUARD_DEFAULTS);
  assert.equal(shipped.dealAmount.projection.enabled, true);
  assert.equal(shipped.objects.quoteLine.properties[shipped.dealAmount.projection.lineAmount], 'amount');

  // A mapping written before the guard existed gets it switched on.
  const raw = JSON.parse(fs.readFileSync(TEST_MAPPING_FILE, 'utf8'));
  assert.deepEqual(raw.dealAmount.guard, { holdPercentChange: false });
  delete raw.dealAmount.guard;
  const old = normalizeMapping(structuredClone(raw));
  assert.deepEqual(old.dealAmount.guard, GUARD_DEFAULTS);
  assert.deepEqual(mappingProblems(old), []);

  // Setting one value keeps the defaults of the others.
  const partial = structuredClone(raw);
  partial.dealAmount.guard = { largeChangeThreshold: 250_000 };
  assert.deepEqual(normalizeMapping(partial).dealAmount.guard, { ...GUARD_DEFAULTS, largeChangeThreshold: 250_000 });
  partial.dealAmount.guard = { percentChangeThreshold: 25 };
  assert.deepEqual(normalizeMapping(partial).dealAmount.guard, { ...GUARD_DEFAULTS, percentChangeThreshold: 25 });

  const bad = structuredClone(raw);
  bad.dealAmount.guard = { holdZeroAmount: 'false', holdLargeChange: 0, largeChangeThreshold: '1000000', holdPercentChange: 'yes', percentChangeThreshold: '50', releaseDealIds: ['12', 'x'] };
  bad.dealAmount.projection = { enabled: 'no' };
  const problems = mappingProblems(normalizeMapping(bad)).join('\n');
  assert.match(problems, /guard\.holdZeroAmount must be true or false/);
  assert.match(problems, /guard\.holdLargeChange must be true or false/);
  assert.match(problems, /guard\.largeChangeThreshold must be a number above 0/);
  assert.match(problems, /guard\.holdPercentChange must be true or false/);
  assert.match(problems, /guard\.percentChangeThreshold must be a percentage above 0/);
  assert.match(problems, /guard\.releaseDealIds must be a list of deal record IDs/);
  assert.match(problems, /projection\.enabled must be true or false/);
  for (const threshold of [0, -5, Number.NaN]) {
    const m = structuredClone(raw);
    m.dealAmount.guard = { largeChangeThreshold: threshold };
    assert.match(mappingProblems(normalizeMapping(m)).join('\n'), /largeChangeThreshold must be a number above 0/);
    m.dealAmount.guard = { percentChangeThreshold: threshold };
    assert.match(mappingProblems(normalizeMapping(m)).join('\n'), /percentChangeThreshold must be a percentage above 0/);
  }

  // The projection needs the line amount named in the mapping.
  const noLineAmount = JSON.parse(fs.readFileSync(SHIPPED_MAPPING_FILE, 'utf8'));
  delete noLineAmount.objects.quoteLine.properties.amount;
  assert.match(mappingProblems(normalizeMapping(structuredClone(noLineAmount))).join('\n'), /dealAmount\.projection: objects\.quoteLine\.properties\.amount is not defined/);
  noLineAmount.dealAmount.projection.enabled = false;
  assert.deepEqual(mappingProblems(normalizeMapping(noLineAmount)), []);
});

test('guard: which changes are held, in both directions and exactly at the threshold', () => {
  const cfg = { guard: { holdZeroAmount: true, holdLargeChange: true, largeChangeThreshold: 1_000_000, holdPercentChange: false, percentChangeThreshold: 50, releaseDealIds: ['77'] } };
  const reasons = (from, to, dealId = '1') => guardReasons(cfg, { dealId, from, to });
  assert.deepEqual(reasons('500', '0'), [ZERO]);
  assert.deepEqual(reasons('500', '0.00'), [ZERO]);
  assert.deepEqual(reasons('', '0'), [ZERO]);
  assert.deepEqual(reasons('500', '0.01'), []);
  assert.deepEqual(reasons('100', '1000100'), []);
  assert.deepEqual(reasons('100', '1000100.01'), [LARGE]);
  assert.deepEqual(reasons('2500000', '1500000'), []);
  assert.deepEqual(reasons('2500000', '1499999.99'), [LARGE]);
  assert.deepEqual(reasons('', '1000000'), []);
  assert.deepEqual(reasons('', '1000000.01'), [LARGE]);
  assert.deepEqual(reasons('-600000', '600000'), [LARGE]);
  assert.deepEqual(reasons('1500000', '0'), [ZERO, LARGE]);
  assert.deepEqual(reasons('1500000', '0', '77'), []);
  assert.deepEqual(reasons('1500000', '0', 77), []);
  assert.deepEqual(guardReasons({ guard: { ...cfg.guard, holdZeroAmount: false } }, { dealId: '1', from: '1500000', to: '0' }), [LARGE]);
  assert.deepEqual(guardReasons({ guard: { ...cfg.guard, holdLargeChange: false } }, { dealId: '1', from: '1500000', to: '0' }), [ZERO]);
  assert.deepEqual(guardReasons({ guard: { ...cfg.guard, largeChangeThreshold: 2_000_000 } }, { dealId: '1', from: '1500000', to: '3400000' }), []);
});

test('guard: a requote to 0 is not applied; it is recorded with the deal, the quote and both amounts, shows in every report, and stays there run after run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const [zero, normal] = await seenFamilies(h, [
    { quote: 'Z1', amount: '500', dealAmount: '500' },
    { quote: 'N1', amount: '100', dealAmount: '100' },
  ]);
  requote(h, zero, '0');
  requote(h, normal, '175');

  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.status, 'ok');
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(run.dealAmount.heldCount, 1);
  assert.deepEqual(run.dealAmount.held, [{ dealId: zero.deal, headerId: zero.header, from: '500', to: '0', reasons: [ZERO], heldSince: null }]);
  assert.deepEqual(run.dealAmount.changes, [{ dealId: normal.deal, headerId: normal.header, from: '100', to: '175' }]);
  assert.equal(dealAmount(h, zero), '500');
  assert.equal(dealAmount(h, normal), '175');
  assert.deepEqual(amountWrites(fake).map((w) => w.inputs), [[{ id: normal.deal, properties: { amount: '175' } }]]);

  const [row] = await holds(h);
  assert.deepEqual(
    { deal: row.deal_id, header: row.header_id, before: row.amount_before, after: row.amount_after, reasons: row.reasons, resolved: row.resolved_at },
    { deal: zero.deal, header: zero.header, before: '500', after: '0', reasons: [ZERO], resolved: null },
  );
  const firstHeldAt = new Date(row.first_held_at).toISOString();
  assert.equal(firstHeldAt, run.startedAt);

  const md = renderRunMarkdown(run);
  assert.match(md, /### Deal amount changes held for review/);
  assert.match(md, /held, not applied, when it would set the deal amount to 0, or it moves the deal amount by more than 1000000, up or down \(dealAmount\.guard/);
  assert.match(md, /1 deal amount change\(s\) are held\. The deals were not changed\./);
  assert.ok(md.includes(`| ${zero.deal} | ${zero.header} | 500 | 0 | would set the deal amount to 0 | this run |`));
  assert.match(summaryLines(run).join('\n'), /Deal amounts: 1 updated, held for review 1, failed 0/);
  const files = writeRunReport(h.outputDir, run);
  const csv = fs.readFileSync(files.dealChanges, 'utf8').trim().split('\n');
  assert.equal(csv[0], 'deal_id,quote_header_id,amount_before,amount_after,result,held_since');
  assert.ok(csv.includes(`${normal.deal},${normal.header},100,175,updated,`));
  assert.ok(csv.includes(`${zero.deal},${zero.header},500,0,held: ${ZERO},`));
  assert.equal(compactSummary(run).dealAmount.held.length, 1);
  // The report stored with the run in the staging database carries the held change too.
  const stored = (await h.db.query('SELECT report_markdown, summary FROM runs WHERE id = $1', [run.runId])).rows[0];
  assert.match(stored.report_markdown, /1 deal amount change\(s\) are held/);
  assert.equal(stored.summary.dealAmount.heldCount, 1);

  // Nothing changes in HubSpot: the held change is listed again by every later run, scheduled or reconcile.
  for (const mode of ['incremental', 'full', 'incremental']) {
    fake.advance(30);
    const later = await executeRun(h.ctx(), { mode });
    assert.equal(later.dealAmount.updated, 0);
    assert.deepEqual(later.dealAmount.held, [{ dealId: zero.deal, headerId: zero.header, from: '500', to: '0', reasons: [ZERO], heldSince: firstHeldAt }]);
    assert.ok(renderRunMarkdown(later).includes(`| ${zero.deal} | ${zero.header} | 500 | 0 | would set the deal amount to 0 | ${firstHeldAt} |`));
    assert.match(summaryLines(later).join('\n'), /held for review 1/);
    const rows = await holds(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resolved_at, null);
    assert.equal(new Date(rows[0].first_held_at).toISOString(), firstHeldAt);
    assert.equal(new Date(rows[0].last_seen_at).toISOString(), later.startedAt);
  }
  assert.equal(dealAmount(h, zero), '500');
  assert.equal(amountWrites(fake).length, 1);
  await h.cleanup();
});

test('guard: a change of more than 1,000,000 is held whether the amount goes up or down; exactly 1,000,000 goes through', async () => {
  const h = await makeHarness();
  const [up, down, exact, blank, both, small] = await seenFamilies(h, [
    { quote: 'L1', amount: '1', dealAmount: '1' },
    { quote: 'L2', amount: '7000000', dealAmount: '7000000' },
    { quote: 'L3', amount: '300000', dealAmount: '300000' },
    { quote: 'L4', amount: '5', dealAmount: '' },
    { quote: 'L5', amount: '1500000', dealAmount: '1500000' },
    { quote: 'L6', amount: '900000', dealAmount: '900000' },
  ]);
  requote(h, up, '1946178');
  requote(h, down, '299000');
  requote(h, exact, '1300000');
  requote(h, blank, '1000000.01');
  requote(h, both, '0');
  requote(h, small, '100');

  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  const held = Object.fromEntries(run.dealAmount.held.map((c) => [c.dealId, c]));
  assert.deepEqual(Object.keys(held).sort(), [up.deal, down.deal, blank.deal, both.deal].sort());
  assert.deepEqual(held[up.deal].reasons, [LARGE]);
  assert.deepEqual([held[down.deal].from, held[down.deal].to, held[down.deal].reasons], ['7000000', '299000', [LARGE]]);
  assert.deepEqual([held[blank.deal].from, held[blank.deal].reasons], ['', [LARGE]]);
  assert.deepEqual(held[both.deal].reasons, [ZERO, LARGE]);
  assert.equal(run.dealAmount.updated, 2);
  assert.equal(dealAmount(h, up), '1');
  assert.equal(dealAmount(h, down), '7000000');
  assert.equal(dealAmount(h, exact), '1300000');
  assert.equal(dealAmount(h, blank), '');
  assert.equal(dealAmount(h, both), '1500000');
  assert.equal(dealAmount(h, small), '100');
  const md = renderRunMarkdown(run);
  assert.ok(md.includes(`| ${both.deal} | ${both.header} | 1500000 | 0 | would set the deal amount to 0; moves the deal amount by more than 1000000 |`));
  assert.ok(md.includes(`| ${blank.deal} | ${blank.header} | (blank) | 1000000.01 | moves the deal amount by more than 1000000 |`));
  assert.equal((await holds(h)).length, 4);
  await h.cleanup();
});

test('guard: switching a condition off, raising the threshold, or listing a deal releases the held change; the next run applies it and takes it off the list', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const [zero, zeroToo, large, larger] = await seenFamilies(h, [
    { quote: 'R1', amount: '500', dealAmount: '500' },
    { quote: 'R2', amount: '800', dealAmount: '800' },
    { quote: 'R3', amount: '100', dealAmount: '100' },
    { quote: 'R4', amount: '100', dealAmount: '100' },
  ]);
  requote(h, zero, '0');
  requote(h, zeroToo, '0');
  requote(h, large, '1500100');
  requote(h, larger, '4000100');
  const held = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(held.dealAmount.heldCount, 4);
  assert.equal(held.dealAmount.updated, 0);

  // One deal is released by its ID.
  fake.advance(30);
  h.mapping.dealAmount.guard.releaseDealIds = [zero.deal];
  const one = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(one.dealAmount.updated, 1);
  assert.equal(one.dealAmount.heldCount, 3);
  assert.deepEqual(one.dealAmount.changes, [{ dealId: zero.deal, headerId: zero.header, from: '500', to: '0' }]);
  assert.deepEqual(one.dealAmount.holdsReleased.map((x) => x.dealId), [zero.deal]);
  assert.equal(dealAmount(h, zero), '0');
  assert.equal(dealAmount(h, zeroToo), '800');
  assert.match(renderRunMarkdown(one), /1 change\(s\) held on earlier runs came off the list in this run:/);
  assert.match(renderRunMarkdown(one), /applied: the guard no longer holds it/);
  assert.deepEqual((await holds(h, `deal_id = '${zero.deal}'`)).map((r) => r.resolution), ['applied']);

  // The threshold is raised: the 1.5M change goes through, the 4M change stays held.
  fake.advance(30);
  h.mapping.dealAmount.guard.largeChangeThreshold = 2_000_000;
  const two = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(two.dealAmount.changes.map((c) => c.dealId), [large.deal]);
  assert.equal(dealAmount(h, large), '1500100');
  assert.equal(dealAmount(h, larger), '100');
  assert.deepEqual(two.dealAmount.held.map((c) => c.dealId).sort(), [zeroToo.deal, larger.deal].sort());

  // Each switch releases only its own condition.
  fake.advance(30);
  h.mapping.dealAmount.guard.holdLargeChange = false;
  const three = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(three.dealAmount.changes.map((c) => c.dealId), [larger.deal]);
  assert.deepEqual(three.dealAmount.held.map((c) => c.dealId), [zeroToo.deal]);
  fake.advance(30);
  h.mapping.dealAmount.guard.holdZeroAmount = false;
  const four = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(four.dealAmount.changes.map((c) => c.dealId), [zeroToo.deal]);
  assert.equal(four.dealAmount.heldCount, 0);
  assert.equal(dealAmount(h, zeroToo), '0');
  assert.equal(dealAmount(h, larger), '4000100');
  assert.match(renderRunMarkdown(four), /The guard on deal amount changes is switched off/);

  const rows = await holds(h);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.resolved_at !== null && r.resolution === 'applied'));

  // Once applied, nothing is applied twice and nothing is listed any more.
  fake.advance(30);
  const quiet = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(quiet.dealAmount.updated, 0);
  assert.equal(quiet.dealAmount.heldCount, 0);
  assert.match(renderRunMarkdown(quiet), /No deal amount change is held\./);
  assert.equal(amountWrites(fake).length, 4);
  await h.cleanup();
});

test('guard: a held change comes off the list, and the report says so, when it no longer applies; a new amount that is still caught keeps it on the list', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const [fixedByHand, requoted, stillBad, secondDeal, deleted] = await seenFamilies(h, [
    { quote: 'A1', amount: '500', dealAmount: '500' },
    { quote: 'A2', amount: '600', dealAmount: '600' },
    { quote: 'A3', amount: '700', dealAmount: '700' },
    { quote: 'A4', amount: '800', dealAmount: '800' },
    { quote: 'A5', amount: '900', dealAmount: '900' },
  ]);
  for (const ids of [fixedByHand, requoted, stillBad, secondDeal, deleted]) requote(h, ids, '0');
  const held = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(held.dealAmount.heldCount, 5);
  const since = held.startedAt;

  fake.advance(30);
  // Someone sets the deal to the quote amount by hand.
  fake.updateRecord(T.deal, fixedByHand.deal, { amount: '0' });
  // The quote is requoted to an ordinary amount.
  fake.updateRecord(T.header, requoted.header, { quote_amount: '640' });
  // The quote moves to another amount the guard also catches.
  fake.updateRecord(T.header, stillBad.header, { quote_amount: '2000700' });
  // The quote gets a second deal, so Item B3 no longer acts on it.
  const extra = fake.addRecord(T.deal, { amount: '5' });
  fake.associate(T.header, secondDeal.header, T.deal, extra, 105);
  // The quote is deleted in HubSpot.
  fake.deleteRecord(T.header, deleted.header);
  fake.advance(10);

  const next = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(next.status, 'ok');
  assert.deepEqual(next.dealAmount.held, [{ dealId: stillBad.deal, headerId: stillBad.header, from: '700', to: '2000700', reasons: [LARGE], heldSince: since }]);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: requoted.deal, headerId: requoted.header, from: '600', to: '640' }]);
  assert.deepEqual(next.dealAmount.holdsReleased.map((x) => x.dealId), [requoted.deal]);
  assert.deepEqual(next.dealAmount.holdsNoLongerApply.map((x) => x.dealId).sort(), [fixedByHand.deal, secondDeal.deal, deleted.deal].sort());
  assert.equal(dealAmount(h, secondDeal), '800');
  assert.equal(dealAmount(h, deleted), '900');
  const md = renderRunMarkdown(next);
  assert.match(md, /4 change\(s\) held on earlier runs came off the list in this run:/);
  assert.ok(md.includes(`| ${fixedByHand.deal} | ${fixedByHand.header} | 500 | 0 | ${since} | closed: it no longer applies |`));
  assert.ok(md.includes(`| ${requoted.deal} | ${requoted.header} | 600 | 0 | ${since} | applied: the guard no longer holds it |`));

  const byDeal = Object.fromEntries((await holds(h)).map((r) => [r.deal_id, r]));
  assert.equal(byDeal[fixedByHand.deal].resolution, 'no_longer_applies');
  assert.equal(byDeal[secondDeal.deal].resolution, 'no_longer_applies');
  assert.equal(byDeal[deleted.deal].resolution, 'no_longer_applies');
  assert.equal(byDeal[requoted.deal].resolution, 'applied');
  assert.equal(byDeal[stillBad.deal].resolved_at, null);
  assert.deepEqual([byDeal[stillBad.deal].amount_before, byDeal[stillBad.deal].amount_after, byDeal[stillBad.deal].reasons], ['700', '2000700', [LARGE]]);
  assert.equal(new Date(byDeal[stillBad.deal].first_held_at).toISOString(), since);

  // A change that is held again later starts a new entry; the closed one is kept as history.
  fake.advance(30);
  fake.updateRecord(T.header, requoted.header, { quote_amount: '0' });
  fake.advance(10);
  const again = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(again.dealAmount.held.map((c) => [c.dealId, c.from, c.heldSince]).sort(), [[requoted.deal, '640', null], [stillBad.deal, '700', since]].sort());
  assert.equal((await holds(h, `deal_id = '${requoted.deal}'`)).length, 2);
  assert.equal(await h.count('deal_amount_holds', 'resolved_at IS NULL'), 2);
  await h.cleanup();
});

test('guard: a dry run lists held changes without recording them, and shows what it would do with changes held earlier', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const [zero] = await seenFamilies(h, [{ quote: 'D1', amount: '500', dealAmount: '500' }]);
  requote(h, zero, '0');

  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.dealAmount.planned, 0);
  assert.deepEqual(dry.dealAmount.held, [{ dealId: zero.deal, headerId: zero.header, from: '500', to: '0', reasons: [ZERO], heldSince: null }]);
  assert.match(renderRunMarkdown(dry), /1 deal amount change\(s\) would be held\./);
  assert.match(renderRunMarkdown(dry), /not recorded \(dry run\)/);
  assert.match(summaryLines(dry).join('\n'), /Deal amounts: 0 would be updated, held for review 1, failed 0/);
  assert.equal(await h.count('deal_amount_holds'), 0);
  assert.equal(amountWrites(fake).length, 0);
  assert.equal(dealAmount(h, zero), '500');

  fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(live.dealAmount.heldCount, 1);
  const before = await holds(h);

  // A later dry run lists the recorded hold and leaves the record alone.
  fake.advance(30);
  const dryAgain = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.deepEqual(dryAgain.dealAmount.held.map((c) => c.heldSince), [live.startedAt]);
  assert.deepEqual(await holds(h), before);

  // After the release a dry run says the change would be applied, and still records nothing.
  h.mapping.dealAmount.guard.holdZeroAmount = false;
  fake.advance(30);
  const dryReleased = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dryReleased.dealAmount.planned, 1);
  assert.equal(dryReleased.dealAmount.heldCount, 0);
  assert.match(renderRunMarkdown(dryReleased), /would be applied: the guard no longer holds it/);
  assert.deepEqual(await holds(h), before);
  assert.equal(dealAmount(h, zero), '500');
  assert.equal(amountWrites(fake).length, 0);
  await h.cleanup();
});

test('guard: a released change whose update fails, or is held back by --limit, stays on the list until the deal is really updated', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const [a, b] = await seenFamilies(h, [
    { quote: 'F1', amount: '500', dealAmount: '500' },
    { quote: 'F2', amount: '600', dealAmount: '600' },
  ]);
  requote(h, a, '0');
  requote(h, b, '0');
  assert.equal((await executeRun(h.ctx(), { mode: 'incremental' })).dealAmount.heldCount, 2);

  h.mapping.dealAmount.guard.holdZeroAmount = false;
  fake.advance(30);
  fake.failNext({ method: 'POST', pathIncludes: '/deals/batch/update', status: 400, body: { status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' } });
  const failed = await executeRun(h.ctx(), { mode: 'incremental', limit: 1 });
  assert.equal(failed.dealAmount.failed, 1);
  assert.equal(failed.dealAmount.notAttempted, 1);
  assert.equal(failed.dealAmount.updated, 0);
  assert.deepEqual(failed.dealAmount.holdsReleased, []);
  assert.deepEqual(failed.dealAmount.holdsNoLongerApply, []);
  assert.equal(await h.count('deal_amount_holds', 'resolved_at IS NULL'), 2);

  fake.advance(30);
  const retry = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(retry.dealAmount.updated, 2);
  assert.equal(dealAmount(h, a), '0');
  assert.equal(dealAmount(h, b), '0');
  assert.equal(await h.count('deal_amount_holds', `resolved_at IS NOT NULL AND resolution = 'applied'`), 2);
  await h.cleanup();
});

test('guard: the catch-up is guarded like any other deal amount change, and the guard can be switched off entirely', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const zero = addQuoteFamily(fake, { quote: 'C1', customer: 'C', contactNumber: '1', amount: '0', dealAmount: '900', lines: 0, tasks: 0 });
  const large = addQuoteFamily(fake, { quote: 'C2', customer: 'C', contactNumber: '1', amount: '3000000', dealAmount: '10', lines: 0, tasks: 0 });
  const plain = addQuoteFamily(fake, { quote: 'C3', customer: 'C', contactNumber: '1', amount: '250', dealAmount: '10', lines: 0, tasks: 0 });
  fake.advance(10);

  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full', dealAmounts: true });
  assert.equal(dry.dealAmount.planned, 1);
  assert.equal(dry.dealAmount.heldCount, 2);

  const catchUp = await executeRun(h.ctx(), { mode: 'full', dealAmounts: true });
  assert.deepEqual(catchUp.dealAmount.changes.map((c) => c.dealId), [plain.deal]);
  assert.deepEqual(catchUp.dealAmount.held.map((c) => [c.dealId, c.reasons]).sort(), [[zero.deal, [ZERO]], [large.deal, [LARGE]]].sort());
  assert.equal(dealAmount(h, zero), '900');
  assert.equal(dealAmount(h, large), '10');
  assert.equal(dealAmount(h, plain), '250');

  // The held changes stay listed on scheduled runs, which otherwise leave old mismatches alone.
  fake.advance(30);
  const scheduled = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(scheduled.dealAmount.heldCount, 2);
  assert.equal(scheduled.dealAmount.updated, 0);

  h.mapping.dealAmount.guard.holdZeroAmount = false;
  h.mapping.dealAmount.guard.holdLargeChange = false;
  fake.advance(30);
  const off = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(off.dealAmount.updated, 2);
  assert.equal(off.dealAmount.heldCount, 0);
  assert.equal(dealAmount(h, zero), '0');
  assert.equal(dealAmount(h, large), '3000000');
  await h.cleanup();
});

// ---- projection (dry run) ---------------------------------------------------

const READ_ONLY = /\/(search|batch\/read)$/;

function quoteWithLines(fake, { quote, uid, amount, dealAmount = amount, linked = [], orphans = [], deal = true, associateDeal = true }) {
  const ids = { linked: [], orphans: [] };
  fake.addRecord(P.company, { customer_uid: uid, epicor_customer_id: uid, epicor_customer_number: `9${uid}` });
  if (deal) ids.deal = fake.addRecord(P.deal, { amount: dealAmount, hs_is_closed: 'false' });
  ids.quote = fake.addRecord(P.quote, { quote_number: quote, customer_uid: uid, shipping_customer_id: `9${uid}`, hubspot_deal_id: '', amount });
  if (deal && associateDeal) fake.associate(P.quote, ids.quote, P.deal, ids.deal, 99);
  linked.forEach((lineAmount, i) => {
    const id = fake.addRecord(P.line, { quote_number: quote, quote_line: String(i + 1), amount: lineAmount });
    fake.associate(P.line, id, P.quote, ids.quote, 98);
    ids.linked.push(id);
  });
  orphans.forEach((lineAmount, i) => ids.orphans.push(fake.addRecord(P.line, { quote_number: quote, quote_line: String(100 + i), amount: lineAmount })));
  return ids;
}

test('projection: a dry run lists the deals whose amount would change once lines are linked, with before and after, and marks the ones the guard would hold', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const up = quoteWithLines(fake, { quote: '700', uid: '1', amount: '1000', linked: ['600', '400'], orphans: ['450.25'] });
  const blankToZero = quoteWithLines(fake, { quote: '701', uid: '2', amount: '', dealAmount: '800', orphans: ['0', '0'] });
  const huge = quoteWithLines(fake, { quote: '702', uid: '3', amount: '1', linked: ['1'], orphans: ['1946177'] });
  const equal = quoteWithLines(fake, { quote: '703', uid: '4', amount: '', dealAmount: '300', orphans: ['100', '200'] });
  const noDeal = quoteWithLines(fake, { quote: '704', uid: '5', amount: '50', linked: ['50'], orphans: ['25'], deal: false });
  const unchanged = quoteWithLines(fake, { quote: '705', uid: '6', amount: '90', linked: ['90'], orphans: [''] });
  const closed = quoteWithLines(fake, { quote: '706', uid: '7', amount: '500', linked: ['500'], orphans: ['-120'] });
  fake.updateRecord(P.deal, closed.deal, { hs_is_closed: 'true' });
  // The deal is found by its quote number in this same run.
  const byNumber = quoteWithLines(fake, { quote: '707', uid: '8', amount: '', dealAmount: '60', orphans: ['75'], associateDeal: false });
  fake.updateRecord(P.deal, byNumber.deal, { quote_num: '707' });
  // Two deals: Item B3 does not act.
  const twoDeals = quoteWithLines(fake, { quote: '708', uid: '9', amount: '20', linked: ['20'], orphans: ['5'] });
  fake.associate(P.quote, twoDeals.quote, P.deal, fake.addRecord(P.deal, { amount: '1' }), 99);
  // Nothing to link: not part of the projection.
  quoteWithLines(fake, { quote: '709', uid: '10', amount: '40', dealAmount: '70', linked: ['40'] });
  fake.advance(60);

  const requestsBefore = fake.requests.length;
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(dry.status, 'ok');
  const p = dry.dealAmount.projection;
  assert.equal(p.linesToLink, 11);
  assert.equal(p.headersGainingLines, 9);
  assert.equal(p.headersWithAmountChange, 8);
  assert.equal(p.headersUnchanged, 1);
  assert.equal(p.inSync, 1);
  assert.equal(p.wouldUpdate, 2);
  assert.equal(p.heldCount, 2);
  assert.equal(p.closedSkippedCount, 1);
  assert.deepEqual(p.skipped, { no_deal: 1, header_has_multiple_deals: 1, deal_has_multiple_headers: 0, header_amount_blank: 0, deal_closed: 1, deal_not_found: 0 });
  const byDeal = Object.fromEntries(p.changes.map((c) => [c.dealId, c]));
  assert.deepEqual(Object.keys(byDeal).sort(), [up.deal, blankToZero.deal, huge.deal, closed.deal, byNumber.deal].sort());
  assert.deepEqual(byDeal[up.deal], { dealId: up.deal, headerId: up.quote, from: '1000', to: '1450.25', dealClosed: false, headerAmountNow: '1000', held: false, reasons: [], skippedClosed: false });
  assert.deepEqual(byDeal[blankToZero.deal], { dealId: blankToZero.deal, headerId: blankToZero.quote, from: '800', to: '0', dealClosed: false, headerAmountNow: '', held: true, reasons: [ZERO, PERCENT], skippedClosed: false });
  assert.deepEqual([byDeal[huge.deal].from, byDeal[huge.deal].to, byDeal[huge.deal].held, byDeal[huge.deal].reasons], ['1', '1946178', true, [LARGE, PERCENT]]);
  // The closed deal is listed, marked as left alone.
  assert.deepEqual([byDeal[closed.deal].to, byDeal[closed.deal].dealClosed, byDeal[closed.deal].held, byDeal[closed.deal].skippedClosed], ['380', true, false, true]);
  assert.deepEqual([byDeal[byNumber.deal].from, byDeal[byNumber.deal].to, byDeal[byNumber.deal].held], ['60', '75', false]);
  assert.equal(equal.deal in byDeal, false);
  assert.equal(noDeal.quote !== undefined && unchanged.quote !== undefined, true);

  // The run's own deal amount section is unchanged by the projection, and nothing was written or recorded.
  assert.equal(dry.dealAmount.planned, 0);
  assert.equal(dry.dealAmount.heldCount, 0);
  assert.equal(fake.writes.length, 0);
  for (const req of fake.requests.slice(requestsBefore)) {
    assert.ok(req.method === 'GET' || (req.method === 'POST' && READ_ONLY.test(req.path)), `${req.method} ${req.path}`);
  }
  assert.equal(await h.count('deal_amount_holds'), 0);
  assert.equal(await h.count('deal_amount_baselines'), 0);

  const md = renderRunMarkdown(dry);
  assert.match(md, /### Projected deal amount changes once lines are linked/);
  assert.match(md, /A live run would link 11 line\(s\) to 9 quote header\(s\)\./);
  assert.match(md, /Deals that would be updated: 2 up \(\+465\.25\), 0 down \(0\), net 465\.25\. Held changes and closed deals are not in these totals\./);
  assert.ok(md.includes(`| ${up.deal} | ${up.quote} | open | 1000 | 1450.25 | 450.25 | 45 | would be updated |`));
  assert.ok(md.includes(`| ${closed.deal} | ${closed.quote} | closed | 500 | 380 | -120 | 24 | not changed: the deal is closed |`));
  assert.ok(md.includes(`| ${blankToZero.deal} | ${blankToZero.quote} | open | 800 | 0 | -800 | 100 | HELD: would set the deal amount to 0; changes the deal amount by more than 50% |`));
  assert.ok(md.includes(`| ${huge.deal} | ${huge.quote} | open | 1 | 1946178 | 1946177 | 194617700 | HELD: moves the deal amount by more than 1000000; changes the deal amount by more than 50% |`));
  assert.ok(!md.includes('- deal_closed:'));
  assert.match(md, /the projection further down works them out from the line amounts/);
  assert.match(summaryLines(dry).join('\n'), /Projected once lines are linked: 2 deal amount\(s\) would be updated, 2 held for review, 1 closed deal\(s\) left alone/);

  const files = writeRunReport(h.outputDir, dry);
  const csv = fs.readFileSync(files.projectedDealChanges, 'utf8').trim().split('\n');
  assert.equal(csv[0], 'deal_id,quote_header_id,deal_state,quote_amount_now,deal_amount_before,deal_amount_after,change,change_percent,result');
  assert.equal(csv.length, 6);
  assert.ok(csv.includes(`${up.deal},${up.quote},open,1000,1000,1450.25,450.25,45,would_update`));
  assert.ok(csv.includes(`${closed.deal},${closed.quote},closed,500,500,380,-120,24,skipped: deal is closed`));
  assert.ok(csv.includes(`${blankToZero.deal},${blankToZero.quote},open,,800,0,-800,100,held: ${ZERO}; ${PERCENT}`));
  assert.ok(csv.includes(`${huge.deal},${huge.quote},open,1,1,1946178,1946177,194617700,held: ${LARGE}; ${PERCENT}`));
  // The stored run keeps the totals, not the rows.
  assert.equal(compactSummary(dry).dealAmount.projection.wouldUpdate, 2);
  assert.equal(compactSummary(dry).dealAmount.projection.changes, undefined);

  // The live run then does what was projected: lines are linked, HubSpot recalculates the quote
  // amounts (set here the way the rollup would), and the next run updates or holds the same deals.
  const live = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(live.dealAmount.projection, null);
  assert.equal(h.rule(live, 'lines_to_header').created, 11);
  const rollup = { [up.quote]: '1450.25', [blankToZero.quote]: '0', [huge.quote]: '1946178', [equal.quote]: '300', [noDeal.quote]: '75', [closed.quote]: '380', [byNumber.quote]: '75', [twoDeals.quote]: '25' };
  for (const [id, amount] of Object.entries(rollup)) fake.record(P.quote, id).properties.amount = amount;
  fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  const pick = (rows) => rows.map((c) => [c.dealId, c.headerId, c.from, c.to]).sort();
  assert.deepEqual(pick(next.dealAmount.changes), pick(p.changes.filter((c) => !c.held && !c.skippedClosed)));
  assert.deepEqual(pick(next.dealAmount.held), pick(p.changes.filter((c) => c.held)));
  assert.deepEqual(pick(next.dealAmount.closedSkipped), pick(p.changes.filter((c) => c.skippedClosed)));
  assert.deepEqual(next.dealAmount.held.map((c) => c.reasons).sort(), p.changes.filter((c) => c.held).map((c) => c.reasons).sort());
  assert.equal(next.dealAmount.inSync, p.inSync);
  assert.equal(fake.record(P.deal, closed.deal).properties.amount, '500');
  assert.equal(fake.record(P.deal, up.deal).properties.amount, '1450.25');
  assert.equal(fake.record(P.deal, blankToZero.deal).properties.amount, '800');
  assert.equal(fake.record(P.deal, huge.deal).properties.amount, '1');
  await h.cleanup();
});

test('projection: only in dry runs with lines to link; it can be switched off, respects --limit, and is left out when the mapping does not name the line amount', async () => {
  const setup = async (options) => {
    const h = await makePortalHarness(options);
    quoteWithLines(h.fake, { quote: '720', uid: '1', amount: '100', linked: ['100'], orphans: ['30'] });
    quoteWithLines(h.fake, { quote: '721', uid: '2', amount: '200', linked: ['200'], orphans: ['60'] });
    h.fake.advance(60);
    return h;
  };

  const off = await setup({ mutateMapping: (m) => { m.dealAmount.projection.enabled = false; } });
  const offRun = await executeRun(off.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(offRun.dealAmount.projection, null);
  assert.doesNotMatch(renderRunMarkdown(offRun), /Projected deal amount changes/);
  assert.match(renderRunMarkdown(offRun), /so they are not in the table above\./);
  assert.equal(writeRunReport(off.outputDir, offRun).projectedDealChanges, undefined);
  await off.cleanup();

  const unmapped = await setup({ mutateMapping: (m) => { delete m.objects.quoteLine.properties.amount; } });
  assert.equal((await executeRun(unmapped.ctx({ dryRun: true }), { mode: 'full' })).dealAmount.projection, null);
  await unmapped.cleanup();

  const h = await setup();
  const limited = await executeRun(h.ctx({ dryRun: true }), { mode: 'full', limit: 1 });
  assert.equal(limited.dealAmount.projection.linesToLink, 1);
  assert.equal(limited.dealAmount.projection.wouldUpdate, 1);
  assert.equal(limited.dealAmount.projection.linksTruncated, true);
  assert.match(renderRunMarkdown(limited), /only the lines within the limit are projected/);

  const live = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(live.dealAmount.projection, null);
  assert.doesNotMatch(renderRunMarkdown(live), /Projected deal amount changes/);
  // With every line linked there is nothing left to project.
  h.fake.advance(30);
  const dryAfter = await executeRun(h.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(dryAfter.dealAmount.projection, null);
  await h.cleanup();
});
