import http from 'node:http';

/**
 * In-memory stand-in for the parts of the HubSpot CRM API the middleware
 * uses. It is written from HubSpot's public documentation (2026-09), not
 * recorded from a real account, and it enforces the documented limits so
 * that a request HubSpot would reject fails here too.
 *
 * It answers both the date-versioned paths and the legacy v3/v4 paths.
 */

const ALIASES = { contact: 'contacts', '0-1': 'contacts', company: 'companies', '0-2': 'companies', deal: 'deals', '0-3': 'deals' };
const STANDARD_DATES = {
  contacts: { created: 'createdate', modified: 'lastmodifieddate' },
  companies: { created: 'createdate', modified: 'hs_lastmodifieddate' },
  deals: { created: 'createdate', modified: 'hs_lastmodifieddate' },
};
const CUSTOM_DATES = { created: 'hs_createdate', modified: 'hs_lastmodifieddate' };
const DATE_PROPS = new Set(['createdate', 'lastmodifieddate', 'hs_createdate', 'hs_lastmodifieddate']);

const canon = (type) => ALIASES[type] || type;

function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function bad(message, category = 'VALIDATION_ERROR') {
  return json(400, { status: 'error', message, category, correlationId: 'fake' });
}

export class FakeHubSpot {
  constructor({ token = 'test-token', searchResultCap = 10_000, associationPageSize = 500, startAt = '2026-11-01T00:00:00.000Z' } = {}) {
    this.token = token;
    this.searchResultCap = searchResultCap;
    this.associationPageSize = associationPageSize;
    this.clock = Date.parse(startAt);
    this.types = new Map();
    this.definitions = [];
    this.links = new Map();
    this.requests = [];
    this.writes = [];
    this.failures = [];
    this.nextId = 1000;
    this.fetch = this.fetch.bind(this);
    for (const type of ['contacts', 'companies', 'deals']) this.defineObject(type, { custom: false });
  }

  // ---- test setup helpers -------------------------------------------------

  advance(minutes) {
    this.clock += minutes * 60_000;
    return new Date(this.clock);
  }

  defineObject(type, { custom = true, name = type, properties = [] } = {}) {
    const dates = custom ? CUSTOM_DATES : STANDARD_DATES[type];
    const props = new Map();
    for (const p of ['hs_object_id', dates.created, dates.modified]) props.set(p, { name: p, label: p, type: 'string', hubspotDefined: true });
    for (const p of properties) props.set(p.name ?? p, { name: p.name ?? p, label: p.label ?? p.name ?? p, type: p.type ?? 'string', hubspotDefined: false });
    this.types.set(type, { type, custom, name, dates, props, records: new Map() });
  }

  defineAssociation(typeA, typeB, { aToB, bToA, label = null, category = 'USER_DEFINED', unlabeled = false }) {
    this.definitions.push({ a: canon(typeA), b: canon(typeB), aToB, bToA, label, category, unlabeled });
  }

  addRecord(type, properties = {}, { at, id: givenId } = {}) {
    const t = this.#type(type);
    const id = String(givenId ?? this.nextId++);
    const stamp = new Date(at ?? this.clock).toISOString();
    const record = { id, properties: { hs_object_id: id, [t.dates.created]: stamp, [t.dates.modified]: stamp }, history: {}, createdAt: stamp, updatedAt: stamp, archived: false };
    t.records.set(id, record);
    this.#apply(t, record, properties, stamp);
    return id;
  }

  updateRecord(type, id, properties, { at } = {}) {
    const t = this.#type(type);
    const record = t.records.get(String(id));
    if (!record) throw new Error(`no ${type} ${id}`);
    const stamp = new Date(at ?? this.clock).toISOString();
    this.#apply(t, record, properties, stamp);
    record.properties[t.dates.modified] = stamp;
    record.updatedAt = stamp;
  }

  deleteRecord(type, id) {
    this.#type(type).records.delete(String(id));
  }

  record(type, id) {
    return this.#type(type).records.get(String(id));
  }

  /** Associates two records directly (test setup). typeId is for the from -> to direction. */
  associate(fromType, fromId, toType, toId, typeId) {
    const def = this.#definition(fromType, toType, typeId);
    if (!def) throw new Error(`no association definition ${fromType} -> ${toType} ${typeId ?? '(default)'}`);
    this.#link(fromType, fromId, toType, toId, def.forward);
    this.#link(toType, toId, fromType, fromId, def.reverse);
  }

  associated(fromType, fromId, toType) {
    return [...(this.links.get(this.#linkKey(fromType, toType))?.get(String(fromId))?.keys() || [])];
  }

  associationTypes(fromType, fromId, toType, toId) {
    const set = this.links.get(this.#linkKey(fromType, toType))?.get(String(fromId))?.get(String(toId));
    return set ? [...set.values()].map((t) => t.typeId).sort((x, y) => x - y) : [];
  }

  /** Makes the next matching request(s) fail. */
  failNext({ method, pathIncludes, status = 500, body = { status: 'error', message: 'injected failure' }, headers = {}, times = 1 }) {
    this.failures.push({ method, pathIncludes, status, body, headers, times });
  }

  /** Makes the next matching batch write report errors for some inputs without applying them. */
  rejectInputsOnce({ pathIncludes, predicate }) {
    this.failures.push({ pathIncludes, predicate, partial: true, times: 1 });
  }

  // ---- HTTP surface -------------------------------------------------------

  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const rawBody = init.body ?? null;
    let body = null;
    if (rawBody) body = JSON.parse(rawBody);
    this.requests.push({ method, path: url.pathname, body });

    if (headers.get('authorization') !== `Bearer ${this.token}`) {
      return json(401, { status: 'error', message: 'Authentication credentials not found', category: 'INVALID_AUTHENTICATION' });
    }

    const injected = this.failures.find((f) => !f.partial && (!f.method || f.method === method) && (!f.pathIncludes || url.pathname.includes(f.pathIncludes)));
    if (injected) {
      injected.times -= 1;
      if (injected.times <= 0) this.failures.splice(this.failures.indexOf(injected), 1);
      return json(injected.status, injected.body, injected.headers);
    }

    return this.#route(method, url.pathname, body, rawBody);
  }

  listen(port = 0) {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      const response = await this.fetch(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: text || undefined });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
  }

  #route(method, path, body, rawBody) {
    let m;
    if ((m = path.match(/^\/crm\/(?:v3\/objects|objects\/\d{4}-\d{2})\/([^/]+)\/search$/)) && method === 'POST') {
      return this.#search(decodeURIComponent(m[1]), body, rawBody);
    }
    if ((m = path.match(/^\/crm\/(?:v3\/objects|objects\/\d{4}-\d{2})\/([^/]+)\/batch\/read$/)) && method === 'POST') {
      return this.#batchRead(decodeURIComponent(m[1]), body);
    }
    if ((m = path.match(/^\/crm\/(?:v3\/objects|objects\/\d{4}-\d{2})\/([^/]+)\/batch\/update$/)) && method === 'POST') {
      return this.#batchUpdate(decodeURIComponent(m[1]), body, path);
    }
    if ((m = path.match(/^\/crm\/(?:v4\/associations|associations\/\d{4}-\d{2})\/([^/]+)\/([^/]+)\/(batch\/read|batch\/create|batch\/associate\/default|batch\/archive|labels)$/))) {
      const from = decodeURIComponent(m[1]);
      const to = decodeURIComponent(m[2]);
      if (!this.types.has(canon(from)) || !this.types.has(canon(to))) return bad(`Unable to infer object type from: ${from}/${to}`);
      if (m[3] === 'labels' && method === 'GET') return this.#labels(from, to);
      if (method !== 'POST') return json(405, { status: 'error', message: 'method not allowed' });
      if (m[3] === 'batch/read') return this.#associationsRead(from, to, body);
      if (m[3] === 'batch/create') return this.#associationsCreate(from, to, body, path, false);
      if (m[3] === 'batch/associate/default') return this.#associationsCreate(from, to, body, path, true);
      return this.#associationsArchive(from, to, body, path);
    }
    if (/^\/crm\/v3\/schemas$|^\/crm-object-schemas\/\d{4}-\d{2}\/schemas$/.test(path) && method === 'GET') {
      return this.#schemas();
    }
    if ((m = path.match(/^\/crm\/(?:v3\/properties|properties\/\d{4}-\d{2})\/([^/]+)$/)) && method === 'GET') {
      const t = this.types.get(canon(decodeURIComponent(m[1])));
      if (!t) return json(404, { status: 'error', message: 'object type not found', category: 'OBJECT_NOT_FOUND' });
      return json(200, { results: [...t.props.values()] });
    }
    return json(404, { status: 'error', message: `no route for ${method} ${path}` });
  }

  // ---- objects ------------------------------------------------------------

  #type(type) {
    const t = this.types.get(canon(type));
    if (!t) throw new Error(`unknown object type ${type}`);
    return t;
  }

  #apply(t, record, properties, stamp) {
    for (const [name, value] of Object.entries(properties)) {
      if (!t.props.has(name)) t.props.set(name, { name, label: name, type: 'string', hubspotDefined: false });
      const next = value === null || value === undefined ? null : String(value);
      if (record.properties[name] !== next) {
        record.properties[name] = next;
        (record.history[name] ??= []).unshift({ value: next ?? '', timestamp: stamp, sourceType: 'API' });
      }
    }
  }

  #view(record, properties, propertiesWithHistory = []) {
    const out = { id: record.id, properties: {}, createdAt: record.createdAt, updatedAt: record.updatedAt, archived: false };
    for (const [name, value] of Object.entries(record.properties)) {
      if (DATE_PROPS.has(name) || name === 'hs_object_id') out.properties[name] = value;
    }
    for (const name of properties) out.properties[name] = record.properties[name] ?? null;
    if (propertiesWithHistory.length) {
      out.propertiesWithHistory = {};
      for (const name of propertiesWithHistory) out.propertiesWithHistory[name] = record.history[name] || [];
    }
    return out;
  }

  #matches(record, filter) {
    const raw = record.properties[filter.propertyName];
    const has = raw !== null && raw !== undefined && raw !== '';
    const op = filter.operator;
    if (op === 'HAS_PROPERTY') return has;
    if (op === 'NOT_HAS_PROPERTY') return !has;
    if (!has) return false;
    if (op === 'IN') {
      // HubSpot needs lower-case values for IN on string properties; upper-case values match nothing.
      return filter.values.includes(String(raw).toLowerCase());
    }
    if (op === 'EQ') return String(raw).toLowerCase() === String(filter.value).toLowerCase();
    let left;
    let right;
    if (DATE_PROPS.has(filter.propertyName)) {
      left = BigInt(Date.parse(raw));
      right = BigInt(filter.value);
    } else {
      left = BigInt(raw);
      right = BigInt(filter.value);
    }
    if (op === 'GT') return left > right;
    if (op === 'GTE') return left >= right;
    if (op === 'LT') return left < right;
    if (op === 'LTE') return left <= right;
    throw new Error(`fake does not implement operator ${op}`);
  }

  #search(type, body, rawBody) {
    const t = this.types.get(canon(type));
    if (!t) return bad(`Unable to infer object type from: ${type}`);
    if (rawBody.length > 3000) return bad('Request body exceeds 3,000 characters');
    const limit = body.limit ?? 10;
    if (limit > 200) return bad('limit must be 200 or less');
    const groups = body.filterGroups || [];
    if (groups.length > 5) return bad('too many filterGroups');
    let total = 0;
    for (const group of groups) {
      if (!group.filters?.length) return bad('filterGroup with no filters');
      if (group.filters.length > 6) return bad('too many filters in a group');
      total += group.filters.length;
      for (const filter of group.filters) {
        if (filter.operator === 'IN' && !Array.isArray(filter.values)) return bad('IN needs a values array');
        if (filter.operator === 'IN' && filter.values.length > 100) return bad('too many values for IN');
        if (!t.props.has(filter.propertyName)) return bad(`Property ${filter.propertyName} does not exist`);
      }
    }
    if (total > 18) return bad('too many filters');
    for (const name of body.properties || []) {
      if (!t.props.has(name)) return bad(`Property ${name} does not exist`);
    }

    let matched = [...t.records.values()].filter((record) => groups.length === 0 || groups.some((g) => g.filters.every((f) => this.#matches(record, f))));
    const sort = (body.sorts || [])[0];
    const sortProp = typeof sort === 'string' ? sort : sort?.propertyName || t.dates.created;
    const descending = typeof sort === 'object' && sort?.direction === 'DESCENDING';
    matched.sort((x, y) => {
      const a = x.properties[sortProp];
      const b = y.properties[sortProp];
      const cmp = sortProp === 'hs_object_id' ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : String(a).localeCompare(String(b));
      return descending ? -cmp : cmp;
    });
    const offset = Number(body.after || 0);
    if (offset + limit > this.searchResultCap) return bad('Cannot page beyond 10,000 results');
    const page = matched.slice(offset, offset + limit);
    const response = { total: matched.length, results: page.map((r) => this.#view(r, body.properties || [])) };
    if (offset + limit < matched.length) response.paging = { next: { after: String(offset + limit) } };
    return json(200, response);
  }

  #batchRead(type, body) {
    const t = this.types.get(canon(type));
    if (!t) return bad(`Unable to infer object type from: ${type}`);
    if (!Array.isArray(body.properties) || !Array.isArray(body.propertiesWithHistory) || !Array.isArray(body.inputs)) {
      return bad('inputs, properties and propertiesWithHistory are required');
    }
    if (body.inputs.length > 100) return bad('batch read is limited to 100 inputs');
    if (body.propertiesWithHistory.length && body.inputs.length > 50) return bad('batch read with history is limited to 50 inputs');
    const results = [];
    const missing = [];
    for (const { id } of body.inputs) {
      const record = t.records.get(String(id));
      if (record) results.push(this.#view(record, body.properties, body.propertiesWithHistory));
      else missing.push(String(id));
    }
    const base = { status: 'COMPLETE', results, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    if (missing.length === 0) return json(200, base);
    return json(207, { ...base, numErrors: 1, errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'Could not get some objects, they may be deleted or not exist.', context: { ids: missing } }] });
  }

  #partialFailure(path) {
    const f = this.failures.find((x) => x.partial && path.includes(x.pathIncludes));
    if (!f) return null;
    this.failures.splice(this.failures.indexOf(f), 1);
    return f.predicate;
  }

  #batchUpdate(type, body, path) {
    const t = this.types.get(canon(type));
    if (!t) return bad(`Unable to infer object type from: ${type}`);
    if (body.inputs.length > 100) return bad('batch update is limited to 100 inputs');
    this.writes.push({ kind: 'update', type: canon(type), inputs: body.inputs });
    const reject = this.#partialFailure(path);
    const results = [];
    const errors = [];
    for (const input of body.inputs) {
      const record = t.records.get(String(input.id));
      if (!record || reject?.(input)) {
        errors.push({ status: 'error', category: record ? 'VALIDATION_ERROR' : 'OBJECT_NOT_FOUND', message: `could not update ${input.id}`, context: { ids: [String(input.id)] } });
        continue;
      }
      for (const name of Object.keys(input.properties)) {
        if (!t.props.has(name)) return bad(`Property ${name} does not exist`);
      }
      this.updateRecord(type, input.id, input.properties);
      results.push(this.#view(record, Object.keys(input.properties)));
    }
    const base = { status: 'COMPLETE', results, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    return errors.length ? json(207, { ...base, numErrors: errors.length, errors }) : json(200, base);
  }

  // ---- associations -------------------------------------------------------

  #linkKey(fromType, toType) {
    return `${canon(fromType)}>${canon(toType)}`;
  }

  #definition(fromType, toType, typeId) {
    const from = canon(fromType);
    const to = canon(toType);
    for (const def of this.definitions) {
      const wanted = (id, isUnlabeled) => (typeId === undefined ? isUnlabeled : id === typeId);
      if (def.a === from && def.b === to && wanted(def.aToB, def.unlabeled)) {
        return { forward: { category: def.category, typeId: def.aToB, label: def.label }, reverse: { category: def.category, typeId: def.bToA, label: def.label } };
      }
      if (def.b === from && def.a === to && wanted(def.bToA, def.unlabeled)) {
        return { forward: { category: def.category, typeId: def.bToA, label: def.label }, reverse: { category: def.category, typeId: def.aToB, label: def.label } };
      }
    }
    return null;
  }

  #link(fromType, fromId, toType, toId, type, { replace = false } = {}) {
    const key = this.#linkKey(fromType, toType);
    if (!this.links.has(key)) this.links.set(key, new Map());
    const byFrom = this.links.get(key);
    if (!byFrom.has(String(fromId))) byFrom.set(String(fromId), new Map());
    const byTo = byFrom.get(String(fromId));
    if (!byTo.has(String(toId))) byTo.set(String(toId), new Map());
    const types = byTo.get(String(toId));
    if (replace) {
      for (const [key, existing] of types) if (existing.label !== null) types.delete(key);
    }
    types.set(`${type.category}:${type.typeId}`, type);
  }

  #unlink(fromType, fromId, toType, toId) {
    this.links.get(this.#linkKey(fromType, toType))?.get(String(fromId))?.delete(String(toId));
  }

  #labels(from, to) {
    const results = [];
    for (const def of this.definitions) {
      if (def.a === canon(from) && def.b === canon(to)) results.push({ category: def.category, typeId: def.aToB, label: def.label });
      else if (def.b === canon(from) && def.a === canon(to)) results.push({ category: def.category, typeId: def.bToA, label: def.label });
    }
    return json(200, { results });
  }

  #associationsRead(from, to, body) {
    if (!Array.isArray(body.inputs)) return bad('inputs is required');
    if (body.inputs.length > 1000) return bad('batch read associations is limited to 1,000 inputs');
    const byFrom = this.links.get(this.#linkKey(from, to)) || new Map();
    const results = [];
    for (const input of body.inputs) {
      const all = [...(byFrom.get(String(input.id))?.entries() || [])];
      if (all.length === 0) continue;
      const offset = Number(input.after || 0);
      const page = all.slice(offset, offset + this.associationPageSize);
      const result = {
        from: { id: String(input.id) },
        to: page.map(([toId, types]) => ({ toObjectId: Number(toId), associationTypes: [...types.values()] })),
      };
      if (offset + this.associationPageSize < all.length) result.paging = { next: { after: String(offset + this.associationPageSize) } };
      results.push(result);
    }
    return json(200, { status: 'COMPLETE', results, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  }

  #associationsCreate(from, to, body, path, isDefault) {
    if (!Array.isArray(body.inputs)) return bad('inputs is required');
    if (body.inputs.length > 2000) return bad('batch create associations is limited to 2,000 inputs');
    const resolved = [];
    for (const input of body.inputs) {
      let defs;
      if (isDefault) {
        const def = this.#definition(from, to, undefined);
        if (!def) return bad(`no default association between ${from} and ${to}`);
        defs = [def];
      } else {
        if (!Array.isArray(input.types) || input.types.length === 0) return bad('types is required');
        defs = [];
        for (const t of input.types) {
          const def = this.#definition(from, to, t.associationTypeId);
          if (!def || def.forward.category !== t.associationCategory) {
            return bad(`association type ${t.associationCategory}/${t.associationTypeId} is not valid from ${from} to ${to}`);
          }
          defs.push(def);
        }
      }
      resolved.push({ input, defs });
    }
    this.writes.push({ kind: isDefault ? 'associate-default' : 'associate', from: canon(from), to: canon(to), inputs: body.inputs });
    const reject = this.#partialFailure(path);
    const results = [];
    const errors = [];
    for (const { input, defs } of resolved) {
      const fromRecord = this.types.get(canon(from)).records.get(String(input.from.id));
      const toRecord = this.types.get(canon(to)).records.get(String(input.to.id));
      if (!fromRecord || !toRecord || reject?.(input)) {
        errors.push({ status: 'error', category: 'OBJECT_NOT_FOUND', message: `could not associate ${input.from.id} with ${input.to.id}`, context: {} });
        continue;
      }
      // Labeled create replaces the labels already on a pair, as HubSpot documents,
      // and a labeled pair always carries the unlabeled association as well.
      const unlabeled = this.#definition(from, to, undefined);
      const all = isDefault || !unlabeled ? defs : [...defs, unlabeled];
      all.forEach((def, index) => {
        const replace = !isDefault && index === 0;
        this.#link(from, input.from.id, to, input.to.id, def.forward, { replace });
        this.#link(to, input.to.id, from, input.from.id, def.reverse, { replace });
      });
      results.push({ fromObjectTypeId: canon(from), fromObjectId: String(input.from.id), toObjectTypeId: canon(to), toObjectId: String(input.to.id), labels: defs.map((d) => d.forward.label).filter(Boolean) });
    }
    const base = { status: 'COMPLETE', results, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    return errors.length ? json(207, { ...base, numErrors: errors.length, errors }) : json(isDefault ? 200 : 201, base);
  }

  #associationsArchive(from, to, body, path) {
    if (!Array.isArray(body.inputs)) return bad('inputs is required');
    if (body.inputs.length > 100) return bad('batch archive is limited to 100 from inputs');
    this.writes.push({ kind: 'archive', from: canon(from), to: canon(to), inputs: body.inputs });
    const reject = this.#partialFailure(path);
    for (const input of body.inputs) {
      for (const target of input.to) {
        if (reject?.({ from: input.from, to: target })) continue;
        this.#unlink(from, input.from.id, to, target.id);
        this.#unlink(to, target.id, from, input.from.id);
      }
    }
    return json(204, null);
  }

  #schemas() {
    const results = [];
    for (const t of this.types.values()) {
      if (!t.custom) continue;
      results.push({
        id: t.type.replace('2-', ''),
        objectTypeId: t.type,
        name: t.name,
        fullyQualifiedName: `p12345_${t.name}`,
        labels: { singular: t.name, plural: `${t.name}s` },
        properties: [...t.props.values()],
        associations: this.definitions
          .filter((d) => d.a === t.type || d.b === t.type)
          .flatMap((d) => [
            { id: String(d.aToB), fromObjectTypeId: d.a, toObjectTypeId: d.b, name: d.label || `${d.a}_to_${d.b}` },
            { id: String(d.bToA), fromObjectTypeId: d.b, toObjectTypeId: d.a, name: d.label || `${d.b}_to_${d.a}` },
          ]),
        archived: false,
      });
    }
    return json(200, { results });
  }
}
