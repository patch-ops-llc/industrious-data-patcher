import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeRun } from '../src/engine/run.js';
import { addQuoteFamily, makeHarness, T } from './helpers.js';

const amountWrites = (fake) => fake.writes.filter((w) => w.kind === 'update');

test('B3: a header seen for the first time only has its amount recorded; a later requote updates the deal amount and nothing else', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1', amount: '500', dealAmount: '400' });

  fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.dealAmount.headersFirstSeen, 1);
  assert.equal(first.dealAmount.updated, 0);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '400');
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '500', recheck: null } });

  // Requote: Jitterbit upserts the header with a new amount.
  fake.advance(30);
  fake.updateRecord(T.header, ids.header, { quote_amount: '650.50' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.dealAmount.headersWithAmountChange, 1);
  assert.equal(second.dealAmount.updated, 1);
  assert.deepEqual(second.dealAmount.changes, [{ dealId: ids.deal, headerId: ids.header, from: '400', to: '650.50' }]);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '650.50');
  const updates = amountWrites(fake);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].inputs, [{ id: ids.deal, properties: { amount: '650.50' } }]);
  assert.equal(updates[0].type, 'deals');

  // A header change that is not an amount change leaves the deal alone,
  // even if someone has since edited the deal amount by hand.
  fake.updateRecord(T.deal, ids.deal, { amount: '700' });
  fake.advance(30);
  fake.updateRecord(T.header, ids.header, { epicor_cust_id: 'C1' });
  fake.updateRecord(T.header, ids.header, { some_other_field: 'x' });
  fake.advance(10);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(third.dealAmount.headersChecked, 1);
  assert.equal(third.dealAmount.headersWithAmountChange, 0);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '700');
  assert.equal(amountWrites(fake).length, 1);
  await h.cleanup();
});

test('B3: dry run reports the deal amount change and writes nothing; the baseline is not moved', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q2', customer: 'C2', contactNumber: '1', amount: '100', dealAmount: '100' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(30);
  fake.updateRecord(T.header, ids.header, { quote_amount: '250' });
  fake.advance(10);

  const writesBefore = fake.writes.length;
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.dealAmount.planned, 1);
  assert.equal(dry.dealAmount.updated, 0);
  assert.deepEqual(dry.dealAmount.changes, [{ dealId: ids.deal, headerId: ids.header, from: '100', to: '250' }]);
  assert.equal(fake.writes.length, writesBefore);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '100');
  assert.equal((await h.baselines())[ids.header].amount, '100');

  // The dry run already copied the changed header into staging. The live run
  // still sees the change, because it compares with the recorded amount.
  fake.advance(30);

  const live = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(live.ingest.quoteHeader.records, 0);
  assert.equal(live.dealAmount.updated, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '250');
  assert.equal((await h.baselines())[ids.header].amount, '250');
  await h.cleanup();
});

test('B3: headers with more than one deal, deals with more than one header, blank amounts and headers without a deal are skipped and counted', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const twoDeals = fake.addRecord(T.header, { epicor_quote_num: 'QA', quote_amount: '10' });
  const dealA1 = fake.addRecord(T.deal, { amount: '1' });
  const dealA2 = fake.addRecord(T.deal, { amount: '1' });
  fake.associate(T.header, twoDeals, T.deal, dealA1, 105);
  fake.associate(T.header, twoDeals, T.deal, dealA2, 105);

  const shared1 = fake.addRecord(T.header, { epicor_quote_num: 'QB1', quote_amount: '10' });
  const shared2 = fake.addRecord(T.header, { epicor_quote_num: 'QB2', quote_amount: '10' });
  const sharedDeal = fake.addRecord(T.deal, { amount: '1' });
  fake.associate(T.header, shared1, T.deal, sharedDeal, 105);
  fake.associate(T.header, shared2, T.deal, sharedDeal, 105);

  const blank = fake.addRecord(T.header, { epicor_quote_num: 'QC', quote_amount: '10' });
  const blankDeal = fake.addRecord(T.deal, { amount: '1' });
  fake.associate(T.header, blank, T.deal, blankDeal, 105);

  const noDeal = fake.addRecord(T.header, { epicor_quote_num: 'QD', quote_amount: '10' });

  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(30);
  for (const id of [twoDeals, shared1, noDeal]) fake.updateRecord(T.header, id, { quote_amount: '20' });
  fake.updateRecord(T.header, blank, { quote_amount: '' });
  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });

  assert.equal(run.dealAmount.headersWithAmountChange, 4);
  assert.deepEqual(run.dealAmount.skipped, {
    no_deal: 1,
    header_has_multiple_deals: 1,
    deal_has_multiple_headers: 1,
    header_amount_blank: 1,
    deal_closed: 0,
    deal_not_found: 0,
  });
  assert.equal(run.dealAmount.updated, 0);
  for (const id of [dealA1, dealA2, sharedDeal, blankDeal]) assert.equal(fake.record(T.deal, id).properties.amount, '1');
  await h.cleanup();
});

test('B3: skipClosedDeals leaves closed deals alone when switched on', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.skipClosedDeals = true; } });
  const { fake } = h;
  const open = addQuoteFamily(fake, { quote: 'QO', customer: 'C', contactNumber: '1', amount: '5', dealAmount: '5' });
  const closed = addQuoteFamily(fake, { quote: 'QX', customer: 'C', contactNumber: '1', amount: '5', dealAmount: '5', withCompany: false, withContact: false });
  fake.updateRecord(T.deal, closed.deal, { hs_is_closed: 'true' });
  fake.updateRecord(T.deal, open.deal, { hs_is_closed: 'false' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(30);
  fake.updateRecord(T.header, open.header, { quote_amount: '9' });
  fake.updateRecord(T.header, closed.header, { quote_amount: '9' });
  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(run.dealAmount.skipped.deal_closed, 1);
  assert.equal(fake.record(T.deal, open.deal).properties.amount, '9');
  assert.equal(fake.record(T.deal, closed.deal).properties.amount, '5');
  await h.cleanup();
});

test('B3: when the header amount is a rollup of its lines, linking a newly arrived line makes the header get re-checked and the deal updated', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.amountDependsOnRule = 'lines_to_header'; } });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QR', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 1 });
  fake.associate(T.line, ids.lines[0], T.header, ids.header, 101);
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '100', recheck: null } });

  // A late line arrives. HubSpot recalculates the rollup some time after the
  // line is associated; the fake models that by changing the amount without
  // touching the header's modified date.
  fake.advance(30);
  const late = fake.addRecord(T.line, { epicor_quote_num: 'QR' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(second, 'lines_to_header').created, 1);
  assert.deepEqual(fake.associated(T.line, late, T.header), [ids.header]);
  assert.equal(second.ingest.quoteHeader.records, 0);
  assert.equal(second.dealAmount.updated, 0);
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '100', recheck: 'check' } });

  const record = fake.record(T.header, ids.header);
  record.properties.quote_amount = '180';

  fake.advance(40);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(third.ingest.quoteHeader.records, 0);
  assert.equal(third.dealAmount.headersWithAmountChange, 1);
  assert.equal(third.dealAmount.updated, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '180');
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '180', recheck: null } });
  await h.cleanup();
});

test('B3: a changed line makes its header get read again even when the header itself does not show up as modified', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.amountDependsOnRule = 'lines_to_header'; } });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QL', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 1 });
  fake.associate(T.line, ids.lines[0], T.header, ids.header, 101);
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });

  // Jitterbit changes the line (price change); the rollup follows without the header's modified date moving.
  fake.advance(30);
  fake.updateRecord(T.line, ids.lines[0], { some_price: '5' });
  fake.record(T.header, ids.header).properties.quote_amount = '140';
  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.ingest.quoteHeader.records, 0);
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '140');
  await h.cleanup();
});

for (const mode of ['record_only', 'update_deals']) {
  test(`B3: lines linked while clearing the backlog (${mode}): the new header amount ${mode === 'record_only' ? 'is recorded and the deal is left alone' : 'is pushed to the deal'}`, async () => {
    const h = await makeHarness({
      mutateMapping: (m) => {
        m.dealAmount.amountDependsOnRule = 'lines_to_header';
        m.dealAmount.backlogLinkedLines = mode;
      },
    });
    const { fake } = h;
    // The quote and its deal are associated; one of its lines never was (the backlog).
    const ids = addQuoteFamily(fake, { quote: 'QB', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 2 });
    fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
    fake.associate(T.line, ids.lines[0], T.header, ids.header, 101);
    fake.advance(60 * 24 * 30);

    const reconcile = await executeRun(h.ctx(), { mode: 'full' });
    assert.equal(h.rule(reconcile, 'lines_to_header').created, 1);
    assert.equal(reconcile.dealAmount.backlog, mode === 'record_only');
    assert.equal(reconcile.dealAmount.updated, 0);
    assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '100', recheck: mode === 'record_only' ? 'record_only' : 'check' } });

    if (mode === 'record_only') {
      // The next run comes before HubSpot has recalculated the rollup: nothing to record yet, the flag stays.
      fake.advance(5);
      const early = await executeRun(h.ctx(), { mode: 'incremental' });
      assert.equal(early.dealAmount.headersRecordedOnly, 0);
      assert.equal((await h.baselines())[ids.header].recheck, 'record_only');
    }

    // HubSpot recalculates the rollup now that the second line is associated.
    fake.record(T.header, ids.header).properties.quote_amount = '180';
    fake.advance(30);
    const next = await executeRun(h.ctx(), { mode: 'incremental' });
    if (mode === 'record_only') {
      assert.equal(next.dealAmount.headersRecordedOnly, 1);
      assert.equal(next.dealAmount.updated, 0);
      assert.equal(fake.record(T.deal, ids.deal).properties.amount, '100');
      assert.equal(amountWrites(fake).length, 0);
      // Still inside the settle time (120 minutes by default): the header stays "record only".
      assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '180', recheck: 'record_only' } });
      // A second recalculation inside the settle time is recorded the same way, even on a full run.
      fake.record(T.header, ids.header).properties.quote_amount = '185';
      fake.advance(30);
      const again = await executeRun(h.ctx(), { mode: 'incremental' });
      assert.equal(again.dealAmount.headersRecordedOnly, 1);
      assert.equal(fake.record(T.deal, ids.deal).properties.amount, '100');
      // Once the settle time has passed the flag is dropped.
      fake.advance(60);
      const settled = await executeRun(h.ctx(), { mode: 'incremental' });
      assert.equal(settled.dealAmount.updated, 0);
      assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '185', recheck: null } });
      assert.equal(amountWrites(fake).length, 0);
    } else {
      assert.equal(next.dealAmount.updated, 1);
      assert.equal(fake.record(T.deal, ids.deal).properties.amount, '180');
      assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '180', recheck: null } });
    }

    // Either way, a real requote afterwards updates the deal.
    fake.advance(30);
    fake.updateRecord(T.header, ids.header, { quote_amount: '210' });
    fake.advance(10);
    const requote = await executeRun(h.ctx(), { mode: 'incremental' });
    assert.equal(requote.dealAmount.updated, 1);
    assert.equal(fake.record(T.deal, ids.deal).properties.amount, '210');
    await h.cleanup();
  });
}

test('B3: backlogSettleMinutes 0 keeps a backlog header "record only" for the next run only', async () => {
  const h = await makeHarness({
    mutateMapping: (m) => {
      m.dealAmount.amountDependsOnRule = 'lines_to_header';
      m.dealAmount.backlogLinkedLines = 'record_only';
      m.dealAmount.backlogSettleMinutes = 0;
    },
  });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QZ', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 1 });
  fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'full' });
  fake.record(T.header, ids.header).properties.quote_amount = '150';
  fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(next.dealAmount.headersRecordedOnly, 1);
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '150', recheck: null } });
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '100');
  await h.cleanup();
});

test('B3: a new line that arrives for a backlog header inside the settle time does not end the "record only" hold', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.amountDependsOnRule = 'lines_to_header'; m.dealAmount.backlogLinkedLines = 'record_only'; } });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QH', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 1 });
  fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'full' });
  assert.equal((await h.baselines())[ids.header].recheck, 'record_only');

  fake.advance(30);
  fake.addRecord(T.line, { epicor_quote_num: 'QH' });
  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(run, 'lines_to_header').created, 1);
  assert.equal(run.dealAmount.backlog, false);
  assert.equal((await h.baselines())[ids.header].recheck, 'record_only');
  await h.cleanup();
});

test('B3: with "record_only" the very first live run counts as clearing the backlog even when it is a scheduled run', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.amountDependsOnRule = 'lines_to_header'; m.dealAmount.backlogLinkedLines = 'record_only'; } });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QS', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 1 });
  fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  fake.advance(10);

  // Dry runs and --limit runs before it do not end the backlog phase.
  await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.dealAmount.backlog, true);
  assert.equal((await h.baselines())[ids.header].recheck, 'record_only');

  fake.record(T.header, ids.header).properties.quote_amount = '130';
  fake.advance(30);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.dealAmount.backlog, false);
  assert.equal(second.dealAmount.headersRecordedOnly, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '100');
  await h.cleanup();
});

test('B3: a failed deal update is reported, alerts through the run status, and is retried on the next run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QF', customer: 'C', contactNumber: '1', amount: '10', dealAmount: '10' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(30);
  fake.updateRecord(T.header, ids.header, { quote_amount: '30' });
  fake.advance(10);

  fake.failNext({ method: 'POST', pathIncludes: '/deals/batch/update', status: 400, body: { status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' } });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'completed_with_errors');
  assert.equal(failed.dealAmount.failed, 1);
  assert.match(failed.dealAmount.failures[0].error, /not valid/);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '10');
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '10', recheck: 'check' } });

  fake.advance(40);
  const retry = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(retry.status, 'ok');
  assert.equal(retry.dealAmount.updated, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '30');
  await h.cleanup();
});

test('B3: a full run only records amounts unless the catch-up is asked for; the catch-up sets every differing deal amount', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const same = addQuoteFamily(fake, { quote: 'Q10', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100.00' });
  const differs = addQuoteFamily(fake, { quote: 'Q11', customer: 'C', contactNumber: '1', amount: '200', dealAmount: '150', withCompany: false, withContact: false });
  const noAmountOnDeal = addQuoteFamily(fake, { quote: 'Q12', customer: 'C', contactNumber: '1', amount: '300', dealAmount: '', withCompany: false, withContact: false });

  const plain = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(plain.dealAmount.backfill, false);
  assert.equal(plain.dealAmount.headersFirstSeen, 3);
  assert.equal(plain.dealAmount.updated, 0);
  assert.equal(fake.record(T.deal, differs.deal).properties.amount, '150');
  assert.equal(Object.keys(await h.baselines()).length, 3);

  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full', dealAmounts: true });
  assert.equal(dry.dealAmount.backfill, true);
  assert.equal(dry.dealAmount.planned, 2);
  assert.equal(dry.dealAmount.inSync, 1);
  assert.equal(fake.record(T.deal, differs.deal).properties.amount, '150');

  const live = await executeRun(h.ctx(), { mode: 'full', dealAmounts: true });
  assert.equal(live.dealAmount.updated, 2);
  assert.equal(live.dealAmount.inSync, 1);
  assert.equal(fake.record(T.deal, same.deal).properties.amount, '100.00');
  assert.equal(fake.record(T.deal, differs.deal).properties.amount, '200');
  assert.equal(fake.record(T.deal, noAmountOnDeal.deal).properties.amount, '300');
  await h.cleanup();
});

test('B3: backfillInFullRun is the catch-up as a setting: off unless set, and when true only the reconcile command sets differing deal amounts', async () => {
  for (const setting of [undefined, false, true]) {
    const h = await makeHarness({
      mutateMapping: (m) => {
        if (setting === undefined) delete m.dealAmount.backfillInFullRun;
        else m.dealAmount.backfillInFullRun = setting;
      },
    });
    const { fake } = h;
    const ids = addQuoteFamily(fake, { quote: 'Q50', customer: 'C', contactNumber: '1', amount: '200', dealAmount: '150' });
    fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
    fake.advance(10);

    // Scheduled runs never catch up, whatever the setting says.
    for (let i = 0; i < 2; i += 1) {
      const scheduled = await executeRun(h.ctx(), { mode: 'incremental' });
      assert.equal(scheduled.dealAmount.backfill, false);
      assert.equal(scheduled.dealAmount.updated, 0);
      fake.advance(30);
    }
    assert.equal(fake.record(T.deal, ids.deal).properties.amount, '150');

    const reconcile = await executeRun(h.ctx(), { mode: 'full' });
    assert.equal(reconcile.dealAmount.backfill, setting === true);
    assert.equal(reconcile.dealAmount.updated, setting === true ? 1 : 0);
    assert.equal(fake.record(T.deal, ids.deal).properties.amount, setting === true ? '200' : '150');
    assert.equal(amountWrites(fake).length, setting === true ? 1 : 0);
    await h.cleanup();
  }
});

test('B3: when HubSpot has recalculated the header amount before the same run reaches the deal amounts, the deal is updated in that run', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.dealAmount.amountDependsOnRule = 'lines_to_header'; } });
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'QI', customer: 'C', contactNumber: '1', amount: '100', dealAmount: '100', lines: 2 });
  fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  fake.associate(T.line, ids.lines[0], T.header, ids.header, 101);
  fake.advance(60);
  // The rollup is recalculated as soon as the missing line is associated.
  const instantRollup = async (input, init) => {
    const response = await fake.fetch(input, init);
    if (String(input).includes(`/${T.line}/${T.header}/batch/create`)) fake.record(T.header, ids.header).properties.quote_amount = '180';
    return response;
  };
  // First live run ever, so the header has no recorded amount: the amount it had before the line was linked is what counts.
  const run = await executeRun(h.ctx({ clientOptions: { fetchImpl: instantRollup } }), { mode: 'full' });
  assert.equal(h.rule(run, 'lines_to_header').created, 1);
  assert.equal(run.dealAmount.headersWithAmountChange, 1);
  assert.equal(run.dealAmount.updated, 1);
  assert.deepEqual(run.dealAmount.changes, [{ dealId: ids.deal, headerId: ids.header, from: '100', to: '180' }]);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '180');

  fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(next.dealAmount.updated, 0);
  assert.deepEqual(await h.baselines(), { [ids.header]: { amount: '180', recheck: null } });
  assert.equal(amountWrites(fake).length, 1);
  await h.cleanup();
});

test('B3: the catch-up dry run counts deals that the same run would only just have associated', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q20', customer: 'C', contactNumber: '1', amount: '75', dealAmount: '50' });
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full', dealAmounts: true });
  assert.equal(h.rule(dry, 'header_to_deal').planned, 1);
  assert.deepEqual(dry.dealAmount.changes, [{ dealId: ids.deal, headerId: ids.header, from: '50', to: '75' }]);
  assert.equal(fake.writes.length, 0);
  await h.cleanup();
});

test('B3 can be switched off, and the "any_difference" trigger syncs every changed header that differs from its deal', async () => {
  const off = await makeHarness({ mutateMapping: (m) => { m.dealAmount.enabled = false; } });
  addQuoteFamily(off.fake, { quote: 'Q30', customer: 'C', contactNumber: '1', amount: '75', dealAmount: '50' });
  off.fake.advance(10);
  const none = await executeRun(off.ctx(), { mode: 'incremental' });
  assert.equal(none.dealAmount, null);
  assert.equal(amountWrites(off.fake).length, 0);
  await off.cleanup();

  const any = await makeHarness({ mutateMapping: (m) => { m.dealAmount.trigger = 'any_difference'; } });
  const ids = addQuoteFamily(any.fake, { quote: 'Q31', customer: 'C', contactNumber: '1', amount: '75', dealAmount: '50' });
  any.fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  any.fake.advance(10);
  const run = await executeRun(any.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(any.fake.record(T.deal, ids.deal).properties.amount, '75');
  await any.cleanup();
});

test('B3: the catch-up with --limit updates only that many deals, and a later scheduled run does not finish the catch-up by itself', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const a = addQuoteFamily(fake, { quote: 'Q40', customer: 'C', contactNumber: '1', amount: '10', dealAmount: '1' });
  const b = addQuoteFamily(fake, { quote: 'Q41', customer: 'C', contactNumber: '1', amount: '20', dealAmount: '2', withCompany: false, withContact: false });
  const c = addQuoteFamily(fake, { quote: 'Q42', customer: 'C', contactNumber: '1', amount: '30', dealAmount: '3', withCompany: false, withContact: false });
  for (const ids of [a, b, c]) fake.associate(T.header, ids.header, T.deal, ids.deal, 105);
  fake.advance(10);

  const limited = await executeRun(h.ctx(), { mode: 'full', dealAmounts: true, limit: 1 });
  assert.equal(limited.dealAmount.updated, 1);
  assert.equal(limited.dealAmount.notAttempted, 2);
  assert.equal(amountWrites(fake).length, 1);
  assert.equal(amountWrites(fake)[0].inputs.length, 1);

  fake.advance(30);
  const scheduled = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(scheduled.dealAmount.updated, 0);
  assert.equal(amountWrites(fake).length, 1);
  const amounts = [a, b, c].map((ids) => fake.record(T.deal, ids.deal).properties.amount).sort();
  assert.deepEqual(amounts, ['10', '2', '3']);
  await h.cleanup();
});

test('B3: closed deals are updated like open ones by default', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q50', customer: 'C', contactNumber: '1', amount: '5', dealAmount: '5' });
  fake.updateRecord(T.deal, ids.deal, { hs_is_closed: 'true' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(30);
  fake.updateRecord(T.header, ids.header, { quote_amount: '8' });
  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(fake.record(T.deal, ids.deal).properties.amount, '8');
  await h.cleanup();
});
