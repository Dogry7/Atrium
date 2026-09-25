import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseSSE } from '../providers/sse.js';
import { safeJson } from '../util.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'atrium', title: 'Atrium', version: '1.0.0' };

/**
 * Model Context Protocol client. Transports:
 *  - stdio: spawn a command, newline-delimited JSON-RPC over stdin/stdout
 *  - http: Streamable HTTP (POST, JSON or SSE response, Mcp-Session-Id)
 *  - sse: legacy HTTP+SSE (GET stream announces a POST endpoint)
 */
export class McpClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = { timeoutMs: 60000, ...opts };
    this.nextId = 1;
    this.pending = new Map();
    this.serverInfo = null;
    this.capabilities = null;
    this.stderr = '';
    this.closed = false;
  }

  async connect() {
    const t = this.opts.transport || (this.opts.url ? 'http' : 'stdio');
    this.transport = t;
    if (t === 'stdio') await this.#startStdio();
    else if (t === 'sse') await this.#startLegacySse();
    const init = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: CLIENT_INFO,
    });
    this.serverInfo = init.serverInfo;
    this.capabilities = init.capabilities || {};
    this.protocolVersion = init.protocolVersion;
    await this.notify('notifications/initialized');
    return init;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args, { signal } = {}) {
    return this.request('tools/call', { name, arguments: args || {} }, { signal });
  }

  // ---------------------------------------------------------------- JSON-RPC core
  request(method, params, { signal } = {}) {
    if (this.closed) return Promise.reject(new Error('MCP connection is closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.opts.timeoutMs / 1000}s`));
      }, this.opts.timeoutMs);
      const onAbort = () => {
        this.pending.delete(id); clearTimeout(timer);
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' }).catch(() => {});
        reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      this.#send(msg).catch((e) => { const p = this.pending.get(id); this.pending.delete(id); p?.reject(e); });
    });
  }

  notify(method, params) { return this.#send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  #handleMessage(msg) {
    if (Array.isArray(msg)) { msg.forEach((m) => this.#handleMessage(m)); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'MCP error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      // Server → client request. We answer the ones we understand.
      let result = null, error = null;
      if (msg.method === 'ping') result = {};
      else if (msg.method === 'roots/list') result = { roots: [] };
      else error = { code: -32601, message: `Atrium client does not support ${msg.method}` };
      this.#send({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }).catch(() => {});
      return;
    }
    if (msg.method) this.emit('notification', msg);
    if (msg.method === 'notifications/tools/list_changed') this.emit('tools_changed');
  }

  async #send(msg) {
    if (this.transport === 'stdio') {
      if (!this.proc || this.proc.exitCode != null) throw new Error(`MCP server process is not running${this.stderr ? `: ${this.stderr.slice(-300)}` : ''}`);
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      return;
    }
    if (this.transport === 'sse') {
      const res = await fetch(this.postUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...this.opts.headers }, body: JSON.stringify(msg) });
      if (!res.ok) throw new Error(`MCP POST failed: HTTP ${res.status}`);
      await res.text();
      return;
    }
    // Streamable HTTP
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.opts.headers };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    const res = await fetch(this.opts.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) { await res.text().catch(() => {}); return; }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP server returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      // Read the stream in the background; responses resolve pending requests.
      (async () => {
        try { for await (const evt of parseSSE(res.body)) this.#handleMessage(safeJson(evt.data)); }
        catch (e) { this.emit('error', e); }
      })();
    } else {
      const text = await res.text();
      if (text.trim()) this.#handleMessage(safeJson(text));
    }
  }

  async #startStdio() {
    const { command, args = [], env = {}, cwd } = this.opts;
    if (!command) throw new Error('MCP stdio transport needs a command');
    await new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      this.proc = proc;
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line) { const m = safeJson(line); if (m) this.#handleMessage(m); }
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
      proc.once('spawn', resolve);
      proc.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `Command not found: "${command}". Is it installed and on your PATH?` : e.message)));
      proc.once('exit', (code) => {
        const err = new Error(`MCP server exited (code ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!this.closed) this.emit('exit', code);
      });
    });
  }

  async #startLegacySse() {
    const ctrl = new AbortController();
    this.sseAbort = ctrl;
    const res = await fetch(this.opts.url, { headers: { accept: 'text/event-stream', ...this.opts.headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`MCP SSE connect failed: HTTP ${res.status}`);
    const iter = parseSSE(res.body, ctrl.signal)[Symbol.asyncIterator]();
    // First event must be `endpoint`
    while (true) {
      const { value, done } = await iter.next();
      if (done) throw new Error('MCP SSE stream closed before announcing an endpoint');
      if (value.event === 'endpoint') { this.postUrl = new URL(value.data, this.opts.url).toString(); break; }
    }
    (async () => {
      try { while (true) { const { value, done } = await iter.next(); if (done) break; if (value.event === 'message') this.#handleMessage(safeJson(value.data)); } }
      catch (e) { if (!this.closed) this.emit('error', e); }
    })();
  }

  async close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('MCP connection closed'));
    this.pending.clear();
    if (this.proc && this.proc.exitCode == null) {
      this.proc.stdin.end();
      const p = this.proc;
      setTimeout(() => { if (p.exitCode == null) p.kill('SIGTERM'); }, 500).unref();
    }
    if (this.transport === 'http' && this.sessionId) {
      fetch(this.opts.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.opts.headers } }).catch(() => {});
    }
    this.sseAbort?.abort();
  }
}

/** Flatten an MCP tools/call result into something an LLM can read. */
export function mcpResultToText(r) {
  if (!r) return '(empty result)';
  const parts = (r.content || []).map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'image') return `[image ${c.mimeType}, ${Math.round((c.data?.length || 0) * 0.75 / 1024)}KB]`;
    if (c.type === 'audio') return `[audio ${c.mimeType}]`;
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri}]`;
    if (c.type === 'resource_link') return `[resource link: ${c.name || ''} ${c.uri}]`;
    return JSON.stringify(c);
  });
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join('\n') || '(empty result)';
}
