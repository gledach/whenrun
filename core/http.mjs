/* One place that talks to the network.
 *
 * Every source goes through here so timeouts, the user agent and the failure
 * shape are identical. A source that throws a bare fetch error is impossible to
 * distinguish from a source that is simply not published yet, and those two
 * need very different handling: one is an outage, the other is Tuesday. */

const USER_AGENT = 'whenrun/0.1 (+https://github.com/gledach/whenrun)';

export class SourceError extends Error {
  constructor(message, { source, status, cause, kind = 'network' } = {}) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
    this.kind = kind; // 'network' | 'http' | 'parse' | 'empty'
    if (cause) this.cause = cause;
  }
}

/* These are free public services. Asking for several zones in a row is enough to
   earn a 429, and a daemon that gives up on the first one stops scheduling for
   the rest of the day. Transient statuses are retried with backoff; a 404 or a
   400 is not, because retrying a wrong URL is just rudeness with extra steps. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(status) {
  return RETRYABLE.has(status);
}

/** Honour Retry-After when the server sends one, in seconds or as a date. */
export function retryDelayMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 30_000));
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { source, timeoutMs = 20_000, headers = {}, retries = 2 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        signal: ac.signal,
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      });
    } catch (err) {
      lastError = new SourceError(
        ac.signal.aborted
          ? `${source}: timed out after ${timeoutMs}ms`
          : `${source}: ${err.message}`,
        { source, cause: err, kind: 'network' },
      );
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err = new SourceError(
        `${source}: HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`,
        { source, status: res.status, kind: 'http' },
      );
      if (isRetryable(res.status) && attempt < retries) {
        await sleep(retryDelayMs(res, attempt));
        lastError = err;
        continue;
      }
      throw err;
    }

    try {
      return await res.json();
    } catch (err) {
      throw new SourceError(`${source}: response was not JSON`, {
        source,
        cause: err,
        kind: 'parse',
      });
    }
  }

  throw lastError ?? new SourceError(`${source}: request failed`, { source, kind: 'network' });
}
