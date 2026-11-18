import { chunk, compareIds } from '../util.js';
import { endpoints } from './endpoints.js';
import { HubSpotApiError } from './client.js';

// Limits published by HubSpot (CRM search guide and associations guide, 2026-09).
export const LIMITS = {
  searchPageSize: 200,
  searchBodyChars: 3000,
  searchInValues: 100,
  objectBatch: 100,
  objectBatchWithHistory: 50,
  associationRead: 1000,
  associationWrite: 100,
  associationArchiveFroms: 100,
};

const NOT_FOUND = new Set(['OBJECT_NOT_FOUND', 'NOT_FOUND']);

function describeError(err) {
  if (err instanceof HubSpotApiError) return `${err.status}: ${err.message}`;
  return err?.message || String(err);
}

/** The calls the middleware makes, expressed against a HubSpotClient. */
export class HubSpotApi {
  constructor(client, { apiVersion = '2026-09', logger } = {}) {
    this.client = client;
    this.paths = endpoints(apiVersion);
    this.logger = logger;
  }

  get dryRun() {
    return this.client.dryRun;
  }

  /**
   * Pages through every record matching the filters. Paging uses an
   * hs_object_id cursor rather than the search "after" offset, because search
   * refuses to page past 10,000 results.
   */
  async *searchPages(objectType, { filterGroups = [], properties = [], pageSize = LIMITS.searchPageSize } = {}) {
    let lastId = null;
    for (;;) {
      const cursor = lastId === null ? [] : [{ propertyName: 'hs_object_id', operator: 'GT', value: lastId }];
      const base = filterGroups.length ? filterGroups : [{ filters: [] }];
      const groups = base
        .map((group) => ({ filters: [...group.filters, ...cursor] }))
        .filter((group) => group.filters.length > 0);
      const body = {
        filterGroups: groups,
        properties,
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
        limit: pageSize,
      };
      const size = JSON.stringify(body).length;
      if (size > LIMITS.searchBodyChars) {
        throw new Error(`Search request for ${objectType} is ${size} characters; HubSpot allows ${LIMITS.searchBodyChars}`);
      }
      const response = await this.client.read('POST', this.paths.search(objectType), { body, search: true });
      const results = response?.results || [];
      if (results.length === 0) return;
      yield results;
      if (results.length < pageSize) return;
      lastId = results.reduce((max, r) => (compareIds(r.id, max) > 0 ? r.id : max), results[0].id);
    }
  }

  async searchAll(objectType, options) {
    const out = [];
    for await (const page of this.searchPages(objectType, options)) out.push(...page);
    return out;
  }

  /**
   * Records whose property equals one of the values. Values are sent
   * lower-cased because HubSpot requires that for IN on string properties;
   * callers must still compare keys themselves.
   */
  async findByPropertyIn(objectType, propertyName, values, properties) {
    if (propertyName === 'hs_object_id') {
      // Matching on the record ID itself: read by ID (no search index lag) and
      // ignore values that cannot be a record ID.
      const ids = [...new Set(values.map((v) => String(v).trim()).filter((v) => /^\d{1,19}$/.test(v)))];
      const records = await this.batchRead(objectType, ids, properties);
      for (const record of records) {
        record.properties ??= {};
        record.properties.hs_object_id ??= record.id;
      }
      return records;
    }
    const distinct = [...new Set(values.map((v) => String(v).toLowerCase()))];
    const out = [];
    const seen = new Set();
    // Leave room in the 3,000 character body for the fixed parts and the paging cursor.
    const fixed = JSON.stringify({
      filterGroups: [{ filters: [{ propertyName, operator: 'IN', values: [] }, { propertyName: 'hs_object_id', operator: 'GT', value: '9'.repeat(20) }] }],
      properties,
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: LIMITS.searchPageSize,
    }).length;
    const budget = LIMITS.searchBodyChars - fixed - 20;
    if (budget < 50) throw new Error(`Too many properties requested for a ${objectType} search`);

    let batch = [];
    let used = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const filterGroups = [{ filters: [{ propertyName, operator: 'IN', values: batch }] }];
      for await (const page of this.searchPages(objectType, { filterGroups, properties })) {
        for (const record of page) {
          if (!seen.has(record.id)) {
            seen.add(record.id);
            out.push(record);
          }
        }
      }
      batch = [];
      used = 0;
    };
    for (const value of distinct) {
      const cost = JSON.stringify(value).length + 1;
      if (cost > budget) throw new Error(`Key value is too long to search for: ${value.slice(0, 40)}...`);
      if (batch.length >= LIMITS.searchInValues || used + cost > budget) await flush();
      batch.push(value);
      used += cost;
    }
    await flush();
    return out;
  }

  /** Reads records by ID. IDs that no longer exist are simply absent from the result. */
  async batchRead(objectType, ids, properties, { propertiesWithHistory = [] } = {}) {
    const size = propertiesWithHistory.length ? LIMITS.objectBatchWithHistory : LIMITS.objectBatch;
    const out = [];
    for (const group of chunk([...new Set(ids.map(String))], size)) {
      const body = { properties, propertiesWithHistory, inputs: group.map((id) => ({ id })) };
      const response = await this.client.read('POST', this.paths.batchRead(objectType), { body });
      const serious = (response?.errors || []).filter((e) => !NOT_FOUND.has(e.category));
      if (serious.length) {
        throw new Error(`Batch read of ${objectType} reported errors: ${serious.map((e) => e.message).join('; ')}`);
      }
      out.push(...(response?.results || []));
    }
    return out;
  }

  /**
   * Existing associations from each record to records of another type.
   * Returns Map(fromId -> [{ id, types: [{ category, typeId, label }] }]).
   */
  async readAssociations(fromType, toType, ids) {
    const map = new Map();
    for (const id of ids) map.set(String(id), []);
    const queue = [...map.keys()].map((id) => ({ id }));
    while (queue.length) {
      const inputs = queue.splice(0, LIMITS.associationRead);
      const response = await this.client.read('POST', this.paths.associationsRead(fromType, toType), { body: { inputs } });
      for (const result of response?.results || []) {
        const fromId = String(result.from.id);
        const list = map.get(fromId) ?? [];
        for (const to of result.to || []) {
          list.push({ id: String(to.toObjectId), types: to.associationTypes || [] });
        }
        map.set(fromId, list);
        const after = result.paging?.next?.after;
        if (after) queue.push({ id: fromId, after });
      }
    }
    return map;
  }

  /**
   * Creates associations for [{ fromId, toId }] pairs. Returns the pairs in
   * chunks that HubSpot rejected or reported errors for; the caller re-reads
   * to see what actually exists. In dry run nothing is sent.
   */
  async createAssociations(fromType, toType, pairs, association) {
    const troubled = [];
    for (const group of chunk(pairs, LIMITS.associationWrite)) {
      let path;
      let body;
      if (association === 'default') {
        path = this.paths.associationsCreateDefault(fromType, toType);
        body = { inputs: group.map((p) => ({ from: { id: p.fromId }, to: { id: p.toId } })) };
      } else {
        path = this.paths.associationsCreate(fromType, toType);
        const types = (association.types || [association]).map((t) => ({
          associationCategory: t.category,
          associationTypeId: t.typeId,
        }));
        body = { inputs: group.map((p) => ({ from: { id: p.fromId }, to: { id: p.toId }, types })) };
      }
      try {
        const response = await this.client.write('POST', path, { body });
        if (response && (response.numErrors > 0 || response.errors?.length)) {
          troubled.push({ pairs: group, error: (response.errors || []).map((e) => e.message).join('; ') || 'batch reported errors' });
        }
      } catch (err) {
        troubled.push({ pairs: group, error: describeError(err) });
      }
    }
    return troubled;
  }

  /** Removes every association between each [{ fromId, toId }] pair. */
  async archiveAssociations(fromType, toType, pairs) {
    const byFrom = new Map();
    for (const pair of pairs) {
      if (!byFrom.has(pair.fromId)) byFrom.set(pair.fromId, []);
      byFrom.get(pair.fromId).push(pair.toId);
    }
    const inputs = [...byFrom.entries()].map(([fromId, toIds]) => ({ from: { id: fromId }, to: toIds.map((id) => ({ id })) }));
    const troubled = [];
    for (const group of chunk(inputs, LIMITS.associationArchiveFroms)) {
      const groupPairs = group.flatMap((input) => input.to.map((to) => ({ fromId: input.from.id, toId: to.id })));
      try {
        const response = await this.client.write('POST', this.paths.associationsArchive(fromType, toType), { body: { inputs: group } });
        if (response && (response.numErrors > 0 || response.errors?.length)) {
          troubled.push({ pairs: groupPairs, error: (response.errors || []).map((e) => e.message).join('; ') || 'batch reported errors' });
        }
      } catch (err) {
        troubled.push({ pairs: groupPairs, error: describeError(err) });
      }
    }
    return troubled;
  }

  /** Updates [{ id, properties }]. Returns [{ id, error }] for records that were not updated. */
  async updateObjects(objectType, inputs) {
    const failed = [];
    for (const group of chunk(inputs, LIMITS.objectBatch)) {
      try {
        const response = await this.client.write('POST', this.paths.batchUpdate(objectType), { body: { inputs: group } });
        if (response && (response.numErrors > 0 || response.errors?.length)) {
          const updated = new Set((response.results || []).map((r) => String(r.id)));
          const message = (response.errors || []).map((e) => e.message).join('; ') || 'batch reported errors';
          for (const input of group) {
            if (!updated.has(String(input.id))) failed.push({ id: input.id, error: message });
          }
        }
      } catch (err) {
        for (const input of group) failed.push({ id: input.id, error: describeError(err) });
      }
    }
    return failed;
  }

  async associationLabels(fromType, toType) {
    const response = await this.client.read('GET', this.paths.associationLabels(fromType, toType));
    return response?.results || [];
  }

  async customObjectSchemas() {
    const response = await this.client.read('GET', this.paths.schemas());
    return response?.results || [];
  }

  async properties(objectType) {
    const response = await this.client.read('GET', this.paths.properties(objectType));
    return response?.results || [];
  }
}
