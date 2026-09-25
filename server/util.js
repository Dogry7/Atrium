import crypto from 'node:crypto';

export const id = (prefix = '') => `${prefix}${prefix ? '_' : ''}${crypto.randomBytes(6).toString('hex')}`;
export const uuid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

export function abortError(msg = 'Cancelled') {
  const e = new Error(msg); e.name = 'AbortError'; return e;
}

export function slugify(s, max = 24) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'x';
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for both Anthropic and OpenAI. */
export function toolName(...parts) {
  return parts.join('__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function truncate(s, n = 400) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  if (s == null) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function mask(secret) {
  if (!secret) return '';
  const s = String(secret);
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function safeJson(s, fallback = undefined) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Stringify tool results for the model. */
export function resultToText(r) {
  if (r == null) return '(no result)';
  if (typeof r === 'string') return r;
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
