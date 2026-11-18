import { sleep as realSleep } from '../util.js';

export class HubSpotApiError extends Error {
  constructor({ status, method, path, body }) {
    const detail = body && typeof body === 'object' ? body.message || body.category : body;
    super(`HubSpot ${method} ${path} failed with ${status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
    this.name = 'HubSpotApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

export class DryRunViolation extends Error {
  constructor(method, path) {
    super(`Refusing to send ${method} ${path}: the client is in dry run`);
    this.name = 'DryRunViolation';
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Minimal HubSpot HTTP client.
 *
 * - read() is for requests that change nothing (GET, search, batch read).
 * - write() is for everything else. In dry run it sends nothing and returns
 *   null; callers record what they would have sent.
 * - Requests are sent one at a time and spaced to stay under HubSpot's burst
 *   limits (search has its own, lower limit).
 */
export class HubSpotClient {
  constructor({
    token,
    baseUrl = 'https://api.hubapi.com',
    dryRun = true,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    logger,
    minIntervalMs = 110,
    searchMinIntervalMs = 260,
    maxAttempts = 6,
    timeoutMs = 60_000,
  } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dryRun = dryRun;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
    this.minIntervalMs = minIntervalMs;
    this.searchMinIntervalMs = searchMinIntervalMs;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.nextAllowedAt = 0;
    this.nextSearchAllowedAt = 0;
    this.stats = { requests: 0, reads: 0, writes: 0, writesSkippedInDryRun: 0, retries: 0 };
  }

  async read(method, path, { body, query, search = false } = {}) {
    this.stats.reads += 1;
    return this.#send(method, path, { body, query, search });
  }

  async write(method, path, { body } = {}) {
    if (this.dryRun) {
      this.stats.writesSkippedInDryRun += 1;
      return null;
    }
    this.stats.writes += 1;
    return this.#send(method, path, { body, isWrite: true });
  }

  async #throttle(search) {
    const now = Date.now();
    const wait = Math.max(this.nextAllowedAt - now, search ? this.nextSearchAllowedAt - now : 0, 0);
    if (wait > 0) await this.sleep(wait);
    const sentAt = Date.now();
    this.nextAllowedAt = sentAt + this.minIntervalMs;
    if (search) this.nextSearchAllowedAt = sentAt + this.searchMinIntervalMs;
  }

  async #send(method, path, { body, query, search = false, isWrite = false }) {
    if (isWrite && this.dryRun) throw new DryRunViolation(method, path);
    if (!this.token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set');

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));

    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.#throttle(search);
      this.stats.requests += 1;
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        if (attempt === this.maxAttempts) break;
        await this.#backoff(attempt, null, method, path, err.message);
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const text = await response.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      lastError = new HubSpotApiError({ status: response.status, method, path, body: parsed });
      // The daily quota only resets at midnight, so waiting a few seconds cannot help.
      const dailyLimit = response.status === 429 && parsed?.policyName === 'DAILY';
      if (!RETRYABLE.has(response.status) || dailyLimit || attempt === this.maxAttempts) break;
      await this.#backoff(attempt, response.headers.get('retry-after'), method, path, `status ${response.status}`);
    }
    throw lastError;
  }

  async #backoff(attempt, retryAfter, method, path, reason) {
    this.stats.retries += 1;
    const header = Number(retryAfter);
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(30_000, 500 * 2 ** attempt);
    this.logger?.warn('hubspot request will be retried', { method, path, attempt, waitMs: wait, reason });
    await this.sleep(wait);
  }
}
