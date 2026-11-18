import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLACEHOLDER_PREFIX = 'REPLACE_ME';
const ASSOCIATION_CATEGORIES = new Set(['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED']);
const MULTI_TARGET_MODES = new Set(['skip', 'associate_all']);
const DEAL_TRIGGERS = new Set(['header_amount_changed', 'any_difference']);
const BACKLOG_MODES = new Set(['record_only', 'update_deals']);
const STANDARD_OBJECT_TYPES = /^(contacts?|compan(y|ies)|deals?|tickets?|0-\d+)$/i;

export class ConfigError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  throw new ConfigError(`Cannot read "${value}" as true or false`);
}

function parseNumber(name, value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} must be a number of at least ${min}`);
  return n;
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const MAX_EMAIL_RECIPIENTS = 50;

/** Splits a list of email addresses (commas, semicolons, spaces or new lines). Returns { addresses, invalid }. */
export function parseEmailList(value) {
  const parts = String(value || '').split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);
  const addresses = [];
  const invalid = [];
  for (const part of parts) {
    if (!EMAIL.test(part) || part.length > 254) invalid.push(part);
    else if (!addresses.some((a) => a.toLowerCase() === part.toLowerCase())) addresses.push(part);
  }
  return { addresses, invalid };
}

/**
 * Reads runtime settings from environment variables. Dry run is the default:
 * writes happen only when DRY_RUN is explicitly false (or --apply on the CLI).
 */
export function loadSettings(env = process.env, overrides = {}) {
  const recipients = parseEmailList(env.ALERT_EMAIL_TO);
  if (recipients.invalid.length) throw new ConfigError(`ALERT_EMAIL_TO has an address that does not look like an email address: ${recipients.invalid.join(', ')}`);
  const databaseSsl = (env.DATABASE_SSL || 'disable').trim().toLowerCase();
  if (!['disable', 'require', 'verify'].includes(databaseSsl)) throw new ConfigError('DATABASE_SSL must be disable, require or verify');
  const settings = {
    hubspotToken: env.HUBSPOT_PRIVATE_APP_TOKEN || '',
    hubspotBaseUrl: (env.HUBSPOT_API_BASE || 'https://api.hubapi.com').replace(/\/+$/, ''),
    hubspotApiVersion: env.HUBSPOT_API_VERSION || '2026-09',
    mappingFile: path.resolve(ROOT, env.MAPPING_FILE || 'config/mapping.json'),
    dryRun: parseBool(env.DRY_RUN, true),
    runIntervalMinutes: parseNumber('RUN_INTERVAL_MINUTES', env.RUN_INTERVAL_MINUTES, 30, { min: 1 }),
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl,
    reportsDir: path.resolve(ROOT, env.REPORTS_DIR || 'reports'),
    changeOverlapMinutes: parseNumber('CHANGE_OVERLAP_MINUTES', env.CHANGE_OVERLAP_MINUTES, 5),
    fullRefreshHours: parseNumber('FULL_REFRESH_HOURS', env.FULL_REFRESH_HOURS, 24),
    keepRunsDays: parseNumber('KEEP_RUNS_DAYS', env.KEEP_RUNS_DAYS, 90),
    runLockStaleMinutes: parseNumber('RUN_LOCK_STALE_MINUTES', env.RUN_LOCK_STALE_MINUTES, 15, { min: 2 }),
    logLevel: env.LOG_LEVEL || 'info',
    port: parseNumber('PORT', env.PORT, 3000, { min: 0 }),
    adminPassword: env.ADMIN_PASSWORD || '',
    adminSessionHours: parseNumber('ADMIN_SESSION_HOURS', env.ADMIN_SESSION_HOURS, 12, { min: 1 }),
    adminInsecureCookie: parseBool(env.ADMIN_INSECURE_COOKIE, false),
    alerts: {
      slackWebhookUrl: env.ALERT_SLACK_WEBHOOK_URL || '',
      emailTo: recipients.addresses,
      emailFrom: (env.ALERT_EMAIL_FROM || '').trim(),
      resendApiKey: env.RESEND_API_KEY || '',
      resendApiBase: (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, ''),
      minRepeatMinutes: parseNumber('ALERT_MIN_REPEAT_MINUTES', env.ALERT_MIN_REPEAT_MINUTES, 60),
    },
    ...overrides,
  };
  if (!/^(legacy|\d{4}-\d{2})$/.test(settings.hubspotApiVersion)) {
    throw new ConfigError('HUBSPOT_API_VERSION must be "legacy" or a date version such as 2026-09');
  }
  return settings;
}

export function isPlaceholder(value) {
  return typeof value === 'string' && value.trim().startsWith(PLACEHOLDER_PREFIX);
}

export function loadMapping(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read mapping file ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Mapping file ${file} is not valid JSON: ${err.message}`);
  }
  return normalizeMapping(parsed);
}

export function normalizeMapping(input) {
  const mapping = structuredClone(input);
  mapping.objects ??= {};
  mapping.rules ??= [];
  mapping.keyNormalization = { caseInsensitive: true, treatAsBlank: [], ...(mapping.keyNormalization || {}) };
  mapping.keyNormalization.treatAsBlank = (mapping.keyNormalization.treatAsBlank || []).map((v) => String(v).trim().toLowerCase());
  for (const obj of Object.values(mapping.objects)) {
    obj.properties ??= {};
    // HubSpot's own objects use createdate; custom objects use hs_createdate.
    obj.createdProperty ??= STANDARD_OBJECT_TYPES.test(String(obj.objectType || '')) ? 'createdate' : 'hs_createdate';
    obj.modifiedProperty ??= 'hs_lastmodifieddate';
  }
  for (const rule of mapping.rules) {
    rule.enabled = rule.enabled !== false;
    rule.onMultipleTargets ??= 'skip';
    rule.ifAssociatedElsewhere ??= 'add';
    rule.ifNoMatch ??= 'report';
    rule.label ??= rule.id;
  }
  mapping.dealAmount = {
    enabled: false,
    header: 'quoteHeader',
    deal: 'deal',
    trigger: 'header_amount_changed',
    requireOneToOne: true,
    skipClosedDeals: true,
    requireNewLines: true,
    newLinesWindowMinutes: 120,
    backfillInFullRun: false,
    amountDependsOnRule: null,
    backlogLinkedLines: 'update_deals',
    backlogSettleMinutes: 120,
    ...(mapping.dealAmount || {}),
    guard: {
      holdZeroAmount: true,
      holdLargeChange: true,
      largeChangeThreshold: 1_000_000,
      holdPercentChange: true,
      percentChangeThreshold: 50,
      releaseDealIds: [],
      ...(mapping.dealAmount?.guard || {}),
    },
    projection: {
      enabled: true,
      lineAmount: 'amount',
      ...(mapping.dealAmount?.projection || {}),
    },
  };
  const cleanup = mapping.contactCleanup || {};
  mapping.contactCleanup = {
    rule: 'contacts_to_header',
    requireNamedContactFound: true,
    removeOnlyTypeIds: null,
    ...cleanup,
    standardContacts: {
      enabled: false,
      object: 'standardContact',
      keepLinkedToNamedContact: true,
      removeOnlyTypeIds: null,
      ...(cleanup.standardContacts || {}),
    },
  };
  return mapping;
}

export function enabledRules(mapping) {
  return mapping.rules.filter((rule) => rule.enabled);
}

function checkObject(mapping, key, where, problems) {
  const obj = mapping.objects[key];
  if (!obj) {
    problems.push(`${where}: object "${key}" is not defined under objects`);
    return null;
  }
  if (!obj.objectType || isPlaceholder(obj.objectType)) {
    problems.push(`objects.${key}.objectType is not filled in`);
  }
  return obj;
}

function checkProperty(mapping, objectKey, propKey, where, problems) {
  const obj = mapping.objects[objectKey];
  if (!obj) return;
  const name = obj.properties?.[propKey];
  if (!name) {
    problems.push(`${where}: objects.${objectKey}.properties.${propKey} is not defined`);
  } else if (isPlaceholder(name)) {
    problems.push(`objects.${objectKey}.properties.${propKey} is not filled in`);
  }
}

function checkAssociation(rule, problems) {
  const a = rule.association;
  if (a === 'default') return;
  if (!a || typeof a !== 'object') {
    problems.push(`rules.${rule.id}.association must be "default" or { category, typeId }`);
    return;
  }
  if (!ASSOCIATION_CATEGORIES.has(a.category)) {
    problems.push(`rules.${rule.id}.association.category must be one of ${[...ASSOCIATION_CATEGORIES].join(', ')}`);
  }
  if (isPlaceholder(a.typeId)) {
    problems.push(`rules.${rule.id}.association.typeId is not filled in`);
  } else if (!Number.isInteger(a.typeId)) {
    problems.push(`rules.${rule.id}.association.typeId must be an integer`);
  }
}

function checkRule(mapping, rule, problems) {
  const where = `rules.${rule.id}`;
  checkObject(mapping, rule.from, where, problems);
  checkObject(mapping, rule.to, where, problems);
  if (!Array.isArray(rule.match) || rule.match.length === 0) {
    problems.push(`${where}.match must list at least one { from, to } property pair`);
  } else {
    for (const pair of rule.match) {
      checkProperty(mapping, rule.from, pair.from, where, problems);
      checkProperty(mapping, rule.to, pair.to, where, problems);
    }
  }
  checkAssociation(rule, problems);
  if (!MULTI_TARGET_MODES.has(rule.onMultipleTargets)) {
    problems.push(`${where}.onMultipleTargets must be one of ${[...MULTI_TARGET_MODES].join(', ')}`);
  }
  if (!['add', 'skip'].includes(rule.ifAssociatedElsewhere)) {
    problems.push(`${where}.ifAssociatedElsewhere must be "add" or "skip"`);
  }
  if (!['report', 'ignore_if_associated'].includes(rule.ifNoMatch)) {
    problems.push(`${where}.ifNoMatch must be "report" or "ignore_if_associated"`);
  }
}

/**
 * Returns the list of problems that stop the mapping from being used.
 * Only the parts that are switched on are checked, so Item B2 or B3 can stay
 * disabled (with their placeholders unfilled) while Item B1 runs.
 */
export function mappingProblems(mapping, { forCleanup = false } = {}) {
  const problems = [];
  const ids = new Set();
  for (const rule of mapping.rules) {
    if (!rule.id) problems.push('every rule needs an id');
    if (ids.has(rule.id)) problems.push(`rule id "${rule.id}" is used more than once`);
    ids.add(rule.id);
  }
  const active = enabledRules(mapping);
  if (active.length === 0 && !forCleanup) problems.push('no rules are enabled');
  for (const rule of active) checkRule(mapping, rule, problems);


  const deal = mapping.dealAmount;
  if (deal.enabled) {
    checkObject(mapping, deal.header, 'dealAmount', problems);
    checkObject(mapping, deal.deal, 'dealAmount', problems);
    checkProperty(mapping, deal.header, 'amount', 'dealAmount', problems);
    checkProperty(mapping, deal.deal, 'amount', 'dealAmount', problems);
    if (deal.skipClosedDeals) checkProperty(mapping, deal.deal, 'isClosed', 'dealAmount', problems);
    for (const flag of ['requireOneToOne', 'skipClosedDeals', 'requireNewLines', 'backfillInFullRun']) {
      if (typeof deal[flag] !== 'boolean') problems.push(`dealAmount.${flag} must be true or false`);
    }
    if (!DEAL_TRIGGERS.has(deal.trigger)) {
      problems.push(`dealAmount.trigger must be one of ${[...DEAL_TRIGGERS].join(', ')}`);
    }
    if (!BACKLOG_MODES.has(deal.backlogLinkedLines)) {
      problems.push(`dealAmount.backlogLinkedLines must be one of ${[...BACKLOG_MODES].join(', ')}`);
    }
    if (!Number.isFinite(deal.backlogSettleMinutes) || deal.backlogSettleMinutes < 0) {
      problems.push('dealAmount.backlogSettleMinutes must be a number of minutes, 0 or more');
    }
    const dep = deal.amountDependsOnRule ? mapping.rules.find((r) => r.id === deal.amountDependsOnRule) : null;
    if (deal.amountDependsOnRule) {
      if (!dep) problems.push(`dealAmount.amountDependsOnRule "${deal.amountDependsOnRule}" does not match any rule id`);
      else if (dep.to !== deal.header) problems.push('dealAmount.amountDependsOnRule must be a rule that associates records to the quote header');
    }
    if (deal.requireNewLines === true) {
      if (!deal.amountDependsOnRule) problems.push('dealAmount.requireNewLines needs dealAmount.amountDependsOnRule, the rule that associates lines to the quote header');
      else if (dep && !dep.enabled) problems.push(`dealAmount.requireNewLines needs the rule "${deal.amountDependsOnRule}" to be enabled`);
    }
    if (!Number.isFinite(deal.newLinesWindowMinutes) || deal.newLinesWindowMinutes < 0) {
      problems.push('dealAmount.newLinesWindowMinutes must be a number of minutes, 0 or more');
    }
    const guard = deal.guard;
    for (const flag of ['holdZeroAmount', 'holdLargeChange', 'holdPercentChange']) {
      if (typeof guard[flag] !== 'boolean') problems.push(`dealAmount.guard.${flag} must be true or false`);
    }
    if (typeof guard.largeChangeThreshold !== 'number' || !Number.isFinite(guard.largeChangeThreshold) || guard.largeChangeThreshold <= 0) {
      problems.push('dealAmount.guard.largeChangeThreshold must be a number above 0');
    }
    if (typeof guard.percentChangeThreshold !== 'number' || !Number.isFinite(guard.percentChangeThreshold) || guard.percentChangeThreshold <= 0) {
      problems.push('dealAmount.guard.percentChangeThreshold must be a percentage above 0');
    }
    if (!Array.isArray(guard.releaseDealIds) || !guard.releaseDealIds.every((id) => /^\d+$/.test(String(id)))) {
      problems.push('dealAmount.guard.releaseDealIds must be a list of deal record IDs');
    }
    const projection = deal.projection;
    if (typeof projection.enabled !== 'boolean') problems.push('dealAmount.projection.enabled must be true or false');
    if (projection.enabled === true && dep?.enabled) {
      checkProperty(mapping, dep.from, projection.lineAmount, 'dealAmount.projection', problems);
    }
  }

  if (forCleanup) {
    const cleanup = mapping.contactCleanup;
    const rule = mapping.rules.find((r) => r.id === cleanup.rule);
    if (!rule) {
      problems.push(`contactCleanup.rule "${cleanup.rule}" does not match any rule id`);
    } else if (!rule.enabled) {
      checkRule(mapping, rule, problems);
    }
    const typeIdList = (only) => only === null || (Array.isArray(only) && only.length > 0 && only.every(Number.isInteger));
    if (!typeIdList(cleanup.removeOnlyTypeIds)) {
      problems.push('contactCleanup.removeOnlyTypeIds must be null or a non-empty list of integer type IDs');
    }
    const standard = cleanup.standardContacts;
    if (typeof standard.enabled !== 'boolean') {
      problems.push('contactCleanup.standardContacts.enabled must be true or false');
    } else if (standard.enabled) {
      checkObject(mapping, standard.object, 'contactCleanup.standardContacts', problems);
      const sameObject = rule && (standard.object === rule.to
        || (mapping.objects[standard.object] && mapping.objects[standard.object].objectType === mapping.objects[rule.to]?.objectType));
      if (sameObject) {
        problems.push('contactCleanup.standardContacts.object must be the standard Contact object, not the object the contact rule associates');
      }
      if (typeof standard.keepLinkedToNamedContact !== 'boolean') {
        problems.push('contactCleanup.standardContacts.keepLinkedToNamedContact must be true or false');
      }
      if (!typeIdList(standard.removeOnlyTypeIds)) {
        problems.push('contactCleanup.standardContacts.removeOnlyTypeIds must be null or a non-empty list of integer type IDs');
      }
    }
  }
  return [...new Set(problems)];
}

export function assertValidMapping(mapping, options) {
  const problems = mappingProblems(mapping, options);
  if (problems.length) {
    throw new ConfigError('The mapping file is not ready to use:', problems);
  }
}

/** HubSpot property names to request for an object: every mapped property that has been filled in. */
export function propertiesFor(mapping, objectKey) {
  const obj = mapping.objects[objectKey];
  const names = Object.values(obj?.properties || {}).filter((name) => name && !isPlaceholder(name));
  return [...new Set(names)];
}

export function propertyName(mapping, objectKey, propKey) {
  return mapping.objects[objectKey].properties[propKey];
}

export function objectType(mapping, objectKey) {
  return mapping.objects[objectKey].objectType;
}
