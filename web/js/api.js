/** REST + SSE client. */
export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Can’t reach the Atrium server. Is it still running?', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.details);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

/** Live event stream with automatic reconnection and catch-up. */
export function connectEvents({ onEvent, onStatus, getSeq }) {
  let es, closed = false, retry = 0;
  const open = () => {
    const since = getSeq?.() || 0;
    es = new EventSource(`/api/events${since ? `?since=${since}` : ''}`);
    es.onopen = () => { retry = 0; onStatus?.('live'); };
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = () => {
      onStatus?.('reconnecting');
      es.close();
      if (!closed) setTimeout(open, Math.min(8000, 800 * 2 ** retry++));
    };
  };
  open();
  return () => { closed = true; es?.close(); };
}
