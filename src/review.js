import { enabledRules } from './config.js';

/**
 * What the admin page's Review section needs to know about the mapping: which
 * rules exist, what their records are called, and how to link to a record in
 * HubSpot. Plain data, worked out once when the service starts.
 */

// HubSpot's own objects are addressed by name in the API and by type ID in record links.
const STANDARD_TYPE_IDS = { contacts: '0-1', contact: '0-1', companies: '0-2', company: '0-2', deals: '0-3', deal: '0-3', tickets: '0-5', ticket: '0-5' };

/** The object type ID used in HubSpot record links, or null when it cannot be told. */
export function objectTypeId(objectType) {
  const type = String(objectType ?? '').trim().toLowerCase();
  if (/^\d+-\d+$/.test(type)) return type;
  return STANDARD_TYPE_IDS[type] ?? null;
}

/** The address of a record in HubSpot, or null without a portal ID, a known object type or a numeric record ID. */
export function recordUrl(portalId, objectType, id) {
  const typeId = objectTypeId(objectType);
  if (!/^\d+$/.test(String(portalId ?? '')) || !typeId || !/^\d+$/.test(String(id ?? ''))) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/${typeId}/${id}`;
}

// The reasons a record is on the review list (review_items.status), in the order they are shown.
export const REVIEW_STATUSES = ['multiple_targets', 'associated_elsewhere', 'no_target', 'missing_key', 'failed'];

export function reviewCatalog(mapping) {
  const object = (key) => {
    const obj = mapping.objects[key] || {};
    return { key, label: obj.label || key, objectType: obj.objectType ?? null };
  };
  const rules = enabledRules(mapping).map((rule) => ({
    id: rule.id,
    label: rule.label,
    from: object(rule.from),
    to: object(rule.to),
    keys: (rule.match || []).map((pair) => mapping.objects[rule.from]?.properties?.[pair.from]).filter(Boolean),
  }));
  // Rules between the same two kinds of record are shown together, as in Link health.
  const pairs = [];
  for (const rule of rules) {
    let pair = pairs.find((p) => p.from.key === rule.from.key && p.to.key === rule.to.key);
    if (!pair) {
      pair = { id: `${rule.from.key}-${rule.to.key}`.replace(/[^A-Za-z0-9_-]/g, ''), from: rule.from, to: rule.to, rules: [] };
      pairs.push(pair);
    }
    pair.rules.push(rule);
  }
  const cfg = mapping.dealAmount;
  const dealAmount = cfg?.enabled
    ? {
      header: object(cfg.header),
      deal: object(cfg.deal),
      quoteNumberProperty: mapping.objects[cfg.header]?.properties?.quoteNumber ?? null,
      guard: {
        largeChangeThreshold: cfg.guard?.largeChangeThreshold ?? null,
        percentChangeThreshold: cfg.guard?.percentChangeThreshold ?? null,
      },
    }
    : null;
  return { portalId: mapping.portalId ?? null, rules, pairs, dealAmount };
}
