import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Bus } from './bus.js';
import { Router, sendJson, serveStatic } from './http.js';
import { PluginHost } from './plugins/host.js';
import { AgentRuntime, assignPlots } from './runtime/agents.js';
import { WorkflowEngine } from './workflows/engine.js';
import { mountApi } from './api.js';
import { mountA2A } from './a2a/server.js';
import { seed } from './seed.js';
import { HttpError } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const DEFAULT_SETTINGS = {
  userName: 'You',
  theme: 'dark',
  defaultProvider: '',
  defaultModel: '',
  providers: { anthropic: { apiKey: '', baseUrl: '' }, openai: { apiKey: '', baseUrl: '' } },
  a2a: { enabled: true, token: '', publicUrl: '', frontDeskAgentId: '' },
  world: { showNames: true, ambient: true, planet: 'terra', time: 'live', quality: 'auto' },
};

/**
 * Build an Atrium instance. Tests create several of these on random ports.
 */
export async function createApp({ dataDir = path.join(ROOT, 'data'), port = 4317, host = '127.0.0.1', pluginDir = path.join(ROOT, 'plugins'), seedData = true, quiet = false } = {}) {
  const store = new Store(dataDir);
  const bus = new Bus();
  const settings = () => {
    const s = store.doc('settings', null);
    if (!s) return store.setDoc('settings', structuredClone(DEFAULT_SETTINGS));
    // fill in new defaults for older files
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (s[k] === undefined) s[k] = structuredClone(v);
    // new world keys for older files (a nested merge: keep what's there)
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS.world)) if (s.world[k] === undefined) s.world[k] = v;
    delete s.world.theme;
    return s;
  };
  const s = settings();
  if (!s.defaultProvider) {
    s.defaultProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'simulated';
    store.setDoc('settings', s);
  }

  const plugins = new PluginHost({ store, bus, rootDir: ROOT, userDir: pluginDir });
  await plugins.loadTypes();
  const runtime = new AgentRuntime({ store, bus, plugins, settings });
  const engine = new WorkflowEngine({ store, bus, runtime, plugins });
  if (seedData) seed(store, { provider: s.defaultProvider === 'anthropic' ? 'anthropic' : 'simulated', model: s.defaultProvider === 'anthropic' ? 'claude-sonnet-5' : '' });
  assignPlots(store); // every agent owns a plot in the colony

  const app = { store, bus, plugins, runtime, engine, settings, version: VERSION, root: ROOT };
  const router = new Router();
  mountApi(router, app);
  mountA2A(router, { runtime, store, settings });

  // Server-Sent Events: the UI's live feed
  const clients = new Set();
  router.get('/api/events', (req, res, { query }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    const since = Number(req.headers['last-event-id'] || query.get('since') || 0);
    if (since) for (const e of bus.since(since)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    const write = (chunk) => { if (!res.writableEnded && !res.destroyed) res.write(chunk); };
    const onEvent = (e) => write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    bus.on('event', onEvent);
    const ping = setInterval(() => write(': ping\n\n'), 20000);
    const cleanup = () => { bus.off('event', onEvent); clearInterval(ping); clients.delete(client); };
    const client = { res, cleanup };
    clients.add(client);
    req.on('close', cleanup);
  });

  const webRoot = path.join(ROOT, 'web');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,a2a-version,x-atrium-token' });
      return res.end();
    }
    const m = router.match(req.method, url.pathname);
    if (m) {
      try { await m.handler(req, res, { params: m.params, query: url.searchParams, url }); }
      catch (e) {
        const status = e.status || (e instanceof HttpError ? e.status : 500);
        if (status >= 500 && !quiet) console.error(`[api] ${req.method} ${url.pathname}:`, e);
        if (!res.headersSent) sendJson(res, status, { error: e.message, details: e.details });
        else res.end();
      }
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/a2a/')) {
      return sendJson(res, router.allowed(url.pathname) ? 405 : 404, { error: router.allowed(url.pathname) ? 'Method not allowed' : 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res, webRoot, url.pathname);
  });
  server.keepAliveTimeout = 65000;

  // Scheduler: run workflows with a schedule trigger
  const tick = () => {
    for (const wf of store.all('workflows')) {
      const sch = wf.trigger?.schedule;
      if (!sch?.enabled || !(Number(sch.everyMinutes) > 0)) continue;
      const last = wf.lastScheduledAt ? Date.parse(wf.lastScheduledAt) : 0;
      if (Date.now() - last >= Number(sch.everyMinutes) * 60000) {
        wf.lastScheduledAt = new Date().toISOString();
        store.save('workflows');
        try { engine.start(wf.id, { input: sch.input || '', trigger: 'schedule' }).done.catch(() => {}); }
        catch (e) { bus.emitEvent('run.error', { workflowId: wf.id, error: e.message }); }
      }
    }
  };
  app.tick = tick;
  const scheduler = setInterval(tick, 15000);
  scheduler.unref();

  // Warm up enabled connectors in the background (errors are shown in the UI, not fatal)
  plugins.startEnabled().catch(() => {});

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  app.port = addr.port;
  app.url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}`;
  app.server = server;
  app.close = async () => {
    clearInterval(scheduler);
    for (const c of [...clients]) { c.cleanup(); c.res.end(); }
    for (const tid of runtime.active.keys()) runtime.cancel(tid);
    for (const rid of engine.active.keys()) engine.cancel(rid);
    await plugins.stopAll();
    store.flush();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  };
  return app;
}
