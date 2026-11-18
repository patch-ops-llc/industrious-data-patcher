import { enabledRules, isPlaceholder } from './config.js';

const STANDARD_OBJECTS = new Set(['contacts', 'contact', 'companies', 'company', 'deals', 'deal', '0-1', '0-2', '0-3']);

function message(err) {
  return err?.message || String(err);
}

function schemaMatches(schema, objectType) {
  return [schema.objectTypeId, schema.name, schema.fullyQualifiedName, `p_${schema.name}`].includes(objectType);
}

/**
 * Read-only check of the mapping file against the HubSpot account: every
 * object, property and association type the middleware will use must exist.
 * Makes no changes.
 */
export async function runPreflight(ctx) {
  const { api, mapping } = ctx;
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const used = new Set();
  const needed = new Set();
  for (const rule of enabledRules(mapping)) {
    used.add(rule.from);
    used.add(rule.to);
    for (const pair of rule.match || []) {
      needed.add(`${rule.from}.${pair.from}`);
      needed.add(`${rule.to}.${pair.to}`);
    }
  }
  if (mapping.dealAmount.enabled) {
    used.add(mapping.dealAmount.header);
    used.add(mapping.dealAmount.deal);
    needed.add(`${mapping.dealAmount.header}.amount`);
    needed.add(`${mapping.dealAmount.deal}.amount`);
    if (mapping.dealAmount.skipClosedDeals) needed.add(`${mapping.dealAmount.deal}.isClosed`);
  }

  let schemas = null;
  try {
    schemas = await api.customObjectSchemas();
    add('read custom object schemas', true, `${schemas.length} custom object(s)`);
  } catch (err) {
    add('read custom object schemas', false, message(err));
  }

  for (const key of used) {
    const obj = mapping.objects[key];
    if (!obj) {
      add(`object ${key}`, false, 'not defined in the mapping file');
      continue;
    }
    if (isPlaceholder(obj.objectType)) {
      add(`object ${key}`, false, 'objectType is not filled in');
      continue;
    }
    if (!STANDARD_OBJECTS.has(obj.objectType) && schemas) {
      const found = schemas.some((schema) => schemaMatches(schema, obj.objectType));
      add(`object ${key} (${obj.objectType}) exists`, found, found ? '' : 'no custom object with this type ID or name');
      if (!found) continue;
    }
    let properties;
    try {
      properties = new Map((await api.properties(obj.objectType)).map((p) => [p.name, p]));
    } catch (err) {
      add(`read properties of ${key}`, false, message(err));
      continue;
    }
    // Every object is copied into the staging database by created/modified date.
    const wanted = { ...obj.properties, '(created date)': obj.createdProperty, '(modified date)': obj.modifiedProperty };
    for (const [propKey, name] of Object.entries(wanted)) {
      if (isPlaceholder(name)) {
        const required = needed.has(`${key}.${propKey}`);
        add(`property ${key}.${propKey}`, !required, required ? 'not filled in' : 'not filled in (only needed by a part that is switched off)');
      } else if (properties.has(name)) {
        add(`property ${key}.${propKey} (${name})`, true, `type ${properties.get(name).type}`);
      } else {
        add(`property ${key}.${propKey} (${name})`, false, 'no such property on this object');
      }
    }
  }

  for (const rule of enabledRules(mapping)) {
    const from = mapping.objects[rule.from]?.objectType;
    const to = mapping.objects[rule.to]?.objectType;
    if (!from || !to || isPlaceholder(from) || isPlaceholder(to)) {
      add(`association for ${rule.id}`, false, 'object types are not filled in');
      continue;
    }
    let labels;
    try {
      labels = await api.associationLabels(from, to);
    } catch (err) {
      add(`association for ${rule.id}`, false, message(err));
      continue;
    }
    const available = labels.map((l) => `${l.typeId} (${l.category}${l.label ? `, "${l.label}"` : ', unlabeled'})`).join('; ');
    if (rule.association === 'default') {
      add(`association for ${rule.id}: default`, labels.length > 0, labels.length ? `available: ${available}` : 'these two objects have no association defined');
    } else if (isPlaceholder(rule.association?.typeId)) {
      add(`association for ${rule.id}`, false, `typeId is not filled in. Available: ${available || 'none'}`);
    } else {
      const found = labels.some((l) => l.typeId === rule.association.typeId && l.category === rule.association.category);
      add(`association for ${rule.id}: type ${rule.association.typeId}`, found, found ? '' : `not found in this direction. Available: ${available || 'none'}`);
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Read-only listing to help fill in the mapping file: custom objects with
 * their non-HubSpot properties, custom properties on contacts, companies and
 * deals, and the association types between objects already filled in.
 */
export async function runDiscover(ctx) {
  const { api, mapping } = ctx;
  const custom = (p) => p.hubspotDefined !== true && !String(p.name).startsWith('hs_');
  const brief = (p) => ({ name: p.name, label: p.label, type: p.type });

  const out = { customObjects: [], standardObjectCustomProperties: {}, associationTypes: [], errors: [] };

  let schemas = [];
  try {
    schemas = await api.customObjectSchemas();
  } catch (err) {
    out.errors.push(`custom object schemas: ${message(err)}`);
  }
  for (const schema of schemas) {
    out.customObjects.push({
      name: schema.name,
      label: schema.labels?.singular,
      objectTypeId: schema.objectTypeId,
      fullyQualifiedName: schema.fullyQualifiedName,
      properties: (schema.properties || []).filter(custom).map(brief),
      associations: (schema.associations || []).map((a) => ({
        typeId: Number(a.id),
        name: a.name,
        fromObjectTypeId: a.fromObjectTypeId,
        toObjectTypeId: a.toObjectTypeId,
      })),
    });
  }

  for (const type of ['contacts', 'companies', 'deals']) {
    try {
      out.standardObjectCustomProperties[type] = (await api.properties(type)).filter(custom).map(brief);
    } catch (err) {
      out.errors.push(`${type} properties: ${message(err)}`);
    }
  }

  for (const rule of mapping.rules) {
    const from = mapping.objects[rule.from]?.objectType;
    const to = mapping.objects[rule.to]?.objectType;
    if (!from || !to || isPlaceholder(from) || isPlaceholder(to)) continue;
    try {
      out.associationTypes.push({ rule: rule.id, from, to, types: await api.associationLabels(from, to) });
    } catch (err) {
      out.errors.push(`association types for ${rule.id}: ${message(err)}`);
    }
  }
  return out;
}
