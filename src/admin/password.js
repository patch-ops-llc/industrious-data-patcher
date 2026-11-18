import crypto from 'node:crypto';

/**
 * Password hashing for the admin page, with Node's built-in scrypt.
 *
 * A hash is stored as "scrypt$N$r$p$salt$key" (salt and key in base64), so
 * the cost settings can be raised later without breaking stored hashes.
 */

const COST = { n: 32_768, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
// Upper bounds for a stored hash, so a damaged row cannot ask for an absurd amount of work.
const MAX_COST = { n: 1_048_576, r: 32, p: 8 };

function derive(password, salt, { n, r, p }, keyBytes) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(password), 'utf8'), salt, keyBytes, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, KEY_BYTES);
  return ['scrypt', COST.n, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** True when the password is the one the stored hash was made from. Never throws on a malformed hash. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const powerOfTwo = Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
  if (!powerOfTwo || n > MAX_COST.n || !Number.isInteger(r) || r < 1 || r > MAX_COST.r || !Number.isInteger(p) || p < 1 || p > MAX_COST.p) return false;
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  try {
    const key = await derive(password, salt, { n, r, p }, expected.length);
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
