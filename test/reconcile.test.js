import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getRun, lastRun } from '../src/db/store.js';
import { executeRun } from '../src/engine/run.js';
import { compactSummary, renderRunMarkdown, ruleCounts, summaryLines, writeRunReport } from '../src/report.js';
import { addQuoteFamily, makeHarness, T } from './helpers.js';

test('full run: every record is checked, gaps are filled, and the report shows association counts before and after', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const a = addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1', lines: 3, tasks: 2 });
  const b = addQuoteFamily(fake, { quote: 'Q2', customer: 'C2', contactNumber: '2', lines: 2, tasks: 1 });
  // Some of it is already associated, as the existing workflows would have left it.
  fake.associate(T.line, a.lines[0], T.header, a.header, 101);
  fake.associate(T.header, b.header, T.company, b.company, 107);
  const orphanLine = fake.addRecord(T.line, { epicor_quote_num: 'NO-SUCH-QUOTE' });
  const blankLine = fake.addRecord(T.line, {});
  fake.advance(60 * 24 * 90);

  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'full' });
  assert.equal(dry.status, 'ok');
  const dryLines = ruleCounts(h.rule(dry, 'lines_to_header'), true);
  assert.deepEqual(dryLines, {
    checked: 7, before: 1, filled: 4, after: 5, noTarget: 1, noMatchButAssociated: 0, multipleTargets: 0, missingKey: 1,
    multipleTargetKeys: 0, associatedElsewhere: 0, addedAlongsideOther: 0, notAttempted: 0, failed: 0,
  });
  assert.equal(fake.writes.length, 0);

  const live = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(live.status, 'ok');
  assert.deepEqual(ruleCounts(h.rule(live, 'lines_to_header'), false), dryLines);
  assert.deepEqual(ruleCounts(h.rule(live, 'header_to_company'), false).before, 1);
  assert.deepEqual(ruleCounts(h.rule(live, 'header_to_company'), false).filled, 1);
  for (const line of [...a.lines, ...b.lines]) assert.equal(fake.associated(T.line, line, T.header).length, 1);
  assert.deepEqual(fake.associated(T.line, orphanLine, T.header), []);
  assert.deepEqual(await h.review('lines_to_header'), { [orphanLine]: 'no_target', [blankLine]: 'missing_key' });

  fake.advance(30);
  const again = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(h.rule(again, 'lines_to_header').created, 0);
  assert.equal(h.rule(again, 'lines_to_header').alreadyAssociated, 5);
  // A full run re-reads every matched record's associations from HubSpot instead of trusting staging.
  assert.equal(h.rule(again, 'lines_to_header').associationsRead, 5);

  const files = writeRunReport(path.join(h.outputDir, 'reports'), live);
  const markdown = fs.readFileSync(files.markdown, 'utf8');
  assert.match(markdown, /# Reconciliation report/);
  assert.match(markdown, /LIVE RUN/);
  assert.match(markdown, /## Staging database/);
  assert.match(markdown, /\| quoteLine \| 7 \| every record \| 0 \|/);
  assert.match(markdown, /\| B1 \| Lines to header \| 7 \| 1 \| 4 \| 5 \| 1 \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(markdown, /## Held for review/);
  const unresolved = fs.readFileSync(files.unresolved, 'utf8');
  assert.match(unresolved, new RegExp(`lines_to_header,${orphanLine},no_target`));
  assert.match(unresolved, new RegExp(`lines_to_header,${blankLine},missing_key`));
  const created = fs.readFileSync(files.associations, 'utf8').trim().split('\n');
  assert.equal(created[0], 'rule,from_record_id,to_record_id,result');
  assert.ok(created.includes(`lines_to_header,${a.lines[1]},${a.header},created`));
  assert.match(renderRunMarkdown(dry), /DRY RUN: nothing was changed/);

  // The same report is kept in the staging database, without the per-record lists.
  const stored = await getRun(h.db, live.runId);
  assert.equal(stored.status, 'ok');
  assert.equal(stored.mode, 'full');
  assert.equal(stored.dryRun, false);
  assert.equal(stored.stateSaved, true);
  assert.equal(stored.reportMarkdown, renderRunMarkdown(live));
  assert.equal(stored.summary.rules[0].created, 4);
  assert.equal(stored.summary.rules[0].unresolved, undefined);
  assert.equal(stored.summary.rules[0].links, undefined);
  assert.equal((await lastRun(h.db)).runId, again.runId);
  assert.deepEqual(compactSummary(live).rules.map((r) => r.id), live.rules.map((r) => r.id));
  assert.match(summaryLines(live).join('\n'), /Lines to header: checked 7, filled 4, no match 1, held for review 0, failed 0/);
  await h.cleanup();
});

test('full run pages past the 10,000-result search limit and through large association lists', async () => {
  const h = await makeHarness({ fakeOptions: { searchResultCap: 400, associationPageSize: 50 } });
  const { fake } = h;
  const header = fake.addRecord(T.header, { epicor_quote_num: 'BIG' });
  const lines = [];
  for (let i = 0; i < 1250; i += 1) lines.push(fake.addRecord(T.line, { epicor_quote_num: 'BIG' }));
  for (const line of lines.slice(0, 120)) fake.associate(T.line, line, T.header, header, 101);
  fake.advance(10);

  const live = await executeRun(h.ctx(), { mode: 'full' });
  assert.equal(live.status, 'ok');
  const rule = h.rule(live, 'lines_to_header');
  assert.equal(rule.sources, 1250);
  assert.equal(rule.alreadyAssociated, 120);
  assert.equal(rule.created, 1130);
  assert.equal(fake.associated(T.header, header, T.line).length, 1250);
  assert.equal(await h.count('staging_records', "object_key = 'quoteLine'"), 1250);
  assert.equal(await h.count('staging_associations', `from_object_type = '${T.line}'`), 1250);
  assert.equal(await h.count('association_actions', "result = 'created'"), 1130);

  // The next scheduled run works from staging: no association is read again and nothing is written.
  fake.advance(30);
  const requests = fake.requests.length;
  const next = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(h.rule(next, 'lines_to_header').alreadyAssociated, 1250);
  assert.equal(h.rule(next, 'lines_to_header').associationsRead, 0);
  assert.ok(fake.requests.slice(requests).every((r) => r.path.endsWith('/search')));
  await h.cleanup();
});

test('a run is recorded even when it fails, with a stored report that says so', async () => {
  const h = await makeHarness();
  h.fake.addRecord(T.line, { epicor_quote_num: 'Q' });
  h.fake.failNext({ pathIncludes: '/search', status: 500, times: 50 });
  const run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.status, 'failed');
  const stored = await getRun(h.db, run.runId);
  assert.equal(stored.status, 'failed');
  assert.match(stored.reportMarkdown, /Status: failed/);
  assert.ok(stored.finishedAt);
  await h.cleanup();
});
