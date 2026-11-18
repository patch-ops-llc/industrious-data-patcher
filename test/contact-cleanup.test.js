import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { getRun, removalsForRun } from '../src/db/store.js';
import { restoreContactAssociations, runContactCleanup } from '../src/engine/contactCleanup.js';
import { makeHarness, T } from './helpers.js';

function quoteWithContacts(fake, { quote, contactNumber, contacts }) {
  const header = fake.addRecord(T.header, { epicor_quote_num: quote, epicor_quote_contact_num: contactNumber });
  const ids = contacts.map((number) => fake.addRecord(T.contact, { epicor_contact_num: number }));
  for (const id of ids) fake.associate(T.header, header, T.contact, id, 111);
  return { header, contacts: ids };
}

const backupRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('B2 cleanup: dry run lists what would be removed and removes nothing', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const q = quoteWithContacts(fake, { quote: 'Q1', contactNumber: 'K2', contacts: ['K1', 'K2', 'K3'] });

  const dry = await runContactCleanup(h.ctx({ dryRun: true }), { outputDir: h.outputDir });
  assert.equal(dry.status, 'ok');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.associationsSeen, 3);
  assert.equal(dry.associationsKept, 1);
  assert.equal(dry.associationsToRemove, 2);
  assert.equal(dry.associationsRemoved, 0);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.associated(T.header, q.header, T.contact).length, 3);
  assert.match(dry.backupFile, /-dryrun\.jsonl$/);
  assert.deepEqual(backupRows(dry.backupFile).map((r) => r.toId).sort(), [q.contacts[0], q.contacts[2]].sort());
  const planned = await removalsForRun(h.db, dry.runId);
  assert.deepEqual(planned.map((r) => [r.toId, r.result]).sort(), [[q.contacts[0], 'planned'], [q.contacts[2], 'planned']].sort());
  const stored = await getRun(h.db, dry.runId);
  assert.equal(stored.mode, 'cleanup-contacts');
  assert.equal(stored.dryRun, true);
  assert.equal(stored.summary.associationsToRemove, 2);
  await h.cleanup();
});

test('B2 cleanup: live run keeps only the contact named on the quote, backs up every removal, and can be restored from the file or by run ID', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const q = quoteWithContacts(fake, { quote: 'Q1', contactNumber: 'K2', contacts: ['K1', 'K2', 'K3'] });
  // One of the contacts to be removed also carries a labelled association.
  fake.associate(T.header, q.header, T.contact, q.contacts[0], 113);
  const untouched = quoteWithContacts(fake, { quote: 'Q2', contactNumber: 'K9', contacts: ['K9'] });

  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(live.status, 'ok');
  assert.equal(live.associationsRemoved, 2);
  assert.equal(live.associationsFailed, 0);
  assert.equal(live.headersChanged, 1);
  assert.deepEqual(fake.associated(T.header, q.header, T.contact), [q.contacts[1]]);
  assert.deepEqual(fake.associated(T.contact, q.contacts[0], T.header), []);
  assert.deepEqual(fake.associated(T.header, untouched.header, T.contact), untouched.contacts);
  assert.ok(fake.writes.every((w) => w.kind === 'archive'));
  assert.equal(await h.count('run_lock'), 0);

  const rows = backupRows(live.backupFile);
  assert.equal(rows.length, 2);
  const labelled = rows.find((r) => r.toId === q.contacts[0]);
  assert.deepEqual(labelled.types.map((t) => t.typeId).sort(), [111, 113]);
  assert.equal(labelled.toObjectType, 'contacts');
  const inDb = await removalsForRun(h.db, live.runId);
  assert.deepEqual(inDb.map((r) => r.result), ['removed', 'removed']);
  assert.deepEqual(inDb.find((r) => r.toId === q.contacts[0]).types.map((t) => t.typeId).sort(), [111, 113]);

  // Running it again finds nothing left to remove.
  const again = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(again.associationsToRemove, 0);

  const restoreDry = await restoreContactAssociations(h.ctx({ dryRun: true }), { file: live.backupFile });
  assert.equal(restoreDry.planned, 2);
  assert.deepEqual(fake.associated(T.header, q.header, T.contact), [q.contacts[1]]);

  const restored = await restoreContactAssociations(h.ctx(), { file: live.backupFile });
  assert.equal(restored.status, 'ok');
  assert.equal(restored.restored, 2);
  assert.deepEqual(fake.associated(T.header, q.header, T.contact).sort(), [...q.contacts].sort());
  assert.deepEqual(fake.associationTypes(T.header, q.header, T.contact, q.contacts[0]), [111, 113]);

  // And the same from the staging database, by run ID.
  const second = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(second.associationsRemoved, 2);
  fs.rmSync(second.backupFile);
  const byId = await restoreContactAssociations(h.ctx(), { runId: second.runId });
  assert.equal(byId.restored, 2);
  assert.deepEqual(fake.associationTypes(T.header, q.header, T.contact, q.contacts[0]), [111, 113]);
  assert.deepEqual(fake.associated(T.header, q.header, T.contact).sort(), [...q.contacts].sort());

  const unknown = await restoreContactAssociations(h.ctx(), { runId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(unknown.status, 'failed');
  await h.cleanup();
});

test('B2 cleanup: quotes without a quote contact number, with a named contact that is missing, or with an ambiguous one are left alone', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const blank = quoteWithContacts(fake, { quote: 'Q1', contactNumber: '', contacts: ['A1', 'A2'] });
  const missing = quoteWithContacts(fake, { quote: 'Q2', contactNumber: 'NOT-IN-HUBSPOT', contacts: ['B1', 'B2'] });
  const ambiguous = quoteWithContacts(fake, { quote: 'Q3', contactNumber: 'D1', contacts: ['D1', 'D1', 'D2'] });

  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.deepEqual(live.headersSkipped, {
    missing_quote_contact_number: 1,
    named_contact_not_found: 1,
    named_contact_ambiguous: 1,
  });
  assert.equal(live.associationsLeftOnSkippedHeaders, 7);
  assert.equal(live.associationsRemoved, 0);
  assert.equal(fake.writes.length, 0);
  for (const q of [blank, missing, ambiguous]) assert.equal(fake.associated(T.header, q.header, T.contact).length, q.contacts.length);
  await h.cleanup();
});

test('B2 cleanup: requireNamedContactFound false removes every contact from a quote whose named contact is not in HubSpot', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.contactCleanup.requireNamedContactFound = false; } });
  const { fake } = h;
  const missing = quoteWithContacts(fake, { quote: 'Q2', contactNumber: 'NOT-IN-HUBSPOT', contacts: ['B1', 'B2'] });
  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(live.associationsRemoved, 2);
  assert.deepEqual(fake.associated(T.header, missing.header, T.contact), []);
  await h.cleanup();
});

test('B2 cleanup: removeOnlyTypeIds keeps associations that carry any other type; --limit changes only that many quotes', async () => {
  const h = await makeHarness({ mutateMapping: (m) => { m.contactCleanup.removeOnlyTypeIds = [111]; } });
  const { fake } = h;
  const q = quoteWithContacts(fake, { quote: 'Q1', contactNumber: 'K2', contacts: ['K1', 'K2', 'K3'] });
  fake.associate(T.header, q.header, T.contact, q.contacts[0], 113);
  const second = quoteWithContacts(fake, { quote: 'Q2', contactNumber: 'M1', contacts: ['M1', 'M2'] });

  const limited = await runContactCleanup(h.ctx(), { outputDir: h.outputDir, limit: 1 });
  assert.equal(limited.headersScanned, 2);
  assert.equal(limited.headersChanged, 1);
  assert.equal(limited.headersNotAttempted, 1);
  assert.equal(limited.associationsPreservedOtherTypes, 1);
  assert.equal(limited.associationsRemoved, 1);
  assert.deepEqual(fake.associated(T.header, q.header, T.contact).sort(), [q.contacts[0], q.contacts[1]].sort());
  assert.equal(fake.associated(T.header, second.header, T.contact).length, 2);
  await h.cleanup();
});

test('B2 cleanup: a batch that HubSpot rejects is counted as failed, recorded as failed in the backup, and the run reports errors', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const q = quoteWithContacts(fake, { quote: 'Q1', contactNumber: 'K2', contacts: ['K1', 'K2'] });
  fake.failNext({ method: 'POST', pathIncludes: '/batch/archive', status: 400, body: { status: 'error', message: 'nope' } });
  const live = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(live.status, 'completed_with_errors');
  assert.equal(live.associationsFailed, 1);
  assert.equal(fake.associated(T.header, q.header, T.contact).length, 2);
  assert.deepEqual((await removalsForRun(h.db, live.runId)).map((r) => r.result), ['failed']);
  // Nothing was removed, so a restore of that run has nothing to put back.
  const restore = await restoreContactAssociations(h.ctx(), { runId: live.runId });
  assert.equal(restore.rows, 0);
  await h.cleanup();
});

test('B2 cleanup: a live cleanup does not start while another live run holds the run lock', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const q = quoteWithContacts(fake, { quote: 'Q1', contactNumber: 'K2', contacts: ['K1', 'K2'] });
  await h.db.query(`INSERT INTO run_lock (id, holder, taken_at) VALUES (1, 'scheduled-run', $1::timestamptz)`, [new Date(fake.clock).toISOString()]);
  const skipped = await runContactCleanup(h.ctx(), { outputDir: h.outputDir });
  assert.equal(skipped.status, 'skipped');
  assert.equal(fake.requests.length, 0);
  assert.equal(fake.associated(T.header, q.header, T.contact).length, 2);
  await h.cleanup();
});
