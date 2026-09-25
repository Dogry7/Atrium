import { sleep } from '../util.js';

export class ProviderError extends Error {
  constructor(message, { status, provider, retryable = false, raw } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status; this.provider = provider; this.retryable = retryable; this.raw = raw;
  }
}

export function friendlyError(provider, status, body) {
  let detail = '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    detail = j?.error?.message || j?.message || j?.error || '';
  } catch { detail = String(body || '').slice(0, 300); }
  const label = provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI-compatible provider' : provider;
  const map = {
    400: `${label} rejected the request${detail ? `: ${detail}` : ''}`,
    401: `${label} API key was rejected (401). Check the key in Settings.`,
    403: `${label} refused access (403)${detail ? `: ${detail}` : ''}`,
    404: `${label} could not find that model or endpoint (404)${detail ? `: ${detail}` : ''}`,
    429: `${label} rate limit hit (429). Atrium retried; try again shortly.`,
    529: `${label} is overloaded right now (529). Try again shortly.`,
  };
  const msg = map[status] || `${label} error ${status}${detail ? `: ${detail}` : ''}`;
  return new ProviderError(msg, { status, provider, retryable: status === 429 || status >= 500, raw: detail });
}

/** fetch with retries on 429/5xx/network errors. */
export async function fetchWithRetry(provider, url, init, { retries = 2, signal } = {}) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= retries) {
        throw new ProviderError(`Could not reach ${provider} at ${new URL(url).origin} (${e.cause?.code || e.message})`, { provider, retryable: true });
      }
      attempt++; await sleep(500 * 2 ** attempt, signal); continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const err = friendlyError(provider, res.status, text);
    if (err.retryable && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      attempt++;
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 700 * 2 ** attempt, signal);
      continue;
    }
    throw err;
  }
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
