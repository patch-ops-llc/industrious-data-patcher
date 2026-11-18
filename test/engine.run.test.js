import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeRun } from '../src/engine/run.js';
import { addQuoteFamily, makeHarness, T } from './helpers.js';

test('lines and tasks that arrive before their header are linked once the header arrives, then left alone', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const line1 = fake.addRecord(T.line, { epicor_quote_num: 'Q100' });
  const line2 = fake.addRecord(T.line, { epicor_quote_num: 'Q100' });
  const task1 = fake.addRecord(T.task, { epicor_quote_num: 'Q100' });

  fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.status, 'ok');
  assert.equal(h.rule(first, 'lines_to_header').noTarget, 2);
  assert.equal(h.rule(first, 'tasks_to_header').noTarget, 1);
  assert.equal(fake.writes.length, 0);
  assert.deepEqual(await h.review('lines_to_header'), { [line1]: 'no_target', [line2]: 'no_target' });

  // The header lands two hours later. Nothing touches the lines again.
  fake.advance(120);
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q100' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'ok');
  assert.equal(second.ingest.quoteLine.mode, 'changes');
  assert.equal(second.ingest.quoteLine.records, 0);
  assert.equal(h.rule(second, 'lines_to_header').created, 2);
  assert.equal(h.rule(second, 'tasks_to_header').created, 1);
  assert.deepEqual(fake.associated(T.line, line1, T.header), [header]);
  assert.deepEqual(fake.associated(T.line, line2, T.header), [header]);
  assert.deepEqual(fake.associated(T.task, task1, T.header), [header]);
  assert.deepEqual(fake.associated(T.header, header, T.line).sort(), [line1, line2].sort());
  assert.deepEqual(await h.review('lines_to_header'), {});
  assert.deepEqual(await h.review('tasks_to_header'), {});
  // The closed items are kept, with the time they were resolved.
  assert.equal(await h.count('review_items', "rule_id = 'lines_to_header' AND resolved_at IS NOT NULL"), 2);

  // A third run has nothing to do: it writes nothing and does not even re-read associations.
  const writesBefore = fake.writes.length;
  fake.advance(30);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(third.status, 'ok');
  assert.equal(fake.writes.length, writesBefore);
  assert.equal(third.rules.reduce((n, r) => n + r.created + r.failed, 0), 0);
  assert.equal(h.rule(third, 'lines_to_header').alreadyAssociated, 2);
  assert.equal(h.rule(third, 'lines_to_header').associationsRead, 0);
  await h.cleanup();
});

test('all five Item B1 association types and the Item B2 contact association are created with the configured types', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q200', customer: 'C1', contactNumber: '7' });
  const ic = fake.addRecord(T.ic, { epicor_cust_id: 'C1' });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(summary.status, 'ok');
  assert.deepEqual(summary.rules.map((r) => r.id), [
    'lines_to_header', 'tasks_to_header', 'header_to_deal', 'header_to_company', 'ic_codes_to_company', 'contacts_to_header',
  ]);

  for (const line of ids.lines) assert.deepEqual(fake.associationTypes(T.line, line, T.header, ids.header), [101]);
  for (const task of ids.tasks) assert.deepEqual(fake.associationTypes(T.task, task, T.header, ids.header), [103]);
  assert.deepEqual(fake.associationTypes(T.header, ids.header, T.deal, ids.deal), [105]);
  assert.deepEqual(fake.associationTypes(T.header, ids.header, T.company, ids.company), [107]);
  assert.deepEqual(fake.associationTypes(T.ic, ic, T.company, ids.company), [109]);
  assert.deepEqual(fake.associationTypes(T.header, ids.header, T.contact, ids.contact), [111]);
  // HubSpot keeps the reverse direction itself.
  assert.deepEqual(fake.associationTypes(T.deal, ids.deal, T.header, ids.header), [106]);

  // Rules run in the order the spec lists them.
  const order = fake.writes.filter((w) => w.kind.startsWith('associate')).map((w) => `${w.from}>${w.to}`);
  assert.deepEqual(order, [
    `${T.line}>${T.header}`, `${T.task}>${T.header}`, `${T.header}>deals`, `${T.header}>companies`, `${T.ic}>companies`, `${T.header}>contacts`,
  ]);

  // Every association created is logged against the run in the staging database.
  const { rows } = await h.db.query('SELECT rule_id, result, count(*)::int AS n FROM association_actions WHERE run_id = $1 GROUP BY rule_id, result ORDER BY rule_id', [summary.runId]);
  assert.deepEqual(rows, [
    { rule_id: 'contacts_to_header', result: 'created', n: 1 },
    { rule_id: 'header_to_company', result: 'created', n: 1 },
    { rule_id: 'header_to_deal', result: 'created', n: 1 },
    { rule_id: 'ic_codes_to_company', result: 'created', n: 1 },
    { rule_id: 'lines_to_header', result: 'created', n: 2 },
    { rule_id: 'tasks_to_header', result: 'created', n: 1 },
  ]);
  await h.cleanup();
});

test('existing associations are left untouched and only gaps are filled', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q300', customer: 'C3', contactNumber: '9', lines: 2, tasks: 0 });
  const otherHeader = fake.addRecord(T.header, { epicor_quote_num: 'Q-OTHER' });

  // Line 0 is already correctly linked. Line 1 is linked to the wrong header only.
  fake.associate(T.line, ids.lines[0], T.header, ids.header, 101);
  fake.associate(T.line, ids.lines[1], T.header, otherHeader, 101);
  // The named contact is already on the quote with a custom label.
  fake.associate(T.header, ids.header, T.contact, ids.contact, 111);
  fake.associate(T.header, ids.header, T.contact, ids.contact, 113);

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(summary.status, 'ok');
  const lines = h.rule(summary, 'lines_to_header');
  assert.equal(lines.alreadyAssociated, 1);
  assert.equal(lines.created, 1);
  assert.equal(lines.addedAlongsideOther, 1);

  const lineWrites = fake.writes.filter((w) => w.from === T.line);
  assert.equal(lineWrites.length, 1);
  assert.deepEqual(lineWrites[0].inputs.map((i) => i.from.id), [ids.lines[1]]);
  // The wrong link stays; the right one is added.
  assert.deepEqual(fake.associated(T.line, ids.lines[1], T.header).sort(), [ids.header, otherHeader].sort());

  // The labeled contact association was not rewritten.
  assert.equal(h.rule(summary, 'contacts_to_header').alreadyAssociated, 1);
  assert.equal(fake.writes.filter((w) => w.to === 'contacts').length, 0);
  assert.deepEqual(fake.associationTypes(T.header, ids.header, T.contact, ids.contact), [111, 113]);
  await h.cleanup();
});

test('ifAssociatedElsewhere "skip" holds a record that already has a different parent for review instead of adding a second one', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.rules[0].ifAssociatedElsewhere = 'skip'; } });
  const { fake } = h;
  const right = fake.addRecord(T.header, { epicor_quote_num: 'Q310' });
  const wrong = fake.addRecord(T.header, { epicor_quote_num: 'Q311' });
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q310' });
  fake.associate(T.line, line, T.header, wrong, 101);

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  const lines = h.rule(summary, 'lines_to_header');
  assert.equal(lines.associatedElsewhere, 1);
  assert.equal(lines.created, 0);
  assert.deepEqual(fake.associated(T.line, line, T.header), [wrong]);
  assert.deepEqual(await h.review('lines_to_header'), { [line]: 'associated_elsewhere' });
  assert.ok(right);
  await h.cleanup();
});

test('a header whose deal and company do not exist yet is associated on the run after they appear', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q400', epicor_cust_id: 'C4' });

  fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(first, 'header_to_deal').noTarget, 1);
  assert.equal(h.rule(first, 'header_to_company').noTarget, 1);

  // Nothing changes for ten hours: the header keeps being reported and nothing is written.
  fake.advance(600);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(second, 'header_to_deal').noTarget, 1);
  assert.deepEqual(await h.review('header_to_deal'), { [header]: 'no_target' });
  assert.equal(fake.writes.length, 0);

  // The deal and the company arrive. The header itself is not modified.
  const deal = fake.addRecord(T.deal, { epicor_quote_num: 'Q400', amount: '10' });
  const company = fake.addRecord(T.company, { epicor_cust_id: 'C4' });
  fake.advance(10);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(third.ingest.quoteHeader.records, 0);
  assert.equal(h.rule(third, 'header_to_deal').created, 1);
  assert.equal(h.rule(third, 'header_to_company').created, 1);
  assert.deepEqual(fake.associated(T.header, header, T.deal), [deal]);
  assert.deepEqual(fake.associated(T.header, header, T.company), [company]);
  assert.deepEqual(await h.review('header_to_deal'), {});
  await h.cleanup();
});

test('a record that matches more than one parent is held for review, unless the rule says associate_all', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const headerA = fake.addRecord(T.header, { epicor_quote_num: 'Q500' });
  const headerB = fake.addRecord(T.header, { epicor_quote_num: 'Q500' });
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q500' });
  const line2 = fake.addRecord(T.line, { epicor_quote_num: 'q500 ' });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  const lines = h.rule(summary, 'lines_to_header');
  assert.equal(lines.multipleTargets, 2);
  assert.equal(lines.multipleTargetKeys, 1);
  assert.equal(lines.created, 0);
  assert.deepEqual(fake.associated(T.line, line, T.header), []);
  assert.equal(lines.unresolved[0].status, 'multiple_targets');
  assert.match(lines.unresolved[0].detail, new RegExp(`${headerA}, ${headerB}`));
  assert.deepEqual(await h.review('lines_to_header'), { [line]: 'multiple_targets', [line2]: 'multiple_targets' });
  await h.cleanup();

  const h2 = await makeHarness({ mutateMapping: (m) => { m.rules[0].onMultipleTargets = 'associate_all'; } });
  const a = h2.fake.addRecord(T.header, { epicor_quote_num: 'Q500' });
  const b = h2.fake.addRecord(T.header, { epicor_quote_num: 'Q500' });
  const l = h2.fake.addRecord(T.line, { epicor_quote_num: 'Q500' });
  h2.fake.advance(1);
  await executeRun(h2.ctx(), { mode: 'incremental' });
  assert.deepEqual(h2.fake.associated(T.line, l, T.header).sort(), [a, b].sort());
  await h2.cleanup();
});

test('records with a blank Epicor ID are reported; keys match ignoring case and surrounding spaces; filler values count as blank', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.keyNormalization = { caseInsensitive: true, treatAsBlank: ['0', 'NULL'] }; } });
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'QX-77' });
  fake.addRecord(T.header, { epicor_quote_num: '0' });
  const blank = fake.addRecord(T.line, {});
  const zero = fake.addRecord(T.line, { epicor_quote_num: '0' });
  const filler = fake.addRecord(T.line, { epicor_quote_num: ' Null ' });
  const spaced = fake.addRecord(T.line, { epicor_quote_num: ' qx-77 ' });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  const lines = h.rule(summary, 'lines_to_header');
  assert.equal(lines.missingKey, 3);
  assert.equal(lines.created, 1);
  assert.deepEqual(fake.associated(T.line, spaced, T.header), [header]);
  assert.deepEqual(fake.associated(T.line, zero, T.header), []);
  assert.deepEqual(await h.review('lines_to_header'), { [blank]: 'missing_key', [zero]: 'missing_key', [filler]: 'missing_key' });
  await h.cleanup();
});

test('keys are compared exactly when caseInsensitive is false', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.keyNormalization = { caseInsensitive: false }; } });
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'QX-78' });
  const same = fake.addRecord(T.line, { epicor_quote_num: 'QX-78' });
  const lower = fake.addRecord(T.line, { epicor_quote_num: 'qx-78' });
  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(summary, 'lines_to_header').created, 1);
  assert.equal(h.rule(summary, 'lines_to_header').noTarget, 1);
  assert.deepEqual(fake.associated(T.line, same, T.header), [header]);
  assert.deepEqual(fake.associated(T.line, lower, T.header), []);
  await h.cleanup();
});

test('dry run sends no writes to HubSpot, fills the staging copy, keeps run state untouched, and reports what a live run would do', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const ids = addQuoteFamily(fake, { quote: 'Q600', customer: 'C6', contactNumber: '3', amount: '500', dealAmount: '400' });

  fake.advance(10);
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.status, 'ok');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.stateSaved, false);
  assert.equal(fake.writes.length, 0);
  assert.ok(fake.requests.every((r) => r.method === 'GET' || /\/search$|\/batch\/read$/.test(r.path)));
  assert.equal(h.rule(dry, 'lines_to_header').planned, 2);
  assert.equal(h.rule(dry, 'lines_to_header').associationsPlanned, 2);
  assert.equal(h.rule(dry, 'header_to_deal').planned, 1);
  assert.deepEqual(h.rule(dry, 'header_to_deal').links, [{ fromId: ids.header, toId: ids.deal, planned: true }]);
  assert.deepEqual(fake.associated(T.header, ids.header, T.deal), []);
  assert.equal(dry.api.writesSkippedInDryRun > 0, true);

  // Staging holds the records; the run and its plan are stored; nothing that steers later runs was written.
  assert.equal(await h.count('staging_records'), 7);
  assert.equal(await h.count('runs', 'dry_run AND status = \'ok\' AND report_markdown IS NOT NULL'), 1);
  assert.equal(await h.count('association_actions', "result = 'planned'"), 6);
  assert.equal(await h.count('association_actions', "result = 'created'"), 0);
  assert.equal(await h.count('review_items'), 0);
  assert.equal(await h.count('deal_amount_baselines'), 0);
  assert.equal(await h.count('run_lock'), 0);
  // A planned association is not stored as an existing one.
  assert.equal(await h.count('staging_associations'), 0);

  // The live run that follows does exactly what the dry run said, even though the dry run already ingested the records.
  fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(live.ingest.quoteLine.records, 0);
  assert.equal(h.rule(live, 'lines_to_header').created, 2);
  assert.equal(h.rule(live, 'header_to_deal').created, 1);
  assert.deepEqual(fake.associated(T.header, ids.header, T.deal), [ids.deal]);
  assert.equal(live.stateSaved, true);
  assert.equal(await h.count('run_lock'), 0);
  assert.equal(await h.count('deal_amount_baselines'), 1);
  await h.cleanup();
});

test('the first run copies every record into staging; later runs only read what was created or modified since, with an overlap', async () => {
  const h = await makeHarness({ settings: { changeOverlapMinutes: 5 } });
  const { fake } = h;
  fake.addRecord(T.header, { epicor_quote_num: 'OLD' });
  const oldLine = fake.addRecord(T.line, { epicor_quote_num: 'OLD' });
  fake.advance(60 * 24 * 40);
  fake.addRecord(T.header, { epicor_quote_num: 'NEW' });
  const newLine = fake.addRecord(T.line, { epicor_quote_num: 'NEW' });

  fake.advance(10);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.ingest.quoteLine.mode, 'full');
  assert.equal(first.ingest.quoteLine.records, 2);
  assert.equal(first.ingest.deal.mode, 'full');
  // The backlog is picked up without a separate reconcile: a 40-day-old line is linked too.
  assert.equal(fake.associated(T.line, newLine, T.header).length, 1);
  assert.equal(fake.associated(T.line, oldLine, T.header).length, 1);

  const firstStart = Date.parse(first.startedAt);
  fake.advance(30);
  const searchesBefore = fake.requests.length;
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.ingest.quoteLine.mode, 'changes');
  assert.equal(Date.parse(second.ingest.quoteLine.since), firstStart - 5 * 60_000);
  assert.equal(second.ingest.quoteLine.records, 0);
  const searches = fake.requests.slice(searchesBefore).filter((r) => r.path.endsWith('/search'));
  assert.ok(searches.length > 0);
  assert.ok(searches.every((r) => r.body.filterGroups.length === 2 && r.body.filterGroups.every((g) => g.filters[0].operator === 'GTE')));
  await h.cleanup();
});

test('once the last full copy is older than FULL_REFRESH_HOURS a scheduled run re-reads everything and repairs the staging copy', async () => {
  const h = await makeHarness({ settings: { fullRefreshHours: 24 } });
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q650' });
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q650' });
  const doomed = fake.addRecord(T.line, { epicor_quote_num: 'NOPE' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(fake.associated(T.line, line, T.header), [header]);

  // Someone removes the association by hand and deletes a line. Neither shows up as a modified record.
  fake.links.get(`${T.line}>${T.header}`).get(line).delete(header);
  fake.deleteRecord(T.line, doomed);

  fake.advance(60);
  const soon = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(soon.ingest.quoteLine.mode, 'changes');
  assert.equal(h.rule(soon, 'lines_to_header').created, 0);
  assert.equal(h.rule(soon, 'lines_to_header').noTarget, 1);

  fake.advance(60 * 24);
  const later = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(later.ingest.quoteLine.mode, 'full');
  assert.equal(later.ingest.quoteLine.markedMissing, 1);
  assert.equal(h.rule(later, 'lines_to_header').sources, 1);
  assert.equal(h.rule(later, 'lines_to_header').created, 1);
  assert.deepEqual(fake.associated(T.line, line, T.header), [header]);
  assert.deepEqual(await h.review('lines_to_header'), {});

  // FULL_REFRESH_HOURS=0 switches the periodic refresh off.
  const h2 = await makeHarness({ settings: { fullRefreshHours: 0 } });
  h2.fake.addRecord(T.line, { epicor_quote_num: 'X' });
  h2.fake.advance(1);
  await executeRun(h2.ctx(), { mode: 'incremental' });
  h2.fake.advance(60 * 24 * 30);
  const never = await executeRun(h2.ctx(), { mode: 'incremental' });
  assert.equal(never.ingest.quoteLine.mode, 'changes');
  await h2.cleanup();
  await h.cleanup();
});

test('when HubSpot rejects part of a batch the failed records are reported, kept for review, and filled on the next run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q700' });
  const good = fake.addRecord(T.line, { epicor_quote_num: 'Q700' });
  const bad = fake.addRecord(T.line, { epicor_quote_num: 'Q700' });
  fake.rejectInputsOnce({ pathIncludes: `/${T.line}/${T.header}/batch/create`, predicate: (input) => input.from.id === bad });

  fake.advance(1);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(first.status, 'completed_with_errors');
  const lines = h.rule(first, 'lines_to_header');
  assert.equal(lines.created, 1);
  assert.equal(lines.failed, 1);
  assert.equal(lines.unresolved.find((u) => u.id === bad).status, 'failed');
  assert.deepEqual(fake.associated(T.line, good, T.header), [header]);
  assert.deepEqual(await h.review('lines_to_header'), { [bad]: 'failed' });

  fake.advance(30);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'ok');
  assert.equal(h.rule(second, 'lines_to_header').created, 1);
  assert.deepEqual(fake.associated(T.line, bad, T.header), [header]);
  assert.deepEqual(await h.review('lines_to_header'), {});
  await h.cleanup();
});

test('a record deleted in HubSpot after it was copied into staging is not an error: it is dropped from staging', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q750' });
  fake.advance(1);
  await executeRun(h.ctx(), { mode: 'incremental' });

  // The header is deleted (or merged away) in HubSpot. A line for it arrives afterwards.
  fake.deleteRecord(T.header, header);
  fake.advance(30);
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q750' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.status, 'ok');
  const lines = h.rule(second, 'lines_to_header');
  assert.equal(lines.failed, 0);
  assert.equal(lines.noTarget, 1);
  assert.deepEqual(await h.review('lines_to_header'), { [line]: 'no_target' });
  assert.equal(await h.count('staging_records', `object_key = 'quoteHeader' AND missing_since IS NOT NULL`), 1);

  // Next run: the header is no longer a match candidate, so nothing is attempted.
  const writes = fake.writes.length;
  fake.advance(30);
  const third = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(third, 'lines_to_header').noTarget, 1);
  assert.equal(fake.writes.length, writes);
  await h.cleanup();
});

test('a run that cannot reach HubSpot is marked failed, is recorded, and leaves run state alone', async () => {
  const h = await makeHarness();
  const { fake } = h;
  fake.addRecord(T.line, { epicor_quote_num: 'Q800' });
  fake.failNext({ pathIncludes: '/search', status: 403, body: { status: 'error', message: 'missing scopes', category: 'MISSING_SCOPES' }, times: 1 });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /403/);
  assert.equal(summary.stateSaved, false);
  const { rows } = await h.db.query('SELECT status, error, state_saved FROM runs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /403/);
  assert.equal(rows[0].state_saved, false);
  assert.equal(await h.count('review_items'), 0);
  assert.equal(await h.count('run_lock'), 0);
  await h.cleanup();
});

test('a composite key (customer ID plus contact number) keeps contacts of other customers off the quote', async () => {
  const h = await makeHarness({
    mutateMapping: (m) => {
      m.rules.find((r) => r.id === 'contacts_to_header').match = [
        { from: 'customerId', to: 'customerId' },
        { from: 'quoteContactNumber', to: 'customerContactNumber' },
      ];
    },
  });
  const { fake } = h;
  const right = fake.addRecord(T.contact, { epicor_contact_num: '1', epicor_cust_id: 'CA' });
  fake.addRecord(T.contact, { epicor_contact_num: '1', epicor_cust_id: 'CB' });
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q900', epicor_cust_id: 'CA', epicor_quote_contact_num: '1' });
  const noCustomer = fake.addRecord(T.header, { epicor_quote_num: 'Q903', epicor_quote_contact_num: '1' });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(summary, 'contacts_to_header').created, 1);
  assert.equal(h.rule(summary, 'contacts_to_header').missingKey, 1);
  assert.deepEqual(fake.associated(T.header, header, T.contact), [right]);
  assert.deepEqual(fake.associated(T.header, noCustomer, T.contact), []);
  await h.cleanup();
});

test('with the contact number alone, two contacts sharing a number make the match ambiguous and nothing is associated', async () => {
  const h = await makeHarness();
  const { fake } = h;
  fake.addRecord(T.contact, { epicor_contact_num: '1', epicor_cust_id: 'CA' });
  fake.addRecord(T.contact, { epicor_contact_num: '1', epicor_cust_id: 'CB' });
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q901', epicor_cust_id: 'CA', epicor_quote_contact_num: '1' });

  fake.advance(1);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(summary, 'contacts_to_header').multipleTargets, 1);
  assert.deepEqual(fake.associated(T.header, header, T.contact), []);
  await h.cleanup();
});

test('a contact that arrives after its quote header is associated on the next run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q902', epicor_quote_contact_num: '55' });
  fake.advance(1);
  await executeRun(h.ctx(), { mode: 'incremental' });
  assert.deepEqual(fake.associated(T.header, header, T.contact), []);

  fake.advance(90);
  const contact = fake.addRecord(T.contact, { epicor_contact_num: '55' });
  fake.advance(10);
  const summary = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(summary, 'contacts_to_header').created, 1);
  assert.deepEqual(fake.associated(T.header, header, T.contact), [contact]);
  await h.cleanup();
});

test('a record whose Epicor ID is corrected later is matched on its new key', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q950' });
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q95O' });
  fake.advance(1);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(first, 'lines_to_header').noTarget, 1);

  fake.advance(30);
  fake.updateRecord(T.line, line, { epicor_quote_num: 'Q950' });
  fake.advance(10);
  const second = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(second.ingest.quoteLine.records, 1);
  assert.equal(h.rule(second, 'lines_to_header').created, 1);
  assert.deepEqual(fake.associated(T.line, line, T.header), [header]);
  await h.cleanup();
});

test('--limit caps how many records are changed per rule; the rest stay for the next run and state is still saved', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'Q960' });
  const lines = [1, 2, 3, 4, 5].map(() => fake.addRecord(T.line, { epicor_quote_num: 'Q960' }));
  const orphan = fake.addRecord(T.line, { epicor_quote_num: 'NONE' });
  fake.advance(1);

  const limited = await executeRun(h.ctx(), { mode: 'full', limit: 2 });
  const stats = h.rule(limited, 'lines_to_header');
  assert.equal(stats.sources, 6);
  assert.equal(stats.created, 2);
  assert.equal(stats.notAttempted, 3);
  assert.equal(fake.associated(T.header, header, T.line).length, 2);
  assert.deepEqual(await h.review('lines_to_header'), { [orphan]: 'no_target' });

  fake.advance(30);
  const rest = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(rest, 'lines_to_header').created, 3);
  assert.deepEqual(fake.associated(T.header, header, T.line).sort(), [...lines].sort());
  await h.cleanup();
});

test('two live runs cannot overlap: the second is skipped while the first holds the run lock, and a dead holder is taken over', async () => {
  const h = await makeHarness({ settings: { runLockStaleMinutes: 15 } });
  const { fake } = h;
  fake.addRecord(T.header, { epicor_quote_num: 'Q970' });
  const line = fake.addRecord(T.line, { epicor_quote_num: 'Q970' });
  fake.advance(1);

  // Another process took the lock a moment ago and started a run.
  await h.db.query(`INSERT INTO run_lock (id, holder, taken_at) VALUES (1, 'other-process', $1::timestamptz)`, [new Date(fake.clock).toISOString()]);
  await h.db.query(`INSERT INTO runs (id, mode, dry_run, started_at, status) VALUES ('other-run', 'incremental', false, $1::timestamptz, 'running')`, [new Date(fake.clock).toISOString()]);

  fake.advance(5);
  const skipped = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(skipped.status, 'skipped');
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.requests.length, 0);
  assert.equal(await h.count('runs'), 1);

  // A dry run does not need the lock.
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.status, 'ok');
  assert.equal(h.rule(dry, 'lines_to_header').planned, 1);

  // The other process never refreshes its lock: after the stale period it is taken over and its run is closed.
  fake.advance(16);
  const live = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(live.status, 'ok');
  assert.equal(h.rule(live, 'lines_to_header').created, 1);
  assert.equal(fake.associated(T.line, line, T.header).length, 1);
  const { rows } = await h.db.query(`SELECT status, error FROM runs WHERE id = 'other-run'`);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /stopped before/);
  assert.equal(await h.count('run_lock'), 0);
  await h.cleanup();
});

test('old runs are pruned after KEEP_RUNS_DAYS; contact cleanup runs (the restore backup) are never pruned', async () => {
  const h = await makeHarness({ settings: { keepRunsDays: 30 } });
  const { fake } = h;
  fake.addRecord(T.header, { epicor_quote_num: 'Q980' });
  fake.addRecord(T.line, { epicor_quote_num: 'Q980' });
  fake.advance(1);
  const first = await executeRun(h.ctx(), { mode: 'incremental' });
  await h.db.query(`INSERT INTO runs (id, mode, dry_run, started_at, status) VALUES ('cleanup-1', 'cleanup-contacts', false, $1::timestamptz, 'ok')`, [first.startedAt]);
  assert.equal(await h.count('association_actions'), 1);

  fake.advance(60 * 24 * 31);
  const later = await executeRun(h.ctx(), { mode: 'incremental' });
  const { rows } = await h.db.query('SELECT id FROM runs ORDER BY started_at');
  assert.deepEqual(rows.map((r) => r.id), ['cleanup-1', later.runId]);
  assert.equal(await h.count('association_actions'), 0);
  await h.cleanup();
});
