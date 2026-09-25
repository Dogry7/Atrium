import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { startApp, httpServer, waitFor, tmpDir, ROOT } from '../helpers.js';
import { McpClient } from '../../server/mcp/client.js';
import { layaMock } from '../fixtures/laya-mock.js';

const EVERYTHING = path.join(ROOT, 'node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

describe('MCP against the official reference server (server-everything)', { skip: !fs.existsSync(EVERYTHING) && 'run npm install first' }, () => {
  test('stdio: initialize, list tools, call echo / get-sum, handle tool errors', async () => {
    const c = new McpClient({ transport: 'stdio', command: process.execPath, args: [EVERYTHING, 'stdio'] });
    const init = await c.connect();
    assert.ok(init.serverInfo.name);
    const tools = await c.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('echo'), names.join());
    const echo = await c.callTool('echo', { message: 'hi from Atrium' });
    assert.match(echo.content[0].text, /hi from Atrium/);
    const sumTool = names.find((n) => /^(get-sum|add)$/.test(n));
    const sum = await c.callTool(sumTool, { a: 2, b: 40 });
    assert.match(sum.content[0].text, /42/);
    const bad = await c.callTool('echo', {}).then((r) => r, (e) => e);
    assert.ok(bad.isError || bad instanceof Error, 'invalid args rejected');
    await c.close();
  });

  for (const [transport, script, pathSuffix] of [['http', 'streamableHttp', '/mcp'], ['sse', 'sse', '/sse']]) {
    test(`${transport === 'http' ? 'Streamable HTTP' : 'legacy HTTP+SSE'} transport`, async () => {
      const port = await freePort();
      const proc = spawn(process.execPath, [EVERYTHING, script], { env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
      try {
        await waitFor(() => fetch(`http://127.0.0.1:${port}${pathSuffix}`, { method: 'GET', headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(300) }).then(() => true, (e) => e.name === 'TimeoutError' || e.name === 'AbortError'), { timeout: 15000, message: 'MCP HTTP server' });
        const c = new McpClient({ transport, url: `http://127.0.0.1:${port}${pathSuffix}` });
        await c.connect();
        const tools = await c.listTools();
        assert.ok(tools.find((t) => t.name === 'echo'));
        const r = await c.callTool('echo', { message: `via ${transport}` });
        assert.match(r.content[0].text, new RegExp(`via ${transport}`));
        await c.close();
      } finally { proc.kill(); }
    });
  }

  test('as a connector: test, tool allow-list, direct tool call, and an agent using it', async () => {
    const t = await startApp();
    try {
      const con = (await t.post('/api/connectors', { pluginId: 'mcp', name: 'Everything', config: { transport: 'stdio', command: process.execPath, args: `"${EVERYTHING}" stdio`, toolFilter: 'echo' } })).body;
      assert.equal(con.status, 'idle');
      const r = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(r.ok, true, r.message);
      assert.match(r.message, /1 tool$/);
      assert.deepEqual(r.tools.map((x) => x.name), ['echo']);
      const call = (await t.post(`/api/connectors/${con.id}/tools/echo`, { args: { message: 'direct' } })).body;
      assert.equal(call.ok, true);
      assert.match(call.result, /direct/);
      await t.patch(`/api/agents/${t.agent('Atlas').id}`, { connectors: [con.id] });
      const chat = (await t.post('/api/agents/Atlas/chat', { message: 'use echo tool with hello world', wait: true })).body;
      assert.match(chat.reply, /Result from `echo`/);
      assert.match(chat.reply, /hello world/);
      const task = t.app.store.get('tasks', chat.taskId);
      assert.equal(task.steps[0].tool, 'everything__echo');
      assert.equal(task.steps[0].connectorName, 'Everything');
    } finally { await t.close(); }
  });

  test('a broken MCP command fails clearly, and the agent still answers', async () => {
    const t = await startApp();
    try {
      const con = (await t.post('/api/connectors', { pluginId: 'mcp', name: 'Broken', config: { transport: 'stdio', command: 'definitely-not-a-real-command-xyz' } })).body;
      const r = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(r.ok, false);
      assert.match(r.message, /Command not found: "definitely-not-a-real-command-xyz"/);
      assert.equal(r.connector.status, 'error');
      await t.patch(`/api/agents/${t.agent('Quill').id}`, { connectors: [con.id] });
      const chat = (await t.post('/api/agents/Quill/chat', { message: 'hello', wait: true })).body;
      assert.equal(chat.status.state, 'completed');
      assert.ok(t.app.bus.recent(50).some((e) => e.type === 'agent.warning' && /Broken unavailable/.test(e.message)));
    } finally { await t.close(); }
  });
});

describe('Web & HTTP connector', () => {
  let t, site, con;
  before(async () => {
    site = await httpServer(async (req, res, body) => {
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Atrium Docs</title><script>x()</script></head><body><h1>Welcome</h1><p>Agents &amp; tools.</p></body></html>'); }
      if (req.url === '/api') { res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ got: body, auth: req.headers.authorization || null, method: req.method })); }
      if (req.url === '/slow') { await new Promise((r) => setTimeout(r, 1500)); res.end('late'); return; }
      res.writeHead(404); res.end('nope');
    });
    t = await startApp();
    con = t.app.store.all('connectors').find((c) => c.pluginId === 'web');
  });
  after(async () => { await t.close(); await site.close(); });

  test('web_fetch returns readable text with title', async () => {
    const r = (await t.post(`/api/connectors/${con.id}/tools/web_fetch`, { args: { url: `${site.url}/page` } })).body;
    assert.equal(r.ok, true);
    assert.match(r.result, /Title: Atrium Docs/);
    assert.match(r.result, /# Welcome/);
    assert.match(r.result, /Agents & tools\./);
    assert.doesNotMatch(r.result, /x\(\)/);
  });

  test('http_request sends JSON + default headers and parses JSON responses', async () => {
    await t.patch(`/api/connectors/${con.id}`, { config: { defaultHeaders: '{"Authorization":"Bearer abc"}' } });
    const r = (await t.post(`/api/connectors/${con.id}/tools/http_request`, { args: { method: 'POST', url: `${site.url}/api`, body: { hello: 'world' } } })).body;
    assert.equal(r.result.status, 201);
    assert.deepEqual(r.result.body, { got: { hello: 'world' }, auth: 'Bearer abc', method: 'POST' });
  });

  test('allowed domains, bad URLs and timeouts', async () => {
    await t.patch(`/api/connectors/${con.id}`, { config: { allowedDomains: 'example.com', timeoutMs: 400 } });
    let r = (await t.post(`/api/connectors/${con.id}/tools/web_fetch`, { args: { url: `${site.url}/page` } })).body;
    assert.equal(r.ok, false);
    assert.match(r.error, /127\.0\.0\.1 is not in this connector's allowed domains/);
    r = (await t.post(`/api/connectors/${con.id}/tools/web_fetch`, { args: { url: 'file:///etc/passwd' } })).body;
    assert.match(r.error, /Only http\(s\)|not in this connector/);
    await t.patch(`/api/connectors/${con.id}`, { config: { allowedDomains: '' } });
    r = (await t.post(`/api/connectors/${con.id}/tools/web_fetch`, { args: { url: `${site.url}/slow` } })).body;
    assert.match(r.error, /timed out after 0.4s/);
  });

  test('an agent follows a URL in the chat with web_fetch', async () => {
    await t.patch(`/api/connectors/${con.id}`, { config: { timeoutMs: 20000 } });
    const r = (await t.post('/api/agents/Atlas/chat', { message: `Summarise ${site.url}/page for me`, wait: true })).body;
    assert.match(r.reply, /Atrium Docs/);
  });
});

describe('Plugin system', () => {
  test('drop-in plugins load; broken ones are reported, not fatal; reload picks up new ones', async () => {
    const dir = tmpDir('atrium-plugins-');
    fs.cpSync(path.join(ROOT, 'plugins/example-toolkit'), path.join(dir, 'example-toolkit'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken/index.js'), 'export default { id: "Bad Id!", name: "x" }');
    fs.mkdirSync(path.join(dir, 'clash'));
    fs.writeFileSync(path.join(dir, 'clash/index.js'), 'export default { id: "web", name: "fake web", create() {} }');
    const t = await startApp({ pluginDir: dir });
    try {
      const p = (await t.get('/api/plugins')).body;
      assert.ok(p.types.find((x) => x.id === 'example-toolkit' && !x.builtin));
      assert.deepEqual(p.errors.map((e) => e.plugin).sort(), ['broken', 'clash']);
      // hot add a plugin
      fs.mkdirSync(path.join(dir, 'greeter'));
      fs.writeFileSync(path.join(dir, 'greeter/index.js'), `export default { id: 'greeter', name: 'Greeter', description: 'says hi', configFields: [{ key: 'greeting', label: 'Greeting', type: 'text', default: 'G\\'day' }],
        async create(cfg) { return { async listTools() { return [{ name: 'greet', description: 'greet someone', inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] } }]; },
          async callTool(n, a) { return cfg.greeting + ', ' + a.who + '!'; } }; } };`);
      const re = (await t.post('/api/plugins/reload')).body;
      assert.ok(re.types.find((x) => x.id === 'greeter'));
      const con = (await t.post('/api/connectors', { pluginId: 'greeter', name: 'Greeter' })).body;
      assert.equal(con.config.greeting, "G'day", 'defaults applied');
      const r = (await t.post(`/api/connectors/${con.id}/tools/greet`, { args: { who: 'Ryan' } })).body;
      assert.equal(r.result, "G'day, Ryan!");
      const kit = (await t.post('/api/connectors', { pluginId: 'example-toolkit', name: 'Kit' })).body;
      const calc = (await t.post(`/api/connectors/${kit.id}/tools/calculate`, { args: { expression: '(12.5 * 4) / 2' } })).body;
      assert.equal(calc.result, '(12.5 * 4) / 2 = 25');
      const inj = (await t.post(`/api/connectors/${kit.id}/tools/calculate`, { args: { expression: 'process.exit()' } })).body;
      assert.equal(inj.ok, false, 'no code injection through calculate');
      assert.equal((await t.post('/api/connectors', { pluginId: 'nope' })).status, 400);
    } finally { await t.close(); }
  });

  test('connector secrets are masked and survive edits; deleting detaches from agents', async () => {
    const t = await startApp();
    try {
      const con = (await t.post('/api/connectors', { pluginId: 'laya', name: 'Laya', config: { apiKey: 'laya-secret-key-999' } })).body;
      assert.equal(con.config.apiKey, 'laya••••-999');
      await t.patch(`/api/connectors/${con.id}`, { name: 'Laya 2', config: { apiKey: con.config.apiKey, threshold: 0.8 } });
      assert.equal(t.app.plugins.get(con.id).config.apiKey, 'laya-secret-key-999');
      assert.equal(t.app.plugins.get(con.id).config.threshold, 0.8);
      await t.patch(`/api/agents/${t.agent('Nova').id}`, { connectors: [con.id] });
      await t.del(`/api/connectors/${con.id}`);
      assert.deepEqual(t.agent('Nova').connectors, []);
    } finally { await t.close(); }
  });
});

const hasPythonLaya = spawnSync('python3', ['-c', 'import laya.serve, fastapi, uvicorn'], { stdio: 'ignore' }).status === 0;

describe('Laya connector', () => {
  test('against a wire-compatible laya-serve mock: health, decide, auth', async () => {
    const laya = await layaMock({ apiKey: 'lk' });
    const t = await startApp();
    try {
      const con = (await t.post('/api/connectors', { pluginId: 'laya', name: 'Laya', config: { baseUrl: laya.url, apiKey: 'lk', model: 'multilingual', threshold: 0.5 } })).body;
      const r = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(r.ok, true, r.message);
      assert.match(r.message, /laya-serve is up/);
      const d = (await t.post(`/api/connectors/${con.id}/tools/laya_decide`, { args: { text: 'I was charged twice on my invoice, please refund', question: 'Which team?', type: 'choice', options: { billing: 'invoices, payments, refunds', technical: 'bugs, outages' } } })).body;
      assert.equal(d.ok, true, d.error);
      assert.equal(d.result.answer, 'billing');
      assert.ok(d.result.confidence > 0.5);
      assert.equal(d.result.escalate, false);
      assert.equal(laya.calls[0].model, 'multilingual');
      assert.equal(laya.calls[0].questions.decision.criteria.billing, 'invoices, payments, refunds');
      await t.patch(`/api/connectors/${con.id}`, { config: { apiKey: 'wrong' } });
      const bad = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(bad.ok, false);
      assert.match(bad.message, /Laya 401/);
    } finally { await t.close(); await laya.close(); }
  });

  test('unreachable laya-serve gives an actionable message', async () => {
    const t = await startApp();
    try {
      const con = (await t.post('/api/connectors', { pluginId: 'laya', name: 'Laya', config: { baseUrl: 'http://127.0.0.1:9' } })).body;
      const r = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(r.ok, false);
      assert.match(r.message, /Can't reach laya-serve at http:\/\/127\.0\.0\.1:9.*Start it with: laya-serve/);
    } finally { await t.close(); }
  });

  test('against the REAL laya.serve app (stub model weights)', { skip: !hasPythonLaya && 'python3 with laya + fastapi + uvicorn not installed' }, async () => {
    const port = await freePort();
    const proc = spawn('python3', [path.join(ROOT, 'test/fixtures/laya_stub_serve.py'), String(port)], { env: { ...process.env, LAYA_API_KEY: 'real-key' }, stdio: 'pipe' });
    let err = ''; proc.stderr.on('data', (d) => { err += d; });
    const t = await startApp();
    try {
      await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status === 401 || r.ok, () => false), { timeout: 20000, message: `laya-serve to start ${err}` });
      const con = (await t.post('/api/connectors', { pluginId: 'laya', name: 'Laya', config: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'real-key' } })).body;
      const h = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.equal(h.ok, true, h.message);
      assert.match(h.message, /loaded: english/);
      const inst = await t.app.plugins.instance(con.id);
      const d = await inst.decide({ text: 'The app crashes with an error when I log in', question: 'Which team?', type: 'choice', options: [{ label: 'billing', description: 'invoices refunds payments' }, { label: 'technical', description: 'bugs errors crashes login' }] });
      assert.equal(d.answer, 'technical');
      assert.equal(d.model, 'english');
      // server-side validation errors from real laya.serve surface cleanly
      const bad = await inst.predict('x', { q: { type: 'weird' } }).catch((e) => e);
      assert.match(bad.message, /Laya 422: question 'q': unknown type 'weird'/);
      await t.patch(`/api/connectors/${con.id}`, { config: { apiKey: 'nope' } });
      const unauth = (await t.post(`/api/connectors/${con.id}/test`)).body;
      assert.match(unauth.message, /401: invalid or missing bearer token/);
    } finally { await t.close(); proc.kill(); }
  });
});
