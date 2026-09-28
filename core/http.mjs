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

export async function getJson(url, { source, timeoutMs = 20_000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
    });
  } catch (err) {
    throw new SourceError(
      ac.signal.aborted
        ? `${source}: timed out after ${timeoutMs}ms`
        : `${source}: ${err.message}`,
      { source, cause: err, kind: 'network' },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new SourceError(`${source}: HTTP ${res.status}`, {
      source,
      status: res.status,
      kind: 'http',
    });
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
