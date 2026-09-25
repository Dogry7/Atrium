import { truncate, safeJson } from '../../util.js';

/** Web & HTTP connector: fetch pages as readable text, call any REST API. */
export default {
  id: 'web',
  name: 'Web & HTTP',
  description: 'Lets agents read web pages and call any REST API or outgoing webhook.',
  icon: 'globe',
  category: 'connector',
  configFields: [
    { key: 'allowedDomains', label: 'Allowed domains', type: 'text', help: 'Optional, comma separated (e.g. api.github.com, example.com). Blank = any domain.' },
    { key: 'defaultHeaders', label: 'Default headers (JSON)', type: 'json', help: 'Sent with every http_request, e.g. {"Authorization": "Bearer …"}' },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 20000 },
    { key: 'maxChars', label: 'Max characters returned', type: 'number', default: 12000 },
  ],

  async create(config) {
    const allowed = String(config.allowedDomains || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const defaultHeaders = typeof config.defaultHeaders === 'object' && config.defaultHeaders ? config.defaultHeaders : safeJson(config.defaultHeaders || '{}', {}) || {};
    const timeoutMs = Number(config.timeoutMs) || 20000;
    const maxChars = Number(config.maxChars) || 12000;

    const check = (url) => {
      let u;
      try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
      if (allowed.length && !allowed.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) {
        throw new Error(`${u.hostname} is not in this connector's allowed domains (${allowed.join(', ')})`);
      }
      return u;
    };

    const doFetch = async (url, init = {}, signal) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      try {
        return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
      } catch (e) {
        if (ctrl.signal.aborted && !signal?.aborted) throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        throw new Error(`Request failed: ${e.cause?.code || e.message}`);
      } finally { clearTimeout(t); }
    };

    return {
      async listTools() {
        return [
          {
            name: 'web_fetch',
            description: 'Fetch a web page or URL and return its readable text content (HTML is converted to text). Use for reading articles, docs, or JSON endpoints.',
            inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' } }, required: ['url'] },
          },
          {
            name: 'http_request',
            description: 'Make an HTTP request to any REST API or webhook. Returns status, key headers and body.',
            inputSchema: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
                url: { type: 'string' },
                headers: { type: 'object', additionalProperties: { type: 'string' } },
                body: { description: 'JSON object or string body' },
              },
              required: ['url'],
            },
          },
        ];
      },

      async callTool(name, args = {}, { signal } = {}) {
        if (name === 'web_fetch') {
          const u = check(args.url);
          const res = await doFetch(u, { headers: { 'user-agent': 'AtriumAgent/1.0 (+local)', accept: 'text/html,application/json,text/plain,*/*' } }, signal);
          const ct = res.headers.get('content-type') || '';
          const raw = await res.text();
          let text;
          if (ct.includes('json')) text = JSON.stringify(safeJson(raw, raw), null, 2);
          else if (ct.includes('html')) text = htmlToText(raw);
          else text = raw;
          const title = ct.includes('html') ? (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() : '';
          return `URL: ${res.url}\nStatus: ${res.status}${title ? `\nTitle: ${decodeEntities(title)}` : ''}\n\n${truncate(text, maxChars)}`;
        }
        if (name === 'http_request') {
          const u = check(args.url);
          const method = String(args.method || 'GET').toUpperCase();
          const headers = { ...defaultHeaders, ...(args.headers || {}) };
          let body;
          if (args.body != null && method !== 'GET') {
            if (typeof args.body === 'string') body = args.body;
            else { body = JSON.stringify(args.body); headers['content-type'] ||= 'application/json'; }
          }
          const res = await doFetch(u, { method, headers, body }, signal);
          const raw = await res.text();
          const ct = res.headers.get('content-type') || '';
          return {
            status: res.status,
            ok: res.ok,
            contentType: ct,
            body: ct.includes('json') ? safeJson(raw, truncate(raw, maxChars)) : truncate(ct.includes('html') ? htmlToText(raw) : raw, maxChars),
          };
        }
        throw new Error(`Unknown tool ${name}`);
      },

      async test() { return { ok: true, message: allowed.length ? `Ready. Limited to: ${allowed.join(', ')}` : 'Ready. Any domain allowed.' }; },
      async close() {},
    };
  },
};

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|footer|pre|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
