import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, waitFor, recordEvents, tmpDir } from '../helpers.js';

describe('REST API: first run, agents, chat, settings', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('first run seeds a team, two workflows and a web connector', async () => {
    const { status, body } = await t.get('/api/state');
    assert.equal(status, 200);
    assert.deepEqual(body.agents.map((a) => a.name), ['Nova', 'Atlas', 'Quill', 'Sentinel']);
    assert.equal(body.workflows.length, 2);
    assert.equal(body.connectors[0].pluginId, 'web');
    assert.ok(body.pluginTypes.find((p) => p.id === 'example-toolkit'), 'drop-in plugin loaded');
    assert.equal(body.settings.defaultProvider, process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulated');
    assert.equal((await t.get('/api/health')).body.ok, true);
  });

  test('create agent: validation, defaults, uniqueness', async () => {
    assert.equal((await t.post('/api/agents', { name: '  ' })).status, 400);
    assert.equal((await t.post('/api/agents', { name: 'x'.repeat(41) })).status, 400);
    assert.equal((await t.post('/api/agents', { name: 'nova' })).status, 409, 'names are case-insensitively unique');
    assert.equal((await t.post('/api/agents', { name: 'Bad', provider: 'nope' })).status, 400);
    const r = await t.post('/api/agents', { name: 'Pixel', role: 'Designer', instructions: 'Make things pretty', connectors: ['con_missing'], maxSteps: 99, avatar: { color: '#FF7A59', hair: 'bun' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'Pixel');
    assert.equal(r.body.provider, 'simulated');
    assert.deepEqual(r.body.connectors, [], 'unknown connectors dropped');
    assert.equal(r.body.maxSteps, 30, 'clamped');
    assert.equal(r.body.a2a.enabled, true);
    assert.equal(r.body.avatar.hair, 'bun');
  });

  test('get agent by id or name; patch; 404s', async () => {
    const a = (await t.get('/api/agents/pixel')).body;
    assert.equal(a.name, 'Pixel');
    assert.match(a.card, /\/a2a\/agt_.*agent-card\.json/);
    const p = await t.patch(`/api/agents/${a.id}`, { role: 'Brand designer', avatar: { accessory: 'glasses' } });
    assert.equal(p.body.role, 'Brand designer');
    assert.equal(p.body.avatar.hair, 'bun', 'avatar patch merges');
    assert.equal(p.body.avatar.accessory, 'glasses');
    assert.equal((await t.patch(`/api/agents/${a.id}`, { name: 'Atlas' })).status, 409);
    assert.equal((await t.get('/api/agents/nobody')).status, 404);
    assert.equal((await t.post('/api/agents/nobody/chat', { message: 'hi' })).status, 404);
  });

  test('chat (wait) returns a reply, records a task and a thread', async () => {
    assert.equal((await t.post('/api/agents/Quill/chat', { message: '   ' })).status, 400);
    const r = await t.post('/api/agents/Quill/chat', { message: 'Write a short welcome email for new customers', wait: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.status.state, 'completed');
    assert.match(r.body.reply, /first draft on \*\*welcome email for new customers\*\*/i);
    const th = await t.get(`/api/agents/${t.agent('Quill').id}/thread`);
    assert.equal(th.body.turns.length, 1);
    assert.equal(th.body.turns[0].input, 'Write a short welcome email for new customers');
    // second message continues the same thread (model sees history)
    await t.post('/api/agents/Quill/chat', { message: 'Make it punchier', wait: true });
    const thread = t.app.store.get('threads', `${t.agent('Quill').id}::chat`);
    assert.equal(thread.messages.filter((m) => m.role === 'user').length, 2);
    // new conversation clears the model context and hides old turns
    await t.del(`/api/agents/${t.agent('Quill').id}/thread`);
    assert.equal((await t.get(`/api/agents/${t.agent('Quill').id}/thread`)).body.turns.length, 0);
    assert.equal(t.app.store.get('threads', `${t.agent('Quill').id}::chat`), undefined);
  });

  test('async chat streams events: task → deltas → reply', async () => {
    const rec = recordEvents(t.app);
    const r = await t.post('/api/agents/Atlas/chat', { message: 'Research the pros and cons of remote work' });
    assert.equal(r.status, 202);
    await waitFor(() => rec.of('agent.reply').find((e) => e.taskId === r.body.taskId), { message: 'reply event' });
    rec.stop();
    const types = rec.events.filter((e) => e.taskId === r.body.taskId || e.task?.id === r.body.taskId).map((e) => e.type);
    assert.equal(types[0], 'task.created');
    assert.ok(types.includes('agent.thinking'));
    assert.ok(types.filter((x) => x === 'agent.delta').length > 1, 'streamed in several deltas');
    assert.ok(types.indexOf('agent.reply') > types.indexOf('agent.delta'));
    assert.ok(rec.of('agent.status').some((e) => e.agentId === t.agent('Atlas').id && e.state === 'working'));
  });

  test('memory: remember, recall across conversations, forget', async () => {
    await t.post('/api/agents/Sentinel/chat', { message: 'Remember that our brand colour is teal', wait: true });
    const mems = (await t.get(`/api/agents/${t.agent('Sentinel').id}/memories`)).body;
    assert.equal(mems.length, 1);
    assert.equal(mems[0].text, 'our brand colour is teal');
    // memory appears in the system prompt for new conversations
    const sys = t.app.runtime.systemPrompt(t.agent('Sentinel'), { from: { type: 'user' } });
    assert.match(sys, /our brand colour is teal/);
    const r = await t.post('/api/agents/Sentinel/chat', { message: 'What do you remember?', contextId: 'other', wait: true });
    assert.match(r.body.reply, /brand colour is teal/);
    await t.del(`/api/agents/${t.agent('Sentinel').id}/memories/${mems[0].id}`);
    assert.equal((await t.get(`/api/agents/${t.agent('Sentinel').id}/memories`)).body.length, 0);
  });

  test('settings: secrets are masked and masked values never overwrite', async () => {
    await t.patch('/api/settings', { userName: 'Ryan', providers: { anthropic: { apiKey: 'sk-ant-secret-123456789' } }, a2a: { token: 'tok-abcdefgh1234' } });
    const s = (await t.get('/api/settings')).body;
    assert.equal(s.userName, 'Ryan');
    assert.equal(s.providers.anthropic.apiKey, 'sk-a••••6789');
    assert.equal(s.a2a.token, 'tok-••••1234');
    await t.patch('/api/settings', { providers: { anthropic: { apiKey: s.providers.anthropic.apiKey } } });
    assert.equal(t.app.settings().providers.anthropic.apiKey, 'sk-ant-secret-123456789');
    const prov = (await t.get('/api/providers')).body.find((p) => p.id === 'anthropic');
    assert.equal(prov.configured, true);
    // the agent now knows the user's name
    assert.match(t.app.runtime.systemPrompt(t.agent('Nova'), { from: { type: 'user' } }), /talking with Ryan/);
    await t.patch('/api/settings', { a2a: { token: '' } });
  });

  test('settings: the colony defaults to Terra / live time, can change planet, and rejects nonsense', async () => {
    const w0 = (await t.get('/api/settings')).body.world;
    assert.deepEqual({ planet: w0.planet, time: w0.time, quality: w0.quality }, { planet: 'terra', time: 'live', quality: 'auto' });
    const events = recordEvents(t.app);
    const r = await t.patch('/api/settings', { world: { planet: 'mars', time: 'night' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.world.planet, 'mars');
    assert.equal(r.body.settings.world.time, 'night');
    assert.equal(r.body.settings.world.showNames, true, 'deep merge keeps the other world settings');
    await waitFor(() => events.of('settings.updated').length > 0, { message: 'settings.updated event' });
    events.stop();
    for (const [body, msg] of [[{ world: { planet: 'pluto' } }, /Unknown planet "pluto".*terra, mars, luna/], [{ world: { time: 'noonish' } }, /time must be one of/], [{ world: { quality: 'ultra' } }, /quality must be one of/], [{ theme: 'purple' }, /theme must be/]]) {
      const bad = await t.patch('/api/settings', body);
      assert.equal(bad.status, 400); assert.match(bad.body.error, msg);
    }
    assert.equal(t.app.settings().world.planet, 'mars', 'a rejected patch changes nothing');
    await t.patch('/api/settings', { world: { planet: 'terra', time: 'live' } });
  });

  test('plots: every agent gets its own plot, gaps are reused, and the reply event carries the new task count', async () => {
    const plots = t.app.store.all('agents').map((a) => a.plot);
    assert.equal(new Set(plots).size, plots.length, `unique plots: ${plots}`);
    const a = (await t.post('/api/agents', { name: 'Plotter', role: 'Test' })).body;
    let free = 0; while (plots.includes(free)) free++;
    assert.equal(a.plot, free, 'the first free plot');
    const b = (await t.post('/api/agents', { name: 'Plotter Two', role: 'Test' })).body;
    assert.equal(b.plot, a.plot + 1);
    await t.del(`/api/agents/${a.id}`);
    const c = (await t.post('/api/agents', { name: 'Plotter Three', role: 'Test' })).body;
    assert.equal(c.plot, a.plot, 'the freed plot is reused');
    assert.equal((await t.patch(`/api/agents/${c.id}`, { plot: 0 })).body.plot, c.plot, 'plots can\'t be changed by a PATCH');
    const events = recordEvents(t.app);
    await t.post('/api/agents/Plotter Three/chat', { message: 'hello', wait: true });
    const reply = events.of('agent.reply').find((e) => e.agentId === c.id);
    events.stop();
    assert.equal(reply.stats.tasks, 1);
    assert.ok(Date.parse(reply.stats.lastActiveAt) > Date.now() - 60000);
    assert.equal(t.agent('Plotter Three').stats.tasks, 1);
    for (const x of [b, c]) await t.del(`/api/agents/${x.id}`);
  });

  test('deleting an agent removes its threads, memories and allow-list references', async () => {
    const pixel = t.agent('Pixel');
    await t.patch(`/api/agents/${t.agent('Nova').id}`, { a2a: { enabled: true, allow: [pixel.id, t.agent('Atlas').id] } });
    await t.post('/api/agents/Pixel/chat', { message: 'remember that I like purple', wait: true });
    const del = await t.del(`/api/agents/${pixel.id}`);
    assert.equal(del.body.ok, true);
    assert.equal(t.agent('Pixel'), undefined);
    assert.equal(t.app.store.all('memories').filter((m) => m.agentId === pixel.id).length, 0);
    assert.deepEqual(t.agent('Nova').a2a.allow, [t.agent('Atlas').id]);
    await t.patch(`/api/agents/${t.agent('Nova').id}`, { a2a: { enabled: true, allow: 'all' } });
  });

  test('unknown API routes 404, wrong method 405, SPA fallback serves the app', async () => {
    assert.equal((await t.get('/api/nope')).status, 404);
    assert.equal((await t.del('/api/state')).status, 405);
    const html = await fetch(t.base + '/workflows/whatever');
    assert.match(await html.text(), /<div id="root">/);
    const js = await fetch(t.base + '/js/app.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(t.base + '/../package.json')).status, 404);
  });

  test('export → import round-trip into a fresh instance', async () => {
    const exp = (await t.get('/api/export')).body;
    assert.ok(exp.agents.length >= 4);
    const t2 = await startApp({ seedData: false });
    try {
      const r = await t2.post('/api/import', exp);
      assert.equal(r.body.counts.agents, exp.agents.length);
      assert.deepEqual((await t2.get('/api/agents')).body.map((a) => a.name), exp.agents.map((a) => a.name));
      assert.equal((await t2.get('/api/workflows')).body.length, exp.workflows.length);
    } finally { await t2.close(); }
  });
});

describe('persistence and live events', () => {
  test('data survives a restart (atomic JSON files)', async () => {
    const dir = tmpDir();
    const a = await startApp({ dataDir: dir });
    await a.post('/api/agents', { name: 'Keeper', role: 'Archivist' });
    await a.post('/api/agents/Keeper/chat', { message: 'hello', wait: true });
    await a.close();
    assert.ok(fs.existsSync(path.join(dir, 'agents.json')));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
    const b = await startApp({ dataDir: dir });
    try {
      assert.ok(b.agent('Keeper'));
      assert.equal(b.app.store.all('agents').length, 5, 'not re-seeded');
      assert.equal(b.app.store.all('tasks').length, 1);
    } finally { await b.close(); }
  });

  test('older data: settings get the colony defaults, and agents without plots are given unique ones', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ userName: 'Ryan', theme: 'light', defaultProvider: 'simulated', defaultModel: '', providers: { anthropic: { apiKey: '', baseUrl: '' }, openai: { apiKey: '', baseUrl: '' } }, a2a: { enabled: true, token: '', publicUrl: '', frontDeskAgentId: '' }, world: { showNames: false, ambient: true, theme: 'robotcity' } }));
    const old = (id, name, plot) => ({ id, name, role: 'Old', instructions: '', provider: 'simulated', model: '', connectors: [], a2a: { enabled: true, allow: 'all' }, memory: { enabled: true }, avatar: { color: '#7C5CFF', hair: 'short', accessory: 'none' }, stats: { tasks: 3, tokensIn: 0, tokensOut: 0 }, ...(plot !== undefined ? { plot } : {}) });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([old('agt_a', 'Ada'), old('agt_b', 'Bea', 0), old('agt_c', 'Cy'), old('agt_d', 'Dot', 0)]));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ seeded: true }));
    const a = await startApp({ dataDir: dir });
    try {
      const s = (await a.get('/api/settings')).body;
      assert.equal(s.world.planet, 'terra'); assert.equal(s.world.time, 'live'); assert.equal(s.world.showNames, false);
      assert.equal(s.world.theme, undefined, 'the old 2D world setting is gone');
      assert.equal(s.userName, 'Ryan'); assert.equal(s.theme, 'light');
      const plots = Object.fromEntries((await a.get('/api/state')).body.agents.map((x) => [x.name, x.plot]));
      assert.equal(plots.Bea, 0, 'an existing plot is kept');
      assert.deepEqual(Object.values(plots).sort(), [0, 1, 2, 3], `unique plots: ${JSON.stringify(plots)}`);
      await a.patch('/api/settings', { world: { planet: 'luna' } });
    } finally { await a.close(); }
    const b = await startApp({ dataDir: dir });
    try { assert.equal((await b.get('/api/settings')).body.world.planet, 'luna', 'the chosen planet survives a restart'); } finally { await b.close(); }
  });

  test('importing agents that clash with existing plots moves them to free ones', async () => {
    const a = await startApp();
    try {
      const nova = a.agent('Nova');
      const r = await a.post('/api/import', { agents: [{ ...nova, id: 'agt_imported', name: 'Nova Two', plot: nova.plot }] });
      assert.equal(r.status, 200);
      const plots = (await a.get('/api/state')).body.agents.map((x) => x.plot);
      assert.equal(new Set(plots).size, plots.length, `unique after import: ${plots}`);
    } finally { await a.close(); }
  });

  test('a corrupt data file is backed up and the app still starts', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'agents.json'), '{ this is not json');
    const b = await startApp({ dataDir: dir, seedData: false });
    try {
      assert.equal((await b.get('/api/agents')).body.length, 0);
      assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('agents.json.corrupt-')));
    } finally { await b.close(); }
  });

  test('SSE stream delivers events and replays missed ones via Last-Event-ID', async () => {
    const t = await startApp();
    try {
      const ctrl = new AbortController();
      const res = await fetch(t.base + '/api/events', { signal: ctrl.signal });
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const reader = res.body.getReader();
      let buf = '';
      const chat = t.post('/api/agents/Nova/chat', { message: 'hello', wait: true });
      while (!buf.includes('"agent.reply"')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); }
      await chat;
      ctrl.abort();
      const ids = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]);
      assert.ok(ids.length > 3);
      // reconnect as if we'd missed everything after the first event
      const ctrl2 = new AbortController();
      const res2 = await fetch(t.base + '/api/events', { headers: { 'last-event-id': String(ids[0]) }, signal: ctrl2.signal });
      const r2 = res2.body.getReader();
      let buf2 = '';
      while (!buf2.includes('"agent.reply"')) { const { value } = await r2.read(); buf2 += new TextDecoder().decode(value); }
      ctrl2.abort();
      assert.ok(buf2.includes(`id: ${ids[1]}`), 'missed events replayed');
    } finally { await t.close(); }
  });
});
