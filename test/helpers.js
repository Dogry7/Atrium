import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.ATRIUM_SIM_FAST ??= '1';
const { createApp } = await import('../server/app.js');
import { providers } from '../server/providers/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpDir(prefix = 'atrium-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Start an isolated Atrium on a random port with a fresh data dir. */
export async function startApp(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const app = await createApp({ port: 0, dataDir, quiet: true, pluginDir: opts.pluginDir ?? path.join(ROOT, 'plugins'), seedData: opts.seedData ?? true });
  const base = app.url;
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    app, base, dataDir,
    get: (p, h) => req('GET', p, undefined, h), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b, h) => req('PUT', p, b, h),
    patch: (p, b, h) => req('PATCH', p, b, h), del: (p, h) => req('DELETE', p, undefined, h),
    agent: (name) => app.store.all('agents').find((a) => a.name === name),
    close: () => app.close(),
  };
}

export async function waitFor(fn, { timeout = 10000, interval = 50, message = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/** Collect bus events while fn runs. */
export function recordEvents(app) {
  const events = [];
  const on = (e) => events.push(e);
  app.bus.on('event', on);
  return { events, stop: () => app.bus.off('event', on), of: (type) => events.filter((e) => e.type === type) };
}

/**
 * Register a scripted provider: `script(ctx)` is called per model turn with
 * { messages, tools, meta, call } and returns content blocks.
 */
export function scriptedProvider(id, script) {
  const calls = [];
  providers[id] = {
    id, name: `Scripted ${id}`, defaultModel: 'script', suggestedModels: [], configFields: [],
    isConfigured: () => true, listModels: async () => [],
    async chat(args) {
      calls.push({ ...args, messages: structuredClone(args.messages) });
      if (args.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const content = await script({ ...args, messages: structuredClone(args.messages), call: calls.length });
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) args.onDelta?.(text);
      return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input: 10, output: 5 } };
    },
  };
  return { calls, remove: () => delete providers[id] };
}

/** Tiny HTTP server helper. handler(req, res, body) */
export async function httpServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    try { await handler(req, res, body); } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(String(e)); } }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(typeof e === 'string' ? e : `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`);
  res.end();
};
