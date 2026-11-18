import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMapping, mappingProblems, normalizeMapping } from '../src/config.js';
import { executeRun } from '../src/engine/run.js';
import { objectTypeId, recordUrl, reviewCatalog } from '../src/review.js';
import { startAdmin } from './admin-helpers.js';
import { addQuoteFamily, makeHarness, SHIPPED_MAPPING_FILE, T } from './helpers.js';

const PORTAL = '44686929';
const withPortal = { mutateMapping: (raw) => { raw.portalId = PORTAL; } };
const browser = (a) => ({ origin: a.base, 'sec-fetch-site': 'same-origin' });
const link = (type, id) => `<a class="ext" href="https://app.hubspot.com/contacts/${PORTAL}/record/${type}/${id}" target="_blank" rel="noopener noreferrer">${id}</a>`;
const rowsOf = (text) => text.split('<tbody>')[1].split('</tbody>')[0].trim().split('\n');
const dealAmount = (h, ids) => h.fake.record(T.deal, ids.deal).properties.amount;

async function holdRows(h) {
  const { rows } = await h.db.query('SELECT id, deal_id, amount_after, resolved_at, resolution, released_at, released_amount FROM deal_amount_holds ORDER BY id');
  return rows;
}

test('review: the portal ID is a mapping setting; record links are built from it and from the object type', () => {
  const shipped = loadMapping(SHIPPED_MAPPING_FILE);
  assert.equal(shipped.portalId, PORTAL);
  assert.deepEqual(mappingProblems(shipped).filter((p) => /portalId/.test(p)), []);
  assert.equal(normalizeMapping({ portalId: 44686929 }).portalId, PORTAL);
  assert.equal(normalizeMapping({}).portalId, null);
  for (const bad of ['abc', '12 34', '44686929/../x', '-1']) {
    assert.match(mappingProblems(normalizeMapping({ portalId: bad })).join('\n'), /portalId must be the HubSpot portal \(account\) ID: digits only/, bad);
  }

  assert.equal(recordUrl(PORTAL, '2-45361208', '123'), `https://app.hubspot.com/contacts/${PORTAL}/record/2-45361208/123`);
  assert.equal(recordUrl(PORTAL, 'deals', '9'), `https://app.hubspot.com/contacts/${PORTAL}/record/0-3/9`);
  assert.equal(recordUrl(PORTAL, 'companies', '9'), `https://app.hubspot.com/contacts/${PORTAL}/record/0-2/9`);
  assert.equal(recordUrl(PORTAL, 'contacts', '9'), `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/9`);
  assert.equal(objectTypeId('0-3'), '0-3');
  // No link without a portal ID, for an object type that cannot be told, or for anything that is not a record ID.
  assert.equal(recordUrl(null, 'deals', '9'), null);
  assert.equal(recordUrl('', 'deals', '9'), null);
  assert.equal(recordUrl(PORTAL, 'p_custom_name', '9'), null);
  assert.equal(recordUrl(PORTAL, 'deals', '9/../x'), null);
  assert.equal(recordUrl(PORTAL, 'deals', 'javascript:alert(1)'), null);
  assert.equal(recordUrl('1/evil', 'deals', '9'), null);

  // The shipped mapping: every rule's records can be linked, and the two ways to find a quote's deal are one group.
  const catalog = reviewCatalog(shipped);
  assert.equal(catalog.portalId, PORTAL);
  assert.deepEqual(catalog.pairs.map((p) => [p.id, p.rules.map((r) => r.id)]), [
    ['quoteLine-quoteHeader', ['lines_to_header']],
    ['quoteTask-quoteHeader', ['tasks_to_header']],
    ['quoteHeader-deal', ['header_to_deal', 'header_to_deal_by_quote_number']],
    ['quoteHeader-company', ['header_to_company']],
    ['icCode-company', ['ic_codes_to_company']],
  ]);
  for (const rule of catalog.rules) {
    assert.ok(recordUrl(catalog.portalId, rule.from.objectType, '1'), rule.id);
    assert.ok(recordUrl(catalog.portalId, rule.to.objectType, '1'), rule.id);
  }
  assert.equal(catalog.dealAmount.quoteNumberProperty, 'quote_number');
  assert.equal(recordUrl(catalog.portalId, catalog.dealAmount.deal.objectType, '5'), `https://app.hubspot.com/contacts/${PORTAL}/record/0-3/5`);
});

test('review: the held and unmatched records are listed per kind of record, paged, with links to HubSpot and a CSV download; the pages only read the staging database', async () => {
  const h = await makeHarness(withPortal);
  const { fake } = h;
  addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  // A quote whose number is typed on two deals: held, the service does not pick one.
  const multi = fake.addRecord(T.header, { epicor_quote_num: 'MULTI', epicor_cust_id: 'C1', epicor_quote_contact_num: '1', quote_amount: '10' });
  const dealA = fake.addRecord(T.deal, { epicor_quote_num: 'MULTI', amount: '10' });
  const dealB = fake.addRecord(T.deal, { epicor_quote_num: 'MULTI', amount: '10' });
  // Lines that match nothing: one plain, one that looks like markup, one that looks like a spreadsheet formula.
  const plain = fake.addRecord(T.line, { epicor_quote_num: 'NOPE' });
  const markup = fake.addRecord(T.line, { epicor_quote_num: '<img src=x onerror=alert(1)>' });
  const formula = fake.addRecord(T.line, { epicor_quote_num: '=HYPERLINK("http://evil.example","x")' });
  const noId = fake.addRecord(T.line, { epicor_quote_num: '' });
  for (let i = 0; i < 202; i += 1) fake.addRecord(T.line, { epicor_quote_num: `GONE-${i}` });
  fake.advance(10);

  const a = await startAdmin(h, { mapping: h.mapping, now: () => new Date(fake.clock) });
  const { cookie } = await a.login();

  // Signed out, there is nothing to see.
  for (const url of ['/review', '/review/records?rule=lines_to_header&status=no_target', '/review/records.csv?rule=lines_to_header&status=no_target', '/review/deal-amounts', '/review/deal-amounts.csv']) {
    const signedOut = await a.request('GET', url);
    assert.equal(signedOut.status, 401, url);
    assert.doesNotMatch(signedOut.text, /hubspot\.com|GONE-|NOPE/);
  }

  // Before a live run the lists are empty, and the page says why. A dry run does not fill them.
  await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  let page = await a.request('GET', '/review', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /No live run has finished yet, so these lists are empty: a dry run does not fill them\./);
  assert.doesNotMatch(page.text, /href="\/review\/records/);

  fake.advance(30);
  assert.equal((await executeRun(h.ctx(), { mode: 'incremental' })).status, 'ok');
  const requestsBefore = fake.requests.length;

  // The overview: one block per pair of record types, one row per rule, every count a link to its list.
  page = await a.request('GET', '/review', { cookie });
  assert.match(page.text, /As of the live run finished <span class="nowrap">2026-11-01 00:40 UTC<\/span>\./);
  assert.deepEqual([...page.text.matchAll(/<section class="review-pair" id="([^"]+)">\n<h3>(.*?)<\/h3>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '')]), [
    ['quoteLine-quoteHeader', 'Quote line to Quote header'],
    ['quoteTask-quoteHeader', 'Quote task to Quote header'],
    ['quoteHeader-deal', 'Quote header to Deal'],
    ['quoteHeader-company', 'Quote header to Company'],
    ['icCode-company', 'IC code to Company'],
    ['quoteHeader-contact', 'Quote header to Contact'],
  ]);
  const pair = (id) => page.text.split('<section class="review-pair"').find((part) => part.startsWith(` id="${id}"`));
  assert.match(pair('quoteLine-quoteHeader'), /<td>Lines to header<span class="sub">Matched on <code>epicor_quote_num<\/code><\/span><\/td><td class="num" data-label="Held for review">0<\/td><td class="num" data-label="No match"><a href="\/review\/records\?rule=lines_to_header&amp;status=no_target">205<\/a><\/td><td class="num" data-label="No ID"><a href="\/review\/records\?rule=lines_to_header&amp;status=missing_key">1<\/a><\/td><td class="num" data-label="Failed">0<\/td>/);
  assert.match(pair('quoteHeader-deal'), /data-label="Held for review"><a href="\/review\/records\?rule=header_to_deal&amp;status=multiple_targets">1<\/a>/);
  const stats = [...page.text.matchAll(/<p class="stat-label">(.*?)<\/p>\n<p class="stat-value">(.*?)<\/p>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(stats.slice(0, 3), [['Held associations', '1'], ['Held deal amounts', '0'], ['No match', '205']]);

  // The held association: the quote, its number, and the deals it matches, every one a link into HubSpot.
  const held = await a.request('GET', '/review/records?rule=header_to_deal&status=multiple_targets', { cookie });
  assert.equal(held.status, 200);
  assert.match(held.text, /<h2>Held for review: more than one match<\/h2>/);
  assert.match(held.text, /1 Quote header record\. The ID on each of these matches more than one Deal, so the service does not pick one\./);
  assert.deepEqual(rowsOf(held.text), [
    `<tr><td data-label="Quote header">${link('2-1001', multi)}</td><td data-label="ID on the record"><code>MULTI</code></td><td data-label="Detail" class="detail">matches Deal ${link('0-3', dealA)}, ${link('0-3', dealB)}</td><td data-label="On the list since" class="nowrap">2026-11-01 00:40 UTC</td></tr>`,
  ]);

  // The unmatched lines: 100 to a page, the rest on the next pages; a page number out of range shows the nearest page.
  const list = '/review/records?rule=lines_to_header&status=no_target';
  const first = await a.request('GET', list, { cookie });
  assert.equal(rowsOf(first.text).length, 100);
  assert.match(first.text, /205 Quote line records\. The ID on each of these matches no Quote header\./);
  assert.match(first.text, /<span>1 to 100 of 205<\/span>\n<span class="pager-links"><span class="off">Previous<\/span><span>Page 1 of 3<\/span><a href="\/review\/records\?rule=lines_to_header&amp;status=no_target&amp;page=2">Next<\/a><\/span>/);
  const last = await a.request('GET', `${list}&page=3`, { cookie });
  assert.equal(rowsOf(last.text).length, 5);
  assert.match(last.text, /<span>201 to 205 of 205<\/span>/);
  assert.match(last.text, /<a href="\/review\/records\?rule=lines_to_header&amp;status=no_target&amp;page=2">Previous<\/a><span>Page 3 of 3<\/span><span class="off">Next<\/span>/);
  for (const bad of ['99', '0', '-1', 'x', '1e3']) {
    const clamped = await a.request('GET', `${list}&page=${bad}`, { cookie });
    assert.equal(clamped.status, 200, bad);
    assert.match(clamped.text, bad === '99' ? /Page 3 of 3/ : /Page 1 of 3/, bad);
  }
  const all = [first.text, (await a.request('GET', `${list}&page=2`, { cookie })).text, last.text].join('\n');
  assert.ok(all.includes(`<tr><td data-label="Quote line">${link('2-1002', plain)}</td><td data-label="ID on the record"><code>NOPE</code></td><td data-label="Detail" class="detail">no Quote header found</td>`));
  // What is on a record is shown as text, never as markup.
  assert.ok(all.includes(`<td data-label="Quote line">${link('2-1002', markup)}</td><td data-label="ID on the record"><code>&lt;img src=x onerror=alert(1)&gt;</code></td>`));
  assert.doesNotMatch(all, /<img src=x/);

  const none = await a.request('GET', '/review/records?rule=lines_to_header&status=missing_key', { cookie });
  assert.deepEqual(rowsOf(none.text).map((row) => row.slice(0, row.indexOf('<td data-label="Detail"'))), [
    `<tr><td data-label="Quote line">${link('2-1002', noId)}</td><td data-label="ID on the record"><span class="muted">empty</span></td>`,
  ]);
  assert.match(none.text, /Each of these has no value in epicor_quote_num, so there is nothing to match on\./);
  const empty = await a.request('GET', '/review/records?rule=tasks_to_header&status=failed', { cookie });
  assert.equal(empty.status, 200);
  assert.match(empty.text, /<p class="lead">Nothing is on this list\.<\/p>/);
  assert.doesNotMatch(empty.text, /Download CSV|<table/);

  // The CSV has every record of the list, with its link. A value a spreadsheet would run as a formula is written as text.
  const csv = await a.request('GET', '/review/records.csv?rule=lines_to_header&status=no_target', { cookie });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="review-lines_to_header-no_target-2026-11-01.csv"');
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  const csvLines = csv.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(csvLines.length, 206);
  assert.equal(csvLines[0], 'Quote line record ID,HubSpot link,Reason,ID on the record,Detail,On the list since');
  assert.ok(csvLines.includes(`${plain},https://app.hubspot.com/contacts/${PORTAL}/record/2-1002/${plain},No match,epicor_quote_num=NOPE,no Quote header found,2026-11-01T00:40:00.000Z`));
  const formulaRow = csvLines.find((line) => line.startsWith(`${formula},`));
  assert.ok(formulaRow.includes(',"epicor_quote_num==HYPERLINK(""http://evil.example"",""x"")",'), 'quoted, and not at the start of a cell');
  for (const line of csvLines) for (const cell of line.split(',')) assert.doesNotMatch(cell, /^"?[=+@]/, line);

  // Whatever text a reason carries (HubSpot's own error text, for one) is shown as text, around the links too.
  await h.db.query(
    `INSERT INTO review_items (rule_id, hubspot_id, status, match_key, detail, first_seen_at, updated_at) VALUES
       ('header_to_deal', '900001', 'multiple_targets', 'epicor_quote_num=X', '<i>odd</i> matches Deal 11, 12; already has Deal 13 <b>and more</b>', now(), now()),
       ('header_to_deal', '900002', 'failed', 'epicor_quote_num=Y', '=cmd|x <script>alert(1)</script>', now(), now())`,
  );
  const odd = (await a.request('GET', '/review/records?rule=header_to_deal&status=multiple_targets', { cookie })).text;
  assert.ok(odd.includes(`<td data-label="Detail" class="detail">&lt;i&gt;odd&lt;/i&gt; matches Deal ${link('0-3', '11')}, ${link('0-3', '12')}; already has Deal ${link('0-3', '13')} &lt;b&gt;and more&lt;/b&gt;</td>`));
  const failedList = (await a.request('GET', '/review/records?rule=header_to_deal&status=failed', { cookie })).text;
  assert.ok(failedList.includes('<td data-label="Detail" class="detail">=cmd|x &lt;script&gt;alert(1)&lt;/script&gt;</td>'));
  assert.doesNotMatch(odd + failedList, /<script|<i>|<b>/);
  const failedCsv = (await a.request('GET', '/review/records.csv?rule=header_to_deal&status=failed', { cookie })).text;
  assert.ok(failedCsv.includes(`,Failed,epicor_quote_num=Y,'=cmd|x <script>alert(1)</script>,`), 'a cell that starts like a formula is written as text');

  // Addresses that name no list of this service.
  for (const url of [
    '/review/records', '/review/records?rule=nope&status=no_target', '/review/records?rule=lines_to_header&status=nope',
    '/review/records?rule=lines_to_header', '/review/records.csv?rule=x&status=no_target', '/review/', '/review/records/1', '/reviews', '/review/mapping',
    '/review/records?rule=contacts_to_header%27%20OR%201=1--&status=no_target',
  ]) {
    assert.equal((await a.request('GET', url, { cookie })).status, 404, url);
  }

  // The overview links to Review, and the chips of Link health lead to the block of their pair.
  const home = await a.request('GET', '/', { cookie });
  assert.match(home.text, /<nav class="nav" aria-label="Sections"><a href="\/" class="active" aria-current="page">Overview<\/a><a href="\/review">Review<\/a><\/nav>/);
  assert.match(home.text, /<li class="chip warn"><a href="\/review#quoteLine-quoteHeader"><strong>205<\/strong> match no Quote header<\/a><\/li>/);
  assert.match(home.text, /<li class="chip quiet"><a href="\/review#quoteLine-quoteHeader"><strong>1<\/strong> has no ID<\/a><\/li>/);
  assert.match(home.text, /<li class="chip warn"><a href="\/review#quoteHeader-deal"><strong>1<\/strong> held for review<\/a><\/li>/);
  assert.match(home.text, /are listed under <a href="\/review">Review<\/a>/);
  assert.match(page.text, /<a href="\/">Overview<\/a><a href="\/review" class="active" aria-current="page">Review<\/a>/);

  // All of that was read from the staging database: not one call to HubSpot, and nothing written.
  assert.equal(fake.requests.length, requestsBefore);
  // The pages carry no script and no inline style, and the only link that leaves the site goes to this portal in HubSpot.
  for (const text of [page.text, held.text, first.text, none.text, home.text]) {
    assert.doesNotMatch(text, /<script|<[^>]*\sstyle=|<[^>]*\son\w+=|javascript:/i);
    for (const [, href] of text.matchAll(/<a [^>]*href="([^"]+)"/g)) {
      assert.ok(href.startsWith('/') || href.startsWith(`https://app.hubspot.com/contacts/${PORTAL}/record/`), href);
    }
    for (const [tag] of text.matchAll(/<a [^>]*href="https:[^>]*>/g)) assert.match(tag, /target="_blank" rel="noopener noreferrer"/);
  }
  for (const secret of ['test-HUBSPOT-SECRET-0001', 'RESEND-SECRET-0002', 'SLACK-SECRET-0003', 'DB-SECRET-0004', 'correct horse battery staple']) {
    assert.ok(!a.bodies.join('\n').includes(secret));
  }
  await a.close();
  await h.cleanup();
});

test('review: without a portal ID the lists show the record IDs as text; without the mapping the page has no Review section', async () => {
  const h = await makeHarness();
  const line = h.fake.addRecord(T.line, { epicor_quote_num: 'NOPE' });
  h.fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });

  const a = await startAdmin(h, { mapping: h.mapping });
  const { cookie } = await a.login();
  const list = await a.request('GET', '/review/records?rule=lines_to_header&status=no_target', { cookie });
  assert.deepEqual(rowsOf(list.text).map((row) => row.slice(0, row.indexOf('<td data-label="Detail"'))), [`<tr><td data-label="Quote line">${line}</td><td data-label="ID on the record"><code>NOPE</code></td>`]);
  assert.doesNotMatch(list.text, /hubspot\.com/);
  assert.match(list.text, /Record links are off until the mapping has a <code>portalId<\/code>\./);
  const csv = await a.request('GET', '/review/records.csv?rule=lines_to_header&status=no_target', { cookie });
  assert.match(csv.text, new RegExp(`\\r\\n${line},,No match,`));
  await a.close();

  const b = await startAdmin(h);
  const signedIn = await b.login();
  for (const url of ['/review', '/review/records?rule=lines_to_header&status=no_target', '/review/deal-amounts']) {
    assert.equal((await b.request('GET', url, { cookie: signedIn.cookie })).status, 404, url);
  }
  assert.equal((await b.request('POST', '/review/deal-amounts/release', { cookie: signedIn.cookie, form: { csrf: signedIn.csrf, hold: '1:0' } })).status, 404);
  assert.doesNotMatch((await b.request('GET', '/', { cookie: signedIn.cookie })).text, /\/review|class="nav"/);
  await b.close();
  await h.cleanup();
});

/** Two quotes with a deal each, requoted to 0, so the guard holds both changes. */
async function twoHeldChanges(h, [first, second] = ['H1', 'H2']) {
  const one = addQuoteFamily(h.fake, { quote: first, customer: 'C', contactNumber: '1', lines: 0, tasks: 0, withContact: false, amount: '500' });
  const two = addQuoteFamily(h.fake, { quote: second, customer: 'C', contactNumber: '1', lines: 0, tasks: 0, withContact: false, amount: '2500000' });
  h.fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  h.fake.advance(30);
  h.fake.updateRecord(T.header, one.header, { quote_amount: '0' });
  h.fake.updateRecord(T.header, two.header, { quote_amount: '0' });
  h.fake.advance(10);
  const held = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(held.dealAmount.heldCount, 2);
  h.fake.advance(30);
  return [one, two];
}

test('review: a held deal amount change is released on the page after a confirmation step; the release is recorded in the staging database and the next live run applies it', async () => {
  const h = await makeHarness(withPortal);
  const { fake } = h;
  const [one, two] = await twoHeldChanges(h);
  const [holdOne, holdTwo] = (await holdRows(h)).map((row) => String(row.id));
  const state = { running: false };
  const a = await startAdmin(h, { mapping: h.mapping, env: { DRY_RUN: 'false' }, now: () => new Date(fake.clock), runs: { status: () => state, runNow: () => ({ started: false, reason: 'running' }), setSchedule() {} } });
  const { cookie, csrf } = await a.login();
  const requestsBefore = fake.requests.length;
  const writesBefore = fake.writes.length;

  // The list: deal, quote, the amount on the deal, the quote amount that was not applied, why, since when.
  let page = await a.request('GET', '/review/deal-amounts', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /2 changes not applied\. The deal still carries the amount under Deal amount now\./);
  assert.doesNotMatch(page.text, /Released and applied/);
  assert.deepEqual(rowsOf(page.text), [
    `<tr><td data-label="Deal">${link('0-3', one.deal)}</td><td data-label="Quote header">${link('2-1001', one.header)}<span class="sub">Quote H1</span></td><td class="num" data-label="Deal amount now">500.00</td><td class="num" data-label="Quote amount, not applied">0.00</td><td class="num" data-label="Difference">&minus;500.00</td><td data-label="Why held" class="detail">Would set the deal amount to 0</td><td data-label="Held since" class="nowrap">2026-11-01 00:50 UTC</td><td data-label="Release" class="act"><label class="check pick"><input type="checkbox" name="hold" value="${holdOne}" form="release"> Select</label></td></tr>`,
    `<tr><td data-label="Deal">${link('0-3', two.deal)}</td><td data-label="Quote header">${link('2-1001', two.header)}<span class="sub">Quote H2</span></td><td class="num" data-label="Deal amount now">2,500,000.00</td><td class="num" data-label="Quote amount, not applied">0.00</td><td class="num" data-label="Difference">&minus;2,500,000.00</td><td data-label="Why held" class="detail">Would set the deal amount to 0; Moves the deal amount by more than 1,000,000</td><td data-label="Held since" class="nowrap">2026-11-01 00:50 UTC</td><td data-label="Release" class="act"><label class="check pick"><input type="checkbox" name="hold" value="${holdTwo}" form="release"> Select</label></td></tr>`,
  ]);
  assert.match(page.text, /<form id="release" method="get" action="\/review\/deal-amounts\/release"><\/form>/);
  assert.match(page.text, /The next run, scheduled or started with Sync now, then sets the deal amount in HubSpot\./);
  const overview = await a.request('GET', '/review', { cookie });
  assert.match(overview.text, /<strong>2 changes are held\.<\/strong>/);

  // Choosing changes leads to a page that lists them. Nothing is released by looking at it.
  let confirm = await a.request('GET', `/review/deal-amounts/release?hold=${holdOne}`, { cookie });
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /<h2>Release 1 deal amount change<\/h2>/);
  assert.equal(rowsOf(confirm.text).length, 1);
  assert.match(rowsOf(confirm.text)[0], new RegExp(`${one.deal}</a></td>.*data-label="Deal amount now">500.00</td><td class="num" data-label="Will be set to">0.00</td>`));
  assert.match(confirm.text, new RegExp(`<form method="post" action="/review/deal-amounts/release" class="release-bar">\\n<input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="hold" value="${holdOne}:0">\\n<button type="submit">Release 1 change</button>`));
  const everything = await a.request('GET', '/review/deal-amounts/release?all=1', { cookie });
  assert.match(everything.text, /<h2>Release 2 deal amount changes<\/h2>/);
  const nothing = await a.request('GET', '/review/deal-amounts/release', { cookie });
  assert.match(nothing.text, /Nothing was chosen\./);
  assert.doesNotMatch(nothing.text, /action="\/review\/deal-amounts\/release"/);
  const unknown = await a.request('GET', `/review/deal-amounts/release?hold=999999&hold=abc&hold=${holdTwo}`, { cookie });
  assert.match(unknown.text, /1 chosen change is left out: already released, applied, or no longer held\./);
  assert.match(unknown.text, /<h2>Release 1 deal amount change<\/h2>/);
  assert.ok((await holdRows(h)).every((row) => row.released_at === null));

  // A release needs the session, its form token and a request from this site.
  const form = { csrf, hold: `${holdOne}:0` };
  assert.equal((await a.request('POST', '/review/deal-amounts/release', { form })).status, 401);
  assert.equal((await a.request('POST', '/review/deal-amounts/release', { cookie, form: { ...form, csrf: 'wrong' } })).status, 403);
  assert.equal((await a.request('POST', '/review/deal-amounts/release', { cookie, form, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.request('POST', '/review/deal-amounts/release', { cookie, form: { csrf } })).status, 400);
  assert.equal((await a.request('POST', '/review/deal-amounts/release', { cookie, form: { csrf, hold: 'x:0' } })).status, 400);
  assert.ok((await holdRows(h)).every((row) => row.released_at === null));

  // An amount that is not the one held now is not released (the page was out of date).
  const stale = await a.request('POST', '/review/deal-amounts/release', { cookie, form: { csrf, hold: `${holdOne}:499` }, headers: browser(a) });
  assert.equal(stale.headers.get('location'), '/review/deal-amounts?notice=released&n=0&left=1');
  const told = await a.request('GET', stale.headers.get('location'), { cookie });
  assert.match(told.text, /<p class="notice bad" role="alert">1 change was not released: no longer held, already released, or the quote amount changed\. Check the list\.<\/p>/);
  assert.doesNotMatch(told.text, /notice good/);
  assert.ok((await holdRows(h)).every((row) => row.released_at === null));

  // Releasing one change records it in the staging database. HubSpot is not called and the deal is not touched.
  const released = await a.request('POST', '/review/deal-amounts/release', { cookie, form, headers: browser(a) });
  assert.equal(released.status, 303);
  assert.equal(released.headers.get('location'), '/review/deal-amounts?notice=released&n=1&left=0');
  assert.deepEqual((await holdRows(h)).map((row) => [String(row.id), row.released_amount, row.resolved_at]), [[holdOne, '0', null], [holdTwo, null, null]]);
  assert.equal(fake.requests.length, requestsBefore);
  assert.equal(fake.writes.length, writesBefore);
  assert.equal(dealAmount(h, one), '500');
  assert.ok(h.logs.some((l) => l.msg === 'deal amount changes released on the admin page' && l.released === 1 && l.dealIds[0] === one.deal));

  page = await a.request('GET', released.headers.get('location'), { cookie });
  assert.match(page.text, /<p class="notice good" role="status">1 deal amount change released\. The next run applies it\.<\/p>/);
  assert.match(page.text, /2 changes not applied; 1 released and waiting for a run, 1 waiting for a decision\./);
  assert.match(rowsOf(page.text)[0], new RegExp(`<span class="badge good">Released</span><span class="sub">2026-11-01 01:20 UTC, waiting for the next run</span><form method="post" action="/review/deal-amounts/cancel"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="hold" value="${holdOne}"><button type="submit" class="quiet">Cancel release</button></form>`));
  assert.doesNotMatch(rowsOf(page.text)[0], /type="checkbox"/);
  assert.match(rowsOf(page.text)[1], /type="checkbox"/);
  // Released once: it cannot be chosen or released again.
  confirm = await a.request('GET', `/review/deal-amounts/release?hold=${holdOne}`, { cookie });
  assert.match(confirm.text, /Nothing was chosen\./);
  const again = await a.request('POST', '/review/deal-amounts/release', { cookie, form, headers: browser(a) });
  assert.equal(again.headers.get('location'), '/review/deal-amounts?notice=released&n=0&left=1');

  // The release can be taken back, but not while a run is in progress, and not twice.
  const cancel = { csrf, hold: holdOne };
  assert.equal((await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: { ...cancel, csrf: 'wrong' } })).status, 403);
  state.running = true;
  const during = await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: cancel, headers: browser(a) });
  assert.equal(during.status, 409);
  assert.match(during.text, /Not cancelled: a run is in progress and may already be applying this release\. Try again when it has finished\./);
  assert.equal((await holdRows(h))[0].released_amount, '0');
  state.running = false;
  const cancelled = await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: cancel, headers: browser(a) });
  assert.equal(cancelled.headers.get('location'), '/review/deal-amounts?notice=release_cancelled');
  assert.match((await a.request('GET', cancelled.headers.get('location'), { cookie })).text, /Release cancelled\. The change is held again\./);
  assert.ok((await holdRows(h)).every((row) => row.released_at === null));
  assert.equal((await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: cancel, headers: browser(a) })).status, 409);
  assert.equal((await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: { csrf, hold: 'abc' }, headers: browser(a) })).status, 400);

  // A run with nothing released changes no deal.
  let run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 0);
  assert.equal(run.dealAmount.heldCount, 2);
  assert.equal(dealAmount(h, one), '500');

  // Released again: the next live run sets that deal, and only that deal, to the quote amount.
  fake.advance(30);
  await a.request('POST', '/review/deal-amounts/release', { cookie, form, headers: browser(a) });
  assert.equal(dealAmount(h, one), '500');
  run = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(run.dealAmount.updated, 1);
  assert.equal(dealAmount(h, one), '0');
  assert.equal(dealAmount(h, two), '2500000');
  assert.deepEqual((await holdRows(h)).map((row) => row.resolution), ['applied', null]);

  page = await a.request('GET', '/review/deal-amounts', { cookie });
  assert.equal(rowsOf(page.text).length, 1);
  assert.match(page.text, /1 change not applied\./);
  assert.ok(rowsOf(page.text)[0].includes(link('0-3', two.deal)));
  // What became of the release is kept on the page.
  const applied = page.text.slice(page.text.indexOf('<h2>Released and applied</h2>'));
  assert.deepEqual(rowsOf(applied), [
    `<tr><td data-label="Deal">${link('0-3', one.deal)}</td><td data-label="Quote header">${link('2-1001', one.header)}<span class="sub">Quote H1</span></td><td class="num" data-label="Deal amount before">500.00</td><td class="num" data-label="Set to">0.00</td><td data-label="Released" class="nowrap">2026-11-01 01:50 UTC</td><td data-label="Applied by a run" class="nowrap">2026-11-01 01:50 UTC</td></tr>`,
  ]);
  assert.equal((await a.request('POST', '/review/deal-amounts/cancel', { cookie, form: cancel, headers: browser(a) })).status, 409);

  // The download has what is held now.
  const csv = await a.request('GET', '/review/deal-amounts.csv', { cookie });
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="held-deal-amounts-2026-11-01.csv"');
  assert.deepEqual(csv.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n'), [
    'Deal ID,Deal link,Quote record ID,Quote link,Quote number,Deal amount now,Quote amount (not applied),Why held,Held since,Released',
    `${two.deal},https://app.hubspot.com/contacts/${PORTAL}/record/0-3/${two.deal},${two.header},https://app.hubspot.com/contacts/${PORTAL}/record/2-1001/${two.header},H2,2500000,0,"Would set the deal amount to 0; Moves the deal amount by more than 1,000,000",2026-11-01T00:50:00.000Z,`,
  ]);

  // The only forms on these pages: sign out, the release form and the cancel buttons.
  for (const text of [page.text, confirm.text, everything.text, overview.text]) {
    const actions = new Set([...text.matchAll(/<form [^>]*action="([^"]+)"/g)].map((m) => m[1]));
    for (const action of actions) assert.ok(['/logout', '/review/deal-amounts/release', '/review/deal-amounts/cancel'].includes(action), action);
    assert.doesNotMatch(text, /<script|<[^>]*\sstyle=|<[^>]*\son\w+=/i);
  }
  await a.close();
  await h.cleanup();
});

test('review: in a dry-run service a release is recorded and waits for the first live run', async () => {
  const h = await makeHarness(withPortal);
  const [one, two] = await twoHeldChanges(h, ['H1', '@SUM(1+1)<b>x</b>']);
  const [holdOne] = (await holdRows(h)).map((row) => String(row.id));
  const a = await startAdmin(h, { mapping: h.mapping, env: { DRY_RUN: 'true' } });
  const { cookie, csrf } = await a.login();

  const page = await a.request('GET', '/review/deal-amounts', { cookie });
  assert.match(page.text, /The service is in dry-run mode, so a release is recorded now and applied by the first live run\./);
  const released = await a.request('POST', '/review/deal-amounts/release', { cookie, form: { csrf, hold: `${holdOne}:0` }, headers: browser(a) });
  assert.match((await a.request('GET', released.headers.get('location'), { cookie })).text, /1 deal amount change released\. The first live run applies it\./);

  // Dry runs leave the deal and the release as they are.
  const dry = await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  assert.equal(dry.dealAmount.planned, 1);
  assert.equal(dealAmount(h, one), '500');
  assert.equal((await holdRows(h))[0].released_amount, '0');
  assert.match((await a.request('GET', '/review/deal-amounts', { cookie })).text, /waiting for the next live run/);

  h.fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(live.dealAmount.updated, 1);
  assert.equal(dealAmount(h, one), '0');

  // A quote number that a spreadsheet would run as a formula is written as text in the download, and as text on the page.
  const csv = (await a.request('GET', '/review/deal-amounts.csv', { cookie })).text;
  assert.ok(csv.includes(`${two.header},'@SUM(1+1)<b>x</b>,2500000,0,`), csv);
  const listed = (await a.request('GET', '/review/deal-amounts', { cookie })).text;
  assert.ok(listed.includes('<span class="sub">Quote @SUM(1+1)&lt;b&gt;x&lt;/b&gt;</span>'));
  const chosen = (await a.request('GET', '/review/deal-amounts/release?all=1', { cookie })).text;
  assert.ok(chosen.includes('<span class="sub">Quote @SUM(1+1)&lt;b&gt;x&lt;/b&gt;</span>'));
  assert.doesNotMatch(listed + chosen, /<b>/);
  await a.close();
  await h.cleanup();
});
