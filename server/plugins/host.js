import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import web from './builtin/web.js';
import mcp from './builtin/mcp.js';
import laya from './builtin/laya.js';
import a2aRemote from './builtin/a2a-remote.js';
import { id as newId, now, slugify, toolName, mask, truncate } from '../util.js';

const BUILTINS = [web, mcp, laya, a2aRemote];

/**
 * Loads plugin types (built-in + drop-in folders under /plugins) and manages
 * connector instances (a configured plugin). Instances start lazily and are cached.
 */
export class PluginHost {
  constructor({ store, bus, rootDir, userDir }) {
    this.store = store; this.bus = bus; this.rootDir = rootDir; this.userDir = userDir;
    this.types = new Map();
    this.live = new Map(); // connectorId → { instance, status, error, tools, starting }
    this.loadErrors = [];
  }

  async loadTypes() {
    for (const p of BUILTINS) this.types.set(p.id, { ...p, builtin: true });
    if (!this.userDir || !fs.existsSync(this.userDir)) return;
    for (const dir of fs.readdirSync(this.userDir, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name.startsWith('_')) continue;
      const entry = ['index.js', 'index.mjs'].map((f) => path.join(this.userDir, dir.name, f)).find((f) => fs.existsSync(f));
      if (!entry) continue;
      try {
        const mod = await import(pathToFileURL(entry).href + `?v=${Date.now()}`);
        const p = mod.default || mod.plugin;
        validatePlugin(p, dir.name);
        if (this.types.has(p.id) && this.types.get(p.id).builtin) throw new Error(`id "${p.id}" clashes with a built-in plugin`);
        this.types.set(p.id, { ...p, builtin: false, source: `plugins/${dir.name}` });
      } catch (e) {
        this.loadErrors.push({ plugin: dir.name, error: e.message });
        console.warn(`[plugins] failed to load plugins/${dir.name}: ${e.message}`);
      }
    }
  }

  describeTypes() {
    return [...this.types.values()].map((p) => ({
      id: p.id, name: p.name, description: p.description, icon: p.icon || 'plug', category: p.category || 'connector',
      configFields: p.configFields || [], builtin: p.builtin, source: p.source,
    }));
  }

  // ------------------------------------------------------------------ connectors (CRUD)
  list() { return this.store.all('connectors'); }
  get(id) { return this.store.get('connectors', id); }

  publicConnector(c) {
    const type = this.types.get(c.pluginId);
    const cfg = { ...c.config };
    for (const f of type?.configFields || []) if (f.type === 'password' && cfg[f.key]) cfg[f.key] = mask(cfg[f.key]);
    const live = this.live.get(c.id);
    return {
      ...c, config: cfg, slug: this.slug(c),
      status: live?.status || (c.enabled === false ? 'disabled' : 'idle'),
      error: live?.error || null,
      tools: live?.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) || null,
      info: live?.instance?.info?.() || null,
      pluginName: type?.name || c.pluginId, icon: type?.icon, category: type?.category,
    };
  }

  slug(c) { return slugify(c.name, 20); }

  create({ pluginId, name, config = {}, enabled = true }) {
    const type = this.types.get(pluginId);
    if (!type) throw Object.assign(new Error(`Unknown plugin "${pluginId}"`), { status: 400 });
    const cfg = {};
    for (const f of type.configFields || []) if (f.default !== undefined) cfg[f.key] = f.default;
    Object.assign(cfg, config);
    const c = { id: newId('con'), pluginId, name: name || type.name, config: cfg, enabled, createdAt: now() };
    this.store.insert('connectors', c);
    this.bus.emitEvent('connector.created', { connector: this.publicConnector(c) });
    return c;
  }

  async update(id, patch) {
    const c = this.get(id);
    if (!c) return null;
    const type = this.types.get(c.pluginId);
    if (patch.config) {
      const merged = { ...c.config };
      for (const [k, v] of Object.entries(patch.config)) {
        const f = type?.configFields?.find((x) => x.key === k);
        if (f?.type === 'password' && typeof v === 'string' && v.includes('••••')) continue; // unchanged mask
        merged[k] = v;
      }
      c.config = merged;
    }
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    c.updatedAt = now();
    this.store.save('connectors');
    await this.stop(id);
    this.bus.emitEvent('connector.updated', { connector: this.publicConnector(c) });
    return c;
  }

  async remove(id) {
    await this.stop(id);
    const ok = this.store.remove('connectors', id);
    // detach from agents
    for (const a of this.store.all('agents')) {
      if (a.connectors?.includes(id)) { a.connectors = a.connectors.filter((x) => x !== id); this.store.save('agents'); }
    }
    if (ok) this.bus.emitEvent('connector.deleted', { id });
    return ok;
  }

  // ------------------------------------------------------------------ lifecycle
  setStatus(id, status, error = null) {
    const live = this.live.get(id) || {};
    live.status = status; live.error = error;
    this.live.set(id, live);
    const c = this.get(id);
    let info = null;
    try { info = live.instance?.info?.() || null; } catch {}
    if (c) this.bus.emitEvent('connector.status', { id, status, error, tools: live.tools?.map((t) => t.name) || null, info });
  }

  async ensure(id) {
    const c = this.get(id);
    if (!c) throw new Error(`Connector ${id} not found`);
    if (c.enabled === false) throw new Error(`Connector "${c.name}" is disabled`);
    const live = this.live.get(id);
    if (live?.instance && live.status === 'ready') return live;
    if (live?.starting) return live.starting;
    const type = this.types.get(c.pluginId);
    if (!type) throw new Error(`Plugin "${c.pluginId}" for connector "${c.name}" is not installed`);
    const entry = { status: 'starting', error: null };
    this.live.set(id, entry);
    this.setStatus(id, 'starting');
    entry.starting = (async () => {
      try {
        const instance = await withTimeout(type.create({ ...c.config }, {
          rootDir: this.rootDir,
          onStatus: (s, err) => { if (s === 'error') { entry.instance = null; this.setStatus(id, 'error', err); } },
          onToolsChanged: async () => { try { entry.tools = await instance.listTools(); this.setStatus(id, 'ready'); } catch {} },
        }), 45000, `Starting "${c.name}" timed out`);
        entry.instance = instance;
        entry.tools = await withTimeout(instance.listTools(), 30000, `Listing tools for "${c.name}" timed out`);
        entry.starting = null;
        this.setStatus(id, 'ready');
        return entry;
      } catch (e) {
        entry.starting = null; entry.instance = null;
        this.setStatus(id, 'error', e.message);
        throw new Error(`Connector "${c.name}" failed to start: ${e.message}`);
      }
    })();
    return entry.starting;
  }

  async stop(id) {
    const live = this.live.get(id);
    if (live?.instance) { try { await live.instance.close?.(); } catch {} }
    this.live.delete(id);
  }

  async stopAll() { await Promise.all([...this.live.keys()].map((id) => this.stop(id))); }

  async test(id) {
    await this.stop(id);
    const live = await this.ensure(id);
    const r = (await live.instance.test?.()) || { ok: true, message: 'Ready' };
    return { ...r, tools: live.tools };
  }

  async instance(id) { return (await this.ensure(id)).instance; }

  /** Tools for a set of connector ids, namespaced for the model. Failed connectors are reported, not fatal. */
  async toolsFor(ids = []) {
    const tools = [], problems = [];
    await Promise.all(ids.map(async (cid) => {
      const c = this.get(cid);
      if (!c || c.enabled === false) return;
      try {
        const live = await this.ensure(cid);
        for (const t of live.tools || []) {
          tools.push({
            name: toolName(this.slug(c), t.name), rawName: t.name, connectorId: cid, connectorName: c.name, pluginId: c.pluginId,
            description: `[${c.name}] ${t.description || ''}`.trim(), inputSchema: t.inputSchema,
          });
        }
      } catch (e) { problems.push({ connectorId: cid, name: c.name, error: e.message }); }
    }));
    return { tools, problems };
  }

  async callTool(connectorId, rawName, args, ctx = {}) {
    const inst = await this.instance(connectorId);
    const c = this.get(connectorId);
    const started = Date.now();
    this.bus.emitEvent('connector.call', { connectorId, connectorName: c?.name, pluginId: c?.pluginId, tool: rawName, agentId: ctx.agentId, taskId: ctx.taskId });
    try {
      const result = await inst.callTool(rawName, args || {}, ctx);
      this.bus.emitEvent('connector.result', { connectorId, tool: rawName, ok: true, ms: Date.now() - started, preview: truncate(result, 200), agentId: ctx.agentId });
      return result;
    } catch (e) {
      this.bus.emitEvent('connector.result', { connectorId, tool: rawName, ok: false, ms: Date.now() - started, error: e.message, agentId: ctx.agentId });
      throw e;
    }
  }

  async startEnabled() {
    await Promise.allSettled(this.list().filter((c) => c.enabled !== false).map((c) => this.ensure(c.id)));
  }
}

function validatePlugin(p, name) {
  if (!p || typeof p !== 'object') throw new Error(`plugins/${name} must default-export a plugin object`);
  if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error('plugin.id must be lowercase letters, numbers, dashes');
  if (!p.name) throw new Error('plugin.name is required');
  if (typeof p.create !== 'function') throw new Error('plugin.create(config, ctx) is required');
}

function withTimeout(promise, ms, msg) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
