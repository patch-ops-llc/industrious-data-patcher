import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelDealAmountRelease, openDealAmountHolds, releaseDealAmountHolds } from '../src/db/store.js';
import { guardReasons } from '../src/engine/dealAmount.js';
import { executeRun } from '../src/engine/run.js';
import { compactSummary, renderRunMarkdown } from '../src/report.js';
import { addQuoteFamily, makeHarness, T } from './helpers.js';

const amountWrites = (fake) => fake.writes.filter((w) => w.kind === 'update');
const dealAmount = (h, ids) => h.fake.record(T.deal, ids.deal).properties.amount;

async function holdRows(h, where = 'true') {
  const { rows } = await h.db.query(
    `SELECT id, deal_id, amount_after, resolved_at, resolution, released_at, released_amount FROM deal_amount_holds WHERE ${where} ORDER BY id`,
  );
  return rows;
}

/** Quotes with one deal each, seen by a first run, then requoted so that the guard holds every change. */
async function heldChanges(h, families) {
  const out = families.map((f) => addQuoteFamily(h.fake, { customer: 'C', contactNumber: '1', lines: 0, tasks: 0, withContact: false, quote: f.quote, amount: f.amount, dealAmount: f.amount }));
  h.fake.advance(10);
  assert.equal((await executeRun(h.ctx(), { mode: 'incremental' })).status, 'ok');
  h.fake.advance(30);
  families.forEach((f, i) => h.fake.updateRecord(T.header, out[i].header, { quote_amount: f.to }));
  h.fake.advance(10);
  const held = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(held.dealAmount.heldCount, families.length);
  assert.equal(held.dealAmount.updated, 0);
  h.fake.advance(30);
  return out;
}

const openHold = async (h, ids) => (await openDealAmountHolds(h.db)).find((hold) => hold.dealId === ids.deal);

test('release: the guard lets a released change through for that deal, that quote and that amount only', () => {
  const cfg = { guard: { holdZeroAmount: true, holdLargeChange: true, largeChangeThreshold: 1000, holdPercentChange: true, percentChangeThreshold: 50, releaseDealIds: [] } };
  const change = { dealId: '7', headerId: '70', from: '100', to: '5000' };
  assert.deepEqual(guardReasons(cfg, change), ['change_over_threshold', 'change_over_percent']);
  assert.deepEqual(guardReasons(cfg, change, new Map()), ['change_over_threshold', 'change_over_percent']);
  assert.deepEqual(guardReasons(cfg, change, new Map([['7', { headerId: '70', amount: '5000' }]])), []);
  assert.deepEqual(guardReasons(cfg, change, new Map([['7', { headerId: '70', amount: '5000.00' }]])), []);
  // Another amount, another quote, another deal: still held.
  assert.equal(guardReasons(cfg, change, new Map([['7', { headerId: '70', amount: '5001' }]])).length, 2);
  assert.equal(guardReasons(cfg, change, new Map([['7', { headerId: '71', amount: '5000' }]])).length, 2);
  assert.equal(guardReasons(cfg, change, new Map([['8', { headerId: '70', amount: '5000' }]])).length, 2);
  assert.equal(guardReasons(cfg, change, new Map([['7', { headerId: '70', amount: '' }]])).length, 2);
  // A released change to 0 goes through as well.
  assert.deepEqual(guardReasons(cfg, { ...change, to: '0' }, new Map([['7', { headerId: '70', amount: '0' }]])), []);
});

test('release: a change released on the admin page is applied by the next live run, and only that change', async () => {
  const h = await makeHarness();
  const [released, other] = await heldChanges(h, [
    { quote: 'L1', amount: '500', to: '0' },
    { quote: 'L2', amount: '800', to: '0' },
  ]);
  const hold = await openHold(h, released);
  assert.equal(hold.releasedAt, null);
  assert.equal(hold.releasedAmount, null);

  // Releasing writes to the staging database only.
  const writesBefore = h.fake.writes.length;
  const done = await releaseDealAmountHolds(h.db, { items: [{ id: hold.id, amount: '0' }], now: h.fake.clock });
  assert.deepEqual(done.map((x) => [x.dealId, x.releasedAmount]), [[released.deal, '0']]);
  assert.equal(h.fake.writes.length, writesBefore);
  assert.equal(dealAmount(h, released), '500');
  assert.equal((await openHold(h, released)).releasedAmount, '0');
  // Released once: a second release of the same hold changes nothing.
  assert.deepEqual(await releaseDealAmountHolds(h.db, { items: [{ id: hold.id, amount: '0' }], now: h.fake.clock }), []);

  // A dry run reports what the release would do and leaves it in place.
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.dealAmount.planned, 1);
  assert.equal(dry.dealAmount.heldCount, 1);
  assert.match(renderRunMarkdown(dry), /would be applied: released on the admin page/);
  assert.equal(dealAmount(h, released), '500');
  assert.equal((await openHold(h, released)).releasedAmount, '0');

  h.fake.advance(30);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.status, 'ok');
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(run.dealAmount.heldCount, 1);
  assert.deepEqual(run.dealAmount.changes, [{ dealId: released.deal, headerId: released.header, from: '500', to: '0' }]);
  assert.deepEqual(run.dealAmount.holdsReleased.map((x) => [x.dealId, x.releasedOnPage]), [[released.deal, true]]);
  assert.deepEqual(run.dealAmount.releasesLapsed, []);
  assert.equal(dealAmount(h, released), '0');
  assert.equal(dealAmount(h, other), '800');
  assert.deepEqual(amountWrites(h.fake).flatMap((w) => w.inputs), [{ id: released.deal, properties: { amount: '0' } }]);
  assert.match(renderRunMarkdown(run), /applied: released on the admin page/);
  assert.equal(compactSummary(run).dealAmount.holdsReleased[0].releasedOnPage, true);

  const [row] = await holdRows(h, `deal_id = '${released.deal}'`);
  assert.equal(row.resolution, 'applied');
  assert.equal(row.released_amount, '0');
  assert.ok(row.released_at);
  const [kept] = await holdRows(h, `deal_id = '${other.deal}'`);
  assert.equal(kept.resolved_at, null);
  assert.equal(kept.released_at, null);

  // Nothing more happens on the run after.
  h.fake.advance(30);
  const after = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(after.dealAmount.updated, 0);
  assert.equal(after.dealAmount.heldCount, 1);
  assert.equal(amountWrites(h.fake).length, 1);
  await h.cleanup();
});

test('release: it is for the amount that was approved; when the quote amount moves the change is held again and the release is dropped', async () => {
  const h = await makeHarness();
  const [moved, eased] = await heldChanges(h, [
    { quote: 'M1', amount: '500', to: '0' },
    { quote: 'M2', amount: '500', to: '0' },
  ]);
  const holds = await openDealAmountHolds(h.db);
  assert.equal((await releaseDealAmountHolds(h.db, { items: holds.map((x) => ({ id: x.id, amount: '0' })), now: h.fake.clock })).length, 2);

  // Requoted before the next run: one to an amount the guard still holds, one to an amount it lets through.
  h.fake.updateRecord(T.header, moved.header, { quote_amount: '5000000' });
  h.fake.updateRecord(T.header, eased.header, { quote_amount: '600' });
  h.fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.heldCount, 1);
  assert.deepEqual(run.dealAmount.releasesLapsed.map((x) => x.dealId), [moved.deal]);
  assert.equal(dealAmount(h, moved), '500');
  assert.match(renderRunMarkdown(run), /1 change\(s\) released on the admin page stayed held: the quote amount is no longer the amount that was released/);
  const [still] = await holdRows(h, `deal_id = '${moved.deal}'`);
  assert.equal(still.resolved_at, null);
  assert.equal(still.amount_after, '5000000');
  assert.equal(still.released_at, null);
  assert.equal(still.released_amount, null);

  // The other went through on its own: applied, but not because of the release.
  assert.equal(dealAmount(h, eased), '600');
  assert.deepEqual(run.dealAmount.holdsReleased.map((x) => [x.dealId, x.releasedOnPage]), [[eased.deal, false]]);
  assert.match(renderRunMarkdown(run), /applied: the guard no longer holds it/);
  const [gone] = await holdRows(h, `deal_id = '${eased.deal}'`);
  assert.equal(gone.resolution, 'applied');
  assert.equal(gone.released_at, null);

  // The lapsed release does not come back: the next run still holds the change.
  h.fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(next.dealAmount.heldCount, 1);
  assert.deepEqual(next.dealAmount.releasesLapsed, []);
  assert.equal(dealAmount(h, moved), '500');
  await h.cleanup();
});

test('release: it can be taken back before a run applies it, is refused for an amount that is no longer the held one, and is dropped when the hold ends by itself', async () => {
  const h = await makeHarness();
  const [cancelled, stale, fixed] = await heldChanges(h, [
    { quote: 'N1', amount: '500', to: '0' },
    { quote: 'N2', amount: '500', to: '0' },
    { quote: 'N3', amount: '500', to: '0' },
  ]);
  const hold = await openHold(h, cancelled);
  await releaseDealAmountHolds(h.db, { items: [{ id: hold.id, amount: '0' }], now: h.fake.clock });
  assert.equal((await cancelDealAmountRelease(h.db, hold.id)).dealId, cancelled.deal);
  assert.equal(await cancelDealAmountRelease(h.db, hold.id), null);
  assert.equal((await openHold(h, cancelled)).releasedAt, null);

  // The amount on the form is not the amount held now: nothing is released.
  const staleHold = await openHold(h, stale);
  assert.deepEqual(await releaseDealAmountHolds(h.db, { items: [{ id: staleHold.id, amount: '12' }, { id: '999999', amount: '0' }], now: h.fake.clock }), []);
  assert.deepEqual(await releaseDealAmountHolds(h.db, { items: [], now: h.fake.clock }), []);

  // Released, then the deal is corrected by hand to the quote amount: the hold just ends.
  const fixedHold = await openHold(h, fixed);
  await releaseDealAmountHolds(h.db, { items: [{ id: fixedHold.id, amount: '0' }], now: h.fake.clock });
  h.fake.updateRecord(T.deal, fixed.deal, { amount: '0' });
  h.fake.advance(10);

  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 0);
  assert.equal(run.dealAmount.heldCount, 2);
  assert.equal(amountWrites(h.fake).length, 0);
  assert.equal(dealAmount(h, cancelled), '500');
  assert.equal(dealAmount(h, stale), '500');
  const [ended] = await holdRows(h, `deal_id = '${fixed.deal}'`);
  assert.equal(ended.resolution, 'no_longer_applies');
  assert.equal(ended.released_at, null);
  // An applied or closed hold can be neither released nor cancelled.
  assert.deepEqual(await releaseDealAmountHolds(h.db, { items: [{ id: fixedHold.id, amount: '0' }], now: h.fake.clock }), []);
  assert.equal(await cancelDealAmountRelease(h.db, fixedHold.id), null);
  await h.cleanup();
});

test('release: an update that fails keeps the release, and the next run applies it', async () => {
  const h = await makeHarness();
  const [ids] = await heldChanges(h, [{ quote: 'F1', amount: '500', to: '0' }]);
  const hold = await openHold(h, ids);
  await releaseDealAmountHolds(h.db, { items: [{ id: hold.id, amount: '0' }], now: h.fake.clock });

  h.fake.failNext({ method: 'POST', pathIncludes: '/deals/batch/update', status: 400, body: { status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' } });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.dealAmount.failed, 1);
  assert.equal(dealAmount(h, ids), '500');
  assert.equal((await openHold(h, ids)).releasedAmount, '0');

  h.fake.advance(30);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(dealAmount(h, ids), '0');
  assert.deepEqual(run.dealAmount.holdsReleased.map((x) => x.releasedOnPage), [true]);
  await h.cleanup();
});
