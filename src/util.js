export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Parses a HubSpot property value as a number. Returns null when blank or not numeric. */
export function toNumber(value) {
  if (isBlank(value)) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export function compareIds(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function runStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}
