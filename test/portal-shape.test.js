import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { assertValidMapping, loadMapping, mappingProblems } from '../src/config.js';
import { restoreContactAssociations, runContactCleanup } from '../src/engine/contactCleanup.js';
import { executeRun } from '../src/engine/run.js';
import { runPreflight } from '../src/preflight.js';
import { renderRunMarkdown, writeRunReport } from '../src/report.js';
import { makePortalHarness, P, SHIPPED_MAPPING_FILE } from './helpers.js';

// These tests run the mapping file that ships in config/ against a fake
// account laid out like the Industrious portal (same object type IDs, property
// names and association type IDs). The records are invented.

function family(fake, { quote, customerUid, customerNumber, deal = true, amount = '1000' }) {
  const ids = {};
  ids.company = fake.addRecord(P.company, { customer_uid: customerUid, epicor_customer_id: customerUid, epicor_customer_number: customerNumber });
  if (deal) ids.deal = fake.addRecord(P.deal, { amount });
  ids.quote = fake.addRecord(P.quote, { quote_number: quote, customer_uid: customerUid, shipping_customer_id: customerNumber, hubspot_deal_id: deal ? ids.deal : '', amount });
  return ids;
}

test('the shipped mapping is ready for Items B1 and B3, and keeps Item B2 off until its two properties exist', () => {
  const mapping = loadMapping(SHIPPED_MAPPING_FILE);
  assert.doesNotThrow(() => assertValidMapping(mapping));
  assert.deepEqual(mapping.rules.map((r) => [r.id, r.enabled]), [
    ['lines_to_header', true],
    ['tasks_to_header', true],
    ['header_to_deal', true],
    ['header_to_deal_by_quote_number', true],
    ['header_to_company', true],
    ['ic_codes_to_company', true],
    ['contacts_to_header', false],
  ]);
  assert.equal(mapping.dealAmount.enabled, true);
  assert.equal(mapping.dealAmount.skipClosedDeals, true);
  assert.equal(mapping.dealAmount.requireNewLines, true);
  assert.equal(mapping.dealAmount.newLinesWindowMinutes, 120);
  assert.equal(mapping.dealAmount.guard.holdPercentChange, true);
  assert.equal(mapping.dealAmount.guard.percentChangeThreshold, 50);
  assert.equal(mapping.dealAmount.requireOneToOne, true);
  assert.equal(mapping.dealAmount.backfillInFullRun, false);
  assert.equal(mapping.dealAmount.backlogLinkedLines, 'update_deals');
  assert.equal(mapping.contactCleanup.standardContacts.enabled, false);
  const byQuoteNumber = mapping.rules.find((r) => r.id === 'header_to_deal_by_quote_number');
  assert.equal(byQuoteNumber.onMultipleTargets, 'skip');
  assert.equal(byQuoteNumber.ifAssociatedElsewhere, 'add');
  assert.equal(mapping.rules.find((r) => r.id === 'header_to_company').ifAssociatedElsewhere, 'add');
  const cleanupProblems = mappingProblems(mapping, { forCleanup: true });
  assert.deepEqual(cleanupProblems.sort(), [
    'objects.contact.properties.customerContactNumber is not filled in',
    'objects.quoteHeader.properties.quoteContactNumber is not filled in',
  ]);
});

test('portal shape: lines and tasks created before their quote are linked once the quote arrives, with the portal association types', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  // Children first, as the Jitterbit loads deliver them.
  const line1 = fake.addRecord(P.line, { quote_number: '8809127', quote_line: '1', line_item_id: '8809127-1' });
  const line2 = fake.addRecord(P.line, { quote_number: '8809127', quote_line: '2', line_item_id: '8809127-2' });
  const task = fake.addRecord(P.task, { quote_id: '8809127', key1: '8809127', task_id: 'WL-10-8809127' });
  const noQuoteTask = fake.addRecord(P.task, { quote_id: '0', task_id: 'WL-10-55' });
  const ic = fake.addRecord(P.ic, { customer_uid: '13000', ic_code_uid: '13000-OEM-1' });

  fake.advance(10);
  const before = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(before, 'lines_to_header').noTarget, 2);
  assert.equal(h.rule(before, 'tasks_to_header').noTarget, 1);
  assert.equal(h.rule(before, 'tasks_to_header').missingKey, 1, 'quote_id "0" means no quote and is not retried');
  assert.equal(h.rule(before, 'ic_codes_to_company').noTarget, 1);

  fake.advance(120);
  const ids = family(fake, { quote: '8809127', customerUid: '13000', customerNumber: '1953' });
  fake.advance(10);
  const after = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(after.status, 'ok');

  assert.deepEqual(fake.associationTypes(P.line, line1, P.quote, ids.quote), [98]);
  assert.deepEqual(fake.associationTypes(P.line, line2, P.quote, ids.quote), [98]);
  assert.deepEqual(fake.associationTypes(P.quote, ids.quote, P.line, line1), [97]);
  assert.deepEqual(fake.associationTypes(P.task, task, P.quote, ids.quote), [123]);
  assert.deepEqual(fake.associationTypes(P.quote, ids.quote, P.deal, ids.deal), [99]);
  assert.deepEqual(fake.associationTypes(P.quote, ids.quote, P.company, ids.company), [95]);
  assert.deepEqual(fake.associationTypes(P.ic, ic, P.company, ids.company), [93]);
  assert.deepEqual(fake.associated(P.task, noQuoteTask, P.quote), []);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact), [], 'Item B2 is off in the shipped mapping');

  const writeOrder = fake.writes.filter((w) => w.kind === 'associate').map((w) => `${w.from}>${w.to}`);
  assert.deepEqual(writeOrder, [
    `${P.line}>${P.quote}`,
    `${P.task}>${P.quote}`,
    `${P.quote}>deals`,
    `${P.quote}>companies`,
    `${P.ic}>companies`,
  ]);
  assert.deepEqual(await h.review('tasks_to_header'), { [noQuoteTask]: 'missing_key' });
  await h.cleanup();
});

test('portal shape: header to deal follows hubspot_deal_id; a blank, non-numeric or dead deal ID creates nothing', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const good = family(fake, { quote: '100', customerUid: '1', customerNumber: '11' });
  const noDeal = family(fake, { quote: '101', customerUid: '2', customerNumber: '12', deal: false });
  const dead = family(fake, { quote: '102', customerUid: '3', customerNumber: '13', deal: false });
  fake.updateRecord(P.quote, dead.quote, { hubspot_deal_id: '999999999' });
  const junk = family(fake, { quote: '103', customerUid: '4', customerNumber: '14', deal: false });
  fake.updateRecord(P.quote, junk.quote, { hubspot_deal_id: 'n/a' });

  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  const rule = h.rule(run, 'header_to_deal');
  assert.equal(rule.created, 1);
  assert.equal(rule.missingKey, 1);
  assert.equal(rule.noTarget, 2);
  assert.deepEqual(fake.associated(P.quote, good.quote, P.deal), [good.deal]);
  assert.deepEqual(fake.associated(P.quote, noDeal.quote, P.deal), []);
  assert.deepEqual(fake.associated(P.quote, dead.quote, P.deal), []);
  await h.cleanup();
});

test('portal shape: a quote without a deal ID is linked to the one deal that carries its quote number, typed by hand', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const plain = family(fake, { quote: '8801', customerUid: '1', customerNumber: '11', deal: false });
  const typed = fake.addRecord(P.deal, { quote_num: '8801', amount: '5' });
  // Hand-typed values come with stray spaces; blank and "0" never match anything.
  const spaced = family(fake, { quote: '8802', customerUid: '2', customerNumber: '12', deal: false });
  const typedSpaced = fake.addRecord(P.deal, { quote_num: ' 8802 ', amount: '5' });
  const zero = family(fake, { quote: '0', customerUid: '3', customerNumber: '13', deal: false });
  const zeroDeal = fake.addRecord(P.deal, { quote_num: '0', amount: '5' });
  fake.addRecord(P.deal, { amount: '5' });
  // Found by deal ID already, and the same deal also carries the number: nothing more to do.
  const both = family(fake, { quote: '8803', customerUid: '4', customerNumber: '14' });
  fake.updateRecord(P.deal, both.deal, { quote_num: '8803' });

  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.status, 'ok');
  const byId = h.rule(run, 'header_to_deal');
  const byNumber = h.rule(run, 'header_to_deal_by_quote_number');
  assert.equal(byId.created, 1);
  assert.equal(byNumber.created, 2);
  assert.equal(byNumber.alreadyAssociated, 1);
  assert.equal(byNumber.missingKey, 1);
  assert.equal(byNumber.multipleTargets, 0);
  assert.deepEqual(fake.associationTypes(P.quote, plain.quote, P.deal, typed), [99]);
  assert.deepEqual(fake.associationTypes(P.deal, typed, P.quote, plain.quote), [100]);
  assert.deepEqual(fake.associated(P.quote, spaced.quote, P.deal), [typedSpaced]);
  assert.deepEqual(fake.associated(P.quote, zero.quote, P.deal), []);
  assert.deepEqual(fake.associated(P.deal, zeroDeal, P.quote), []);
  assert.deepEqual(fake.associated(P.quote, both.quote, P.deal), [both.deal]);

  // A deal that gets its quote number typed in later is picked up without the quote changing.
  const late = family(fake, { quote: '8804', customerUid: '5', customerNumber: '15', deal: false });
  const lateDeal = fake.addRecord(P.deal, { amount: '5' });
  fake.advance(30);
  const middle = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(middle, 'header_to_deal_by_quote_number').created, 0);
  fake.advance(30);
  fake.updateRecord(P.deal, lateDeal, { quote_num: '8804' });
  fake.advance(10);
  const after = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(after, 'header_to_deal_by_quote_number').created, 1);
  assert.deepEqual(fake.associated(P.quote, late.quote, P.deal), [lateDeal]);
  await h.cleanup();
});

test('portal shape: a quote number typed on more than one deal is not linked; the quotes are held for review and counted in the reconciliation report', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const q1 = family(fake, { quote: '7001', customerUid: '1', customerNumber: '11', deal: false });
  const d1a = fake.addRecord(P.deal, { quote_num: '7001', amount: '5' });
  const d1b = fake.addRecord(P.deal, { quote_num: '7001', amount: '6' });
  const q2 = family(fake, { quote: '7002', customerUid: '2', customerNumber: '12', deal: false });
  for (let i = 0; i < 4; i += 1) fake.addRecord(P.deal, { quote_num: '7002', amount: '7' });
  const fine = family(fake, { quote: '7003', customerUid: '3', customerNumber: '13', deal: false });
  const fineDeal = fake.addRecord(P.deal, { quote_num: '7003', amount: '5' });
  fake.advance(10);

  for (const dryRun of [true, false]) {
    const run = await executeRun(h.ctx({ dryRun }), { mode: 'full' });
    const rule = h.rule(run, 'header_to_deal_by_quote_number');
    assert.equal(rule.multipleTargets, 2);
    assert.equal(rule.multipleTargetKeys, 2);
    assert.equal(dryRun ? rule.planned : rule.created, 1);
    assert.deepEqual(rule.unresolved.filter((u) => u.status === 'multiple_targets').map((u) => u.id).sort(), [q1.quote, q2.quote].sort());
    assert.match(rule.unresolved.find((u) => u.id === q1.quote).detail, new RegExp(`${d1a}, ${d1b}`));

    const markdown = renderRunMarkdown(run);
    assert.match(markdown, /## Held for review/);
    assert.match(markdown, /\| B1 \| Header to deal \(quote number typed on the deal\) \| 2 \| 2 \| 0 \|/);
  }
  assert.deepEqual(fake.associated(P.quote, q1.quote, P.deal), []);
  assert.deepEqual(fake.associated(P.quote, q2.quote, P.deal), []);
  assert.deepEqual(fake.associated(P.deal, d1a, P.quote), []);
  assert.deepEqual(fake.associated(P.quote, fine.quote, P.deal), [fineDeal]);
  assert.deepEqual(await h.review('header_to_deal_by_quote_number'), { [q1.quote]: 'multiple_targets', [q2.quote]: 'multiple_targets' });

  // Someone clears the duplicate on one deal: the quote is linked on the next run and leaves the review list.
  fake.advance(30);
  fake.updateRecord(P.deal, d1b, { quote_num: '' });
  fake.advance(10);
  const later = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(later, 'header_to_deal_by_quote_number').created, 1);
  assert.deepEqual(fake.associated(P.quote, q1.quote, P.deal), [d1a]);
  assert.deepEqual(await h.review('header_to_deal_by_quote_number'), { [q2.quote]: 'multiple_targets' });
  await h.cleanup();
});

test('portal shape: "no match" for the quote number rule means the quote has no deal at all; quotes that have a deal another way are not listed', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  // Linked through the deal ID; its deal carries no quote number.
  const byId = family(fake, { quote: '9001', customerUid: '1', customerNumber: '11' });
  // Associated to a deal by hand in HubSpot: no deal ID on the quote, no quote number on the deal.
  const byHand = family(fake, { quote: '9002', customerUid: '2', customerNumber: '12', deal: false });
  const handDeal = fake.addRecord(P.deal, { amount: '5' });
  fake.associate(P.quote, byHand.quote, P.deal, handDeal, 99);
  // No deal anywhere.
  const none = family(fake, { quote: '9003', customerUid: '3', customerNumber: '13', deal: false });
  // Already on a deal through the deal ID, and its number is typed on two other deals.
  const heldWithDeal = family(fake, { quote: '9004', customerUid: '4', customerNumber: '14' });
  const dupA = fake.addRecord(P.deal, { quote_num: '9004', amount: '5' });
  const dupB = fake.addRecord(P.deal, { quote_num: '9004', amount: '5' });
  fake.advance(10);

  for (const dryRun of [true, false]) {
    const run = await executeRun(h.ctx({ dryRun }), { mode: 'full' });
    const rule = h.rule(run, 'header_to_deal_by_quote_number');
    assert.equal(rule.noTarget, 1, 'only the quote with no deal at all');
    assert.equal(rule.noMatchButAssociated, 2);
    assert.equal(rule.multipleTargets, 1);
    assert.equal(rule.multipleTargetsAlreadyAssociated, 1);
    assert.deepEqual(rule.unresolved.map((u) => [u.id, u.status]).sort(), [[none.quote, 'no_target'], [heldWithDeal.quote, 'multiple_targets']].sort());
    assert.equal(rule.unresolved.find((u) => u.id === heldWithDeal.quote).detail, `matches Deal ${dupA}, ${dupB}; already has Deal ${heldWithDeal.deal}`);
    const markdown = renderRunMarkdown(run);
    assert.match(markdown, /Header to deal \(quote number typed on the deal\): 2 more record\(s\) have no match this way but already have a record of that type associated/);
    assert.match(markdown, /Header to deal \(quote number typed on the deal\): 1 of the 1 record\(s\) whose key matches more than one record already have a record of that type associated/);
  }
  assert.deepEqual(fake.associated(P.quote, byHand.quote, P.deal), [handDeal]);
  assert.deepEqual(fake.associated(P.quote, heldWithDeal.quote, P.deal), [heldWithDeal.deal]);
  assert.deepEqual(await h.review('header_to_deal_by_quote_number'), { [none.quote]: 'no_target', [heldWithDeal.quote]: 'multiple_targets' });

  // Between full refreshes the staging copy answers: nothing is read again and the result is the same.
  fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  const rule = h.rule(next, 'header_to_deal_by_quote_number');
  assert.equal(rule.associationsRead, 0);
  assert.equal(rule.noTarget, 1);
  assert.equal(rule.noMatchButAssociated, 2);

  // The other associations keep reporting every unmatched record.
  assert.equal(h.mapping.rules.find((r) => r.id === 'lines_to_header').ifNoMatch, 'report');
  await h.cleanup();
});

test('portal shape: a quote that already has a different deal also gets the deal that carries its quote number; the existing deal stays and nothing is removed', async () => {
  for (const dryRun of [true, false]) {
    const h = await makePortalHarness();
    const { fake } = h;
    // Already associated in HubSpot to its deal by ID; its number is typed on another deal.
    const existing = family(fake, { quote: '6001', customerUid: '1', customerNumber: '11' });
    fake.associate(P.quote, existing.quote, P.deal, existing.deal, 99);
    const otherDeal = fake.addRecord(P.deal, { quote_num: '6001', amount: '5' });
    // Not associated yet: the deal ID rule (first) and the quote number rule (second) point at different deals.
    const fresh = family(fake, { quote: '6002', customerUid: '2', customerNumber: '12' });
    const freshOther = fake.addRecord(P.deal, { quote_num: '6002', amount: '5' });
    // Already on a deal, and its number is typed on two other deals: still held for review.
    const held = family(fake, { quote: '6003', customerUid: '3', customerNumber: '13' });
    fake.associate(P.quote, held.quote, P.deal, held.deal, 99);
    const dupA = fake.addRecord(P.deal, { quote_num: '6003', amount: '5' });
    const dupB = fake.addRecord(P.deal, { quote_num: '6003', amount: '5' });
    fake.advance(10);

    const run = await executeRun(h.ctx({ dryRun }), { mode: 'incremental' });
    assert.equal(run.status, 'ok');
    const byId = h.rule(run, 'header_to_deal');
    const byNumber = h.rule(run, 'header_to_deal_by_quote_number');
    assert.equal(dryRun ? byId.planned : byId.created, 1);
    assert.equal(dryRun ? byNumber.planned : byNumber.created, 2);
    assert.equal(byNumber.addedAlongsideOther, 2);
    assert.equal(byNumber.associatedElsewhere, 0);
    assert.equal(byNumber.multipleTargets, 1);
    assert.equal(byNumber.multipleTargetsAlreadyAssociated, 1);
    assert.deepEqual(byNumber.links.map((l) => [l.fromId, l.toId]).sort(), [[existing.quote, otherDeal], [fresh.quote, freshOther]].sort());
    const markdown = renderRunMarkdown(run);
    assert.match(markdown, /Header to deal \(quote number typed on the deal\): 2 of the filled record\(s\) already had a different record of that type associated; the matching one (would be|was) added next to it\./);
    assert.match(markdown, /\| B1 \| Header to deal \(quote number typed on the deal\) \| 1 \| 1 \| 0 \|/);

    assert.deepEqual(fake.associated(P.quote, held.quote, P.deal), [held.deal]);
    assert.deepEqual(fake.associated(P.deal, dupA, P.quote), []);
    assert.deepEqual(fake.associated(P.deal, dupB, P.quote), []);
    if (dryRun) {
      assert.equal(fake.writes.length, 0);
      assert.deepEqual(fake.associated(P.quote, existing.quote, P.deal), [existing.deal]);
    } else {
      assert.deepEqual(fake.associated(P.quote, existing.quote, P.deal).sort(), [existing.deal, otherDeal].sort());
      assert.deepEqual(fake.associated(P.quote, fresh.quote, P.deal).sort(), [fresh.deal, freshOther].sort());
      assert.deepEqual(fake.associationTypes(P.quote, existing.quote, P.deal, existing.deal), [99]);
      assert.deepEqual(fake.associationTypes(P.quote, existing.quote, P.deal, otherDeal), [99]);
      assert.ok(fake.writes.every((w) => w.kind === 'associate'), 'associations are only ever added');
      assert.deepEqual(await h.review('header_to_deal_by_quote_number'), { [held.quote]: 'multiple_targets' });

      // Nothing more to do on the next run.
      fake.advance(30);
      const writes = fake.writes.length;
      const again = await executeRun(h.ctx(), { mode: 'incremental' });
      assert.equal(h.rule(again, 'header_to_deal_by_quote_number').created, 0);
      assert.equal(h.rule(again, 'header_to_deal_by_quote_number').multipleTargets, 1);
      assert.equal(fake.writes.length, writes);
    }
    await h.cleanup();
  }
});

test('portal shape: a quote already associated to a different company gets the matching company added, or is left alone when the rule says skip', async () => {
  for (const mode of ['add', 'skip']) {
    const h = await makePortalHarness({ mutateMapping: (m) => { m.rules.find((r) => r.id === 'header_to_company').ifAssociatedElsewhere = mode; } });
    const { fake } = h;
    const ids = family(fake, { quote: '200', customerUid: '50', customerNumber: '60' });
    const other = fake.addRecord(P.company, { customer_uid: '51', epicor_customer_id: '51' });
    fake.associate(P.quote, ids.quote, P.company, other, 95);

    fake.advance(10);
    const run = await executeRun(h.ctx(), { mode: 'incremental' });
    const rule = h.rule(run, 'header_to_company');
    if (mode === 'add') {
      assert.equal(rule.created, 1);
      assert.equal(rule.addedAlongsideOther, 1);
      assert.deepEqual(fake.associated(P.quote, ids.quote, P.company).sort(), [ids.company, other].sort());
    } else {
      assert.equal(rule.created, 0);
      assert.equal(rule.associatedElsewhere, 1);
      assert.equal(rule.unresolved[0].status, 'associated_elsewhere');
      assert.deepEqual(fake.associated(P.quote, ids.quote, P.company), [other]);
      assert.deepEqual(await h.review('header_to_company'), { [ids.quote]: 'associated_elsewhere' });
    }
    await h.cleanup();
  }
});

test('portal shape: B3 follows the rollup amount on the quote after a late line is linked; the amount of a closed deal is never changed', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const ids = family(fake, { quote: '300', customerUid: '70', customerNumber: '80', amount: '1000' });
  const won = family(fake, { quote: '301', customerUid: '77', customerNumber: '87', amount: '2000' });
  fake.updateRecord(P.deal, won.deal, { hs_is_closed: 'true' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });

  // Steady state: a line for each quote arrives from Jitterbit without its association.
  fake.advance(60);
  const late = fake.addRecord(P.line, { quote_number: '300', quote_line: '2' });
  const lateWon = fake.addRecord(P.line, { quote_number: '301', quote_line: '2' });
  fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(first, 'lines_to_header').created, 2);
  assert.deepEqual(fake.associated(P.line, late, P.quote), [ids.quote]);
  // Associations are still added on a quote whose deal is closed.
  assert.deepEqual(fake.associated(P.line, lateWon, P.quote), [won.quote]);
  assert.equal(first.dealAmount.updated, 0);

  // HubSpot recalculates the rollups once the lines are associated.
  fake.record(P.quote, ids.quote).properties.amount = '1450';
  fake.record(P.quote, won.quote).properties.amount = '2600';
  fake.advance(30);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'ok');
  assert.equal(second.dealAmount.updated, 1);
  assert.deepEqual(second.dealAmount.changes, [{ dealId: ids.deal, headerId: ids.quote, from: '1000', to: '1450' }]);
  assert.equal(fake.record(P.deal, ids.deal).properties.amount, '1450');
  assert.equal(second.dealAmount.skipped.deal_closed, 1);
  assert.deepEqual(second.dealAmount.closedSkipped, [{ dealId: won.deal, headerId: won.quote, from: '2000', to: '2600' }]);
  assert.equal(second.dealAmount.heldCount, 0);
  assert.equal(fake.record(P.deal, won.deal).properties.amount, '2000');
  const md = renderRunMarkdown(second);
  assert.match(md, /Closed deals are never changed \(dealAmount\.skipClosedDeals\)\. 1 deal amount change\(s\) were left alone for that reason; they are in the deal amounts CSV\./);
  const csv = fs.readFileSync(writeRunReport(h.outputDir, second).dealChanges, 'utf8').trim().split('\n');
  assert.ok(csv.includes(`${won.deal},${won.quote},2000,2600,skipped: deal is closed,`));
  assert.equal(fake.writes.filter((w) => w.kind === 'update').length, 1);

  // The skipped change is not carried over, and reopening the deal later does not bring it back.
  fake.advance(30);
  fake.updateRecord(P.deal, won.deal, { hs_is_closed: 'false' });
  fake.advance(10);
  const later = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(later.dealAmount.updated, 0);
  assert.equal(fake.record(P.deal, won.deal).properties.amount, '2000');
  await h.cleanup();
});

test('portal shape: with skipClosedDeals switched off, a closed deal follows its quote like an open one', async () => {
  const h = await makePortalHarness({ mutateMapping: (m) => { m.dealAmount.skipClosedDeals = false; } });
  const { fake } = h;
  const won = family(fake, { quote: '302', customerUid: '78', customerNumber: '88', amount: '2000' });
  fake.updateRecord(P.deal, won.deal, { hs_is_closed: 'true' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.advance(60);
  fake.addRecord(P.line, { quote_number: '302', quote_line: '2' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  fake.record(P.quote, won.quote).properties.amount = '2600';
  fake.advance(30);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(run.dealAmount.skipped.deal_closed, 0);
  assert.equal(fake.record(P.deal, won.deal).properties.amount, '2600');
  await h.cleanup();
});

test('portal shape: when reconcile links orphaned lines and the quote amount changes, the deal is updated like any other amount change; existing amount mismatches stay untouched, also when their quote changes amount without a new line', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  // Backlog: a line that was never associated, on a quote whose deal is associated.
  const backlog = family(fake, { quote: '310', customerUid: '71', customerNumber: '81', amount: '1000' });
  fake.associate(P.quote, backlog.quote, P.deal, backlog.deal, 99);
  const orphan = fake.addRecord(P.line, { quote_number: '310', quote_line: '2' });
  // An existing mismatch between quote and deal amount, with nothing waiting to be linked.
  const mismatch = family(fake, { quote: '311', customerUid: '72', customerNumber: '82', amount: '500' });
  fake.updateRecord(P.deal, mismatch.deal, { amount: '750' });
  fake.associate(P.quote, mismatch.quote, P.deal, mismatch.deal, 99);
  fake.advance(60 * 24 * 60);

  // The dry run cannot know the amount HubSpot will calculate once the line is linked, and says so.
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(dry.dealAmount.planned, 0);
  assert.equal(dry.dealAmount.headersWithLinesLinked, 1);
  assert.match(renderRunMarkdown(dry), /1 quote header\(s\) would have lines linked by a live run\. HubSpot recalculates a header's amount after its lines are linked, and the next run that sees the new amount sets the deal to it\./);
  assert.equal(fake.writes.length, 0);

  const reconcile = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(reconcile.status, 'ok');
  assert.equal(h.rule(reconcile, 'lines_to_header').created, 1);
  assert.deepEqual(fake.associated(P.line, orphan, P.quote), [backlog.quote]);
  assert.equal(reconcile.dealAmount.backlog, false);
  assert.equal(reconcile.dealAmount.backfill, false);
  assert.equal(reconcile.dealAmount.updated, 0);
  assert.match(renderRunMarkdown(reconcile), /1 quote header\(s\) had lines linked in this run\./);

  // HubSpot recalculates the rollup; the next scheduled run moves the deal.
  fake.record(P.quote, backlog.quote).properties.amount = '1450';
  fake.advance(30);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(next.dealAmount.updated, 1);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: backlog.deal, headerId: backlog.quote, from: '1000', to: '1450' }]);
  assert.equal(fake.record(P.deal, backlog.deal).properties.amount, '1450');

  // The existing mismatch is left alone by scheduled runs and by another reconcile.
  for (const mode of ['incremental', 'full', 'incremental']) {
    fake.advance(30);
    const run = await executeRun(h.ctx(), { mode });
    assert.equal(run.dealAmount.updated, 0);
  }
  assert.equal(fake.record(P.deal, mismatch.deal).properties.amount, '750');
  assert.equal(fake.writes.filter((w) => w.kind === 'update').length, 1);

  // Also when its quote changes amount without gaining a line: the new amount is recorded, the deal left alone.
  fake.advance(30);
  fake.updateRecord(P.quote, mismatch.quote, { amount: '600' });
  fake.advance(10);
  const requote = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(requote.dealAmount.headersWithAmountChange, 1);
  assert.equal(requote.dealAmount.headersChangedWithoutNewLines, 1);
  assert.equal(requote.dealAmount.updated, 0);
  assert.equal(fake.record(P.deal, mismatch.deal).properties.amount, '750');
  assert.match(renderRunMarkdown(requote), /1 quote header\(s\) changed amount without gaining a line; the new amount was recorded and the deal left alone\./);
  fake.advance(30);
  assert.equal((await executeRun(h.ctx(), { mode: 'incremental' })).dealAmount.headersWithAmountChange, 0);

  // Until the quote gains a line: then the deal follows the quote amount.
  fake.advance(30);
  fake.addRecord(P.line, { quote_number: '311', quote_line: '2' });
  fake.advance(10);
  const linked = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(linked, 'lines_to_header').created, 1);
  assert.equal(linked.dealAmount.updated, 0);
  fake.record(P.quote, mismatch.quote).properties.amount = '650';
  fake.advance(30);
  const follow = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(follow.dealAmount.updated, 1);
  assert.deepEqual(follow.dealAmount.changes, [{ dealId: mismatch.deal, headerId: mismatch.quote, from: '750', to: '650' }]);
  assert.equal(fake.record(P.deal, mismatch.deal).properties.amount, '650');
  await h.cleanup();
});

test('portal shape: Item B3 only acts on one quote with one deal: a quote given a second deal by its quote number, and a deal that gains a second quote, are skipped and counted', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  // One deal through the deal ID; the quote number is typed on another deal. A line is waiting to be linked.
  const two = family(fake, { quote: '320', customerUid: '73', customerNumber: '83', amount: '1000' });
  fake.associate(P.quote, two.quote, P.deal, two.deal, 99);
  const second = fake.addRecord(P.deal, { quote_num: '320', amount: '40' });
  fake.addRecord(P.line, { quote_number: '320', quote_line: '2' });
  // No deal until its number is found on one. A line is waiting to be linked.
  const gained = family(fake, { quote: '321', customerUid: '74', customerNumber: '84', amount: '200', deal: false });
  const gainedDeal = fake.addRecord(P.deal, { quote_num: '321', amount: '190' });
  fake.addRecord(P.line, { quote_number: '321', quote_line: '2' });
  // One quote with one deal, until that deal also turns out to carry another quote's number.
  const shared = family(fake, { quote: '322', customerUid: '75', customerNumber: '85', amount: '700' });
  fake.associate(P.quote, shared.quote, P.deal, shared.deal, 99);
  const other = family(fake, { quote: '323', customerUid: '76', customerNumber: '86', amount: '300' });
  fake.associate(P.quote, other.quote, P.deal, other.deal, 99);
  fake.updateRecord(P.deal, shared.deal, { quote_num: '323' });
  fake.addRecord(P.line, { quote_number: '322', quote_line: '2' });
  fake.advance(60);

  const reconcile = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(reconcile.status, 'ok');
  assert.equal(h.rule(reconcile, 'header_to_deal_by_quote_number').created, 3);
  assert.equal(h.rule(reconcile, 'header_to_deal_by_quote_number').addedAlongsideOther, 2);
  assert.deepEqual(fake.associated(P.quote, two.quote, P.deal).sort(), [two.deal, second].sort());
  assert.deepEqual(fake.associated(P.quote, gained.quote, P.deal), [gainedDeal]);
  assert.deepEqual(fake.associated(P.deal, shared.deal, P.quote).sort(), [shared.quote, other.quote].sort());
  assert.equal(reconcile.dealAmount.updated, 0);

  // HubSpot recalculates the three quotes that gained a line.
  fake.record(P.quote, two.quote).properties.amount = '1300';
  fake.record(P.quote, gained.quote).properties.amount = '260';
  fake.record(P.quote, shared.quote).properties.amount = '710';
  fake.advance(40);
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(next.dealAmount.headersWithAmountChange, 3);
  assert.equal(next.dealAmount.updated, 1);
  assert.equal(next.dealAmount.skipped.header_has_multiple_deals, 1);
  assert.equal(next.dealAmount.skipped.deal_has_multiple_headers, 1);
  assert.deepEqual(next.dealAmount.changes, [{ dealId: gainedDeal, headerId: gained.quote, from: '190', to: '260' }]);
  assert.equal(fake.record(P.deal, two.deal).properties.amount, '1000');
  assert.equal(fake.record(P.deal, second).properties.amount, '40');
  assert.equal(fake.record(P.deal, shared.deal).properties.amount, '700');
  const markdown = renderRunMarkdown(next);
  assert.match(markdown, /- header_has_multiple_deals: 1/);
  assert.match(markdown, /- deal_has_multiple_headers: 1/);

  // A skipped change is not carried over to later runs.
  fake.advance(30);
  const later = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(later.dealAmount.headersWithAmountChange, 0);
  assert.equal(fake.writes.filter((w) => w.kind === 'update').length, 1);
  await h.cleanup();
});

function withB2(m) {
  m.objects.quoteHeader.properties.quoteContactNumber = 'quote_contact_number';
  m.objects.contact.properties.customerContactNumber = 'contact_number';
}

/** A quote as the retired workflow left it: every Epicor Contact of the customer, and their standard Contacts, on the quote. */
function quoteWithContacts(fake, { quote, customerNumber, namedHasStandardContact = true }) {
  const ids = family(fake, { quote, customerUid: `U${customerNumber}`, customerNumber });
  fake.updateRecord(P.quote, ids.quote, { quote_contact_number: '2' });
  ids.named = fake.addRecord(P.epicorContact, { custnum: customerNumber, contact_number: '2' });
  ids.colleague1 = fake.addRecord(P.epicorContact, { custnum: customerNumber, contact_number: '1' });
  ids.colleague2 = fake.addRecord(P.epicorContact, { custnum: customerNumber, contact_number: '3' });
  for (const c of [ids.named, ids.colleague1, ids.colleague2]) fake.associate(P.quote, ids.quote, P.epicorContact, c, 148);
  ids.stdNamed = fake.addRecord(P.contact, { email: `named-${quote}@example.com` });
  ids.stdColleague = fake.addRecord(P.contact, { email: `colleague-${quote}@example.com` });
  ids.stdOther = fake.addRecord(P.contact, { email: `other-${quote}@example.com` });
  if (namedHasStandardContact) fake.associate(P.epicorContact, ids.named, P.contact, ids.stdNamed, 141);
  fake.associate(P.epicorContact, ids.colleague1, P.contact, ids.stdColleague, 141);
  for (const c of [ids.stdNamed, ids.stdColleague, ids.stdOther]) fake.associate(P.quote, ids.quote, P.contact, c, 103);
  return ids;
}

test('portal shape: with the two Item B2 properties filled in, the named Epicor Contact is associated and the cleanup removes the rest; standard Contacts are not touched by default', async () => {
  const h = await makePortalHarness({
    mutateMapping: (m) => {
      withB2(m);
      m.rules.find((r) => r.id === 'contacts_to_header').enabled = true;
    },
  });
  const { fake } = h;
  const ids = quoteWithContacts(fake, { quote: '400', customerNumber: '95' });
  const sameNumberOtherCustomer = fake.addRecord(P.epicorContact, { custnum: '96', contact_number: '2' });

  fake.advance(10);
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(run, 'contacts_to_header').alreadyAssociated, 1);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact).sort(), [ids.named, ids.colleague1, ids.colleague2].sort());

  const requestsBefore = fake.requests.length;
  const cleanup = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(cleanup.status, 'ok');
  assert.equal(cleanup.associationsRemoved, 2);
  assert.deepEqual(cleanup.standardContacts, { enabled: false });
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact), [ids.named]);
  assert.deepEqual(fake.associated(P.epicorContact, sameNumberOtherCustomer, P.quote), []);
  assert.equal(fake.associated(P.quote, ids.quote, P.contact).length, 3, 'standard Contact associations are not touched');
  // With the switch off the standard Contact associations are not even read.
  assert.ok(fake.requests.slice(requestsBefore).every((r) => !r.path.includes('/contacts')));
  await h.cleanup();
});

test('portal shape: the standard Contact part of the cleanup is a separate switch; when on it keeps the standard Contact of the named contact, backs up every removal and can be restored', async () => {
  const h = await makePortalHarness({
    mutateMapping: (m) => {
      withB2(m);
      m.contactCleanup.standardContacts.enabled = true;
    },
  });
  const { fake } = h;
  const ids = quoteWithContacts(fake, { quote: '410', customerNumber: '97' });
  const noStd = quoteWithContacts(fake, { quote: '411', customerNumber: '98', namedHasStandardContact: false });
  fake.advance(10);

  const dry = await runContactCleanup(h.ctx({ dryRun: true }), { outputDir: h.outputDir });
  assert.equal(dry.status, 'ok');
  assert.equal(dry.associationsToRemove, 4);
  assert.equal(dry.standardContacts.associationsToRemove, 2);
  assert.equal(fake.writes.length, 0);
  assert.equal(await h.count('contact_cleanup_removals', "result = 'planned'"), 6);
  const refused = await restoreContactAssociations(h.ctx(), { runId: dry.runId });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /dry run/);
  assert.equal(fake.writes.length, 0);

  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(live.status, 'ok');
  assert.equal(live.associationsRemoved, 4);
  assert.deepEqual(live.standardContacts, {
    enabled: true,
    headersWithContacts: 2,
    headersSkipped: { no_standard_contact_for_named_contact: 1 },
    associationsSeen: 6,
    associationsKept: 1,
    associationsLeftOnSkippedHeaders: 3,
    associationsPreservedOtherTypes: 0,
    associationsToRemove: 2,
    associationsRemoved: 2,
    associationsFailed: 0,
  });
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact), [ids.named]);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.contact), [ids.stdNamed]);
  assert.deepEqual(fake.associated(P.contact, ids.stdOther, P.quote), []);
  // Nothing says which standard Contact is the named one on the second quote, so its standard Contacts stay.
  assert.deepEqual(fake.associated(P.quote, noStd.quote, P.epicorContact), [noStd.named]);
  assert.equal(fake.associated(P.quote, noStd.quote, P.contact).length, 3);
  // Associations between Epicor Contacts and standard Contacts are never changed.
  assert.deepEqual(fake.associated(P.epicorContact, ids.colleague1, P.contact), [ids.stdColleague]);
  assert.ok(fake.writes.every((w) => w.kind === 'archive' && w.from === P.quote));

  // The backup is in the staging database (and in the file), for both kinds of contact.
  const { rows } = await h.db.query('SELECT to_object_type, result, count(*)::int AS n FROM contact_cleanup_removals WHERE run_id = $1 GROUP BY 1, 2 ORDER BY 1', [live.runId]);
  assert.deepEqual(rows, [
    { to_object_type: P.epicorContact, result: 'removed', n: 4 },
    { to_object_type: 'contacts', result: 'removed', n: 2 },
  ]);

  const restoreDry = await restoreContactAssociations(h.ctx({ dryRun: true }), { runId: live.runId });
  assert.equal(restoreDry.planned, 6);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.contact), [ids.stdNamed]);

  const restored = await restoreContactAssociations(h.ctx(), { runId: live.runId });
  assert.equal(restored.status, 'ok');
  assert.equal(restored.restored, 6);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact).sort(), [ids.named, ids.colleague1, ids.colleague2].sort());
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.contact).sort(), [ids.stdNamed, ids.stdColleague, ids.stdOther].sort());
  assert.deepEqual(fake.associationTypes(P.quote, ids.quote, P.contact, ids.stdOther), [103]);
  assert.deepEqual(fake.associationTypes(P.quote, ids.quote, P.epicorContact, ids.colleague1), [148]);
  assert.equal(await h.count('contact_cleanup_removals', 'restored_at IS NOT NULL'), 6);

  // Restoring the same run twice does nothing the second time.
  const again = await restoreContactAssociations(h.ctx(), { runId: live.runId });
  assert.equal(again.rows, 0);
  await h.cleanup();
});

test('portal shape: with keepLinkedToNamedContact off, every standard Contact association on a cleaned quote is removed', async () => {
  const h = await makePortalHarness({
    mutateMapping: (m) => {
      withB2(m);
      m.contactCleanup.standardContacts.enabled = true;
      m.contactCleanup.standardContacts.keepLinkedToNamedContact = false;
    },
  });
  const { fake } = h;
  const ids = quoteWithContacts(fake, { quote: '420', customerNumber: '99' });
  // A quote with no quote contact number is not eligible: nothing of either kind is removed from it.
  const blank = quoteWithContacts(fake, { quote: '421', customerNumber: '100' });
  fake.updateRecord(P.quote, blank.quote, { quote_contact_number: '' });
  fake.advance(10);
  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(live.standardContacts.associationsRemoved, 3);
  assert.equal(live.standardContacts.associationsLeftOnSkippedHeaders, 3);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.contact), []);
  assert.deepEqual(fake.associated(P.quote, ids.quote, P.epicorContact), [ids.named]);
  assert.equal(fake.associated(P.quote, blank.quote, P.contact).length, 3);
  assert.equal(fake.associated(P.quote, blank.quote, P.epicorContact).length, 3);
  await h.cleanup();
});

test('portal shape: preflight passes for the shipped mapping and only ever reads', async () => {
  const h = await makePortalHarness();
  const result = await runPreflight(h.ctx({ dryRun: true }));
  assert.deepEqual(result.checks.filter((c) => !c.ok), []);
  assert.equal(result.ok, true);
  assert.ok(result.checks.some((c) => c.name === 'association for header_to_deal: type 99'));
  assert.ok(h.fake.requests.every((r) => r.method === 'GET'));
  await h.cleanup();
});

test('nothing but HubSpot is ever contacted: every request of a full cycle goes to the configured HubSpot base URL', async () => {
  const h = await makePortalHarness();
  const { fake } = h;
  const hosts = new Set();
  const paths = new Set();
  const spy = (input, init) => {
    const url = new URL(String(input));
    hosts.add(url.host);
    paths.add(url.pathname.split('/').slice(1, 3).join('/'));
    return fake.fetch(input, init);
  };
  family(fake, { quote: '500', customerUid: '5', customerNumber: '6' });
  fake.addRecord(P.line, { quote_number: '500' });
  fake.addRecord(P.task, { quote_id: '500' });
  fake.addRecord(P.ic, { customer_uid: '5' });
  fake.advance(10);
  const ctx = h.ctx({ clientOptions: { fetchImpl: spy } });
  await executeRun(ctx, { mode: 'incremental' });
  await executeRun(ctx, { mode: 'full', dealAmounts: true });
  await runPreflight(ctx);
  assert.ok(fake.requests.length > 20);
  assert.deepEqual([...hosts], ['fake.hubspot.test']);
  for (const p of paths) assert.match(p, /^(crm\/(objects|associations|properties)|crm-object-schemas\/)/);
  await h.cleanup();
});
