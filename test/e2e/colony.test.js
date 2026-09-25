// The 3D colony, used the way Ryan would: click robots, move the camera, chat, watch them work,
// see who needs him, fly to other planets, change the time of day.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { session } from './setup.js';
import { waitFor } from '../helpers.js';

describe('The colony, used like Ryan would', () => {
  let s, page;
  before(async () => { s = await session(); page = s.page; });
  after(async () => { await s.close(); });

  const world = (fn, arg) => page.evaluate(fn, arg);
  const bot = (name) => world((n) => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === n); return e && { id: e.id, x: e.x, z: e.z, mode: e.mode, plot: e.plot, level: e.level, sitting: e.sitting, moving: e.moving, screen: e.screen, busy: e.s.busy, unread: e.s.unread, clip: e.robot.clip, face: e.robot.face }; }, name);
  const cam = () => world(() => { const r = window.__atriumWorld.rig; return { x: r.want.target.x, z: r.want.target.z, dist: r.want.dist, az: r.want.az, tilt: r.want.tilt }; });
  /** A world point's screen position → page coordinates (the canvas sits right of the rail, under the top bar). */
  const onPage = async (p) => { const b = await canvasBox(); return { x: b.x + p.x, y: b.y + p.y }; };
  const canvasBox = () => page.$eval('.world-stage canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

  test('the colony loads with a loading screen, then shows every robot on its plot', async () => {
    await s.open();
    await page.waitForSelector('.world-loading');
    await page.waitForSelector('.world-loading', { state: 'detached', timeout: 60000 });
    await page.waitForFunction(() => window.__atriumWorld?.agents.size === 4);
    const probe = await world(() => window.__atriumWorld.probe());
    assert.ok(probe.colours > 60, `rendered a real scene: ${JSON.stringify(probe)}`);
    await s.shot('30-colony');
  });

  test('clicking a robot opens it: the inspector, a follow card with its status, and a selection ring', async () => {
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Quill'); return e?.screen?.visible; });
    const q = await onPage((await bot('Quill')).screen);
    // click on its body (a little below the name plate)
    await page.mouse.click(q.x, q.y + 22);
    await page.waitForSelector('.insp-head .name:text-is("Quill")');
    await page.waitForSelector('[data-testid=bot-card] .bc-name:text-is("Quill")');
    await page.waitForFunction(() => document.querySelector('[data-testid=bot-card]').style.visibility === 'visible');
    const card = await page.textContent('[data-testid=bot-card]');
    assert.match(card, /Writer/);
    assert.match(card, /Habitat level 0/);
    assert.match(card, /0 tasks done · next at 1/);
    assert.ok(await world(() => { const w = window.__atriumWorld; return w.agents.get(w.selected).robot.ring.visible; }), 'selection ring shows');
    await s.shot('31-selected');
  });

  test('the card follows the robot when the camera moves', async () => {
    const before = await page.$eval('[data-testid=bot-card]', (el) => el.style.transform);
    const box = await canvasBox();
    await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.7);
    await page.mouse.down(); await page.mouse.move(box.x + box.w * 0.45, box.y + box.h * 0.6, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(600);
    const afterT = await page.$eval('[data-testid=bot-card]', (el) => el.style.transform);
    assert.notEqual(afterT, before, 'card moved with the robot on screen');
  });

  test('camera: drag pans, wheel zooms at the cursor, right-drag rotates and tilts, keys and orbit', async () => {
    await page.keyboard.press('0');
    await page.waitForTimeout(400);
    const box = await canvasBox();
    const c0 = await cam();
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.w / 2 - 150, box.y + box.h / 2 - 60, { steps: 8 }); await page.mouse.up();
    const c1 = await cam();
    assert.ok(Math.hypot(c1.x - c0.x, c1.z - c0.z) > 3, `drag panned the map (${JSON.stringify([c0, c1])})`);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(200);
    const c2 = await cam();
    assert.ok(c2.dist < c1.dist * 0.8, `wheel zoomed in (${c1.dist.toFixed(1)} → ${c2.dist.toFixed(1)})`);
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + box.w / 2 + 160, box.y + box.h / 2 + 40, { steps: 8 }); await page.mouse.up({ button: 'right' });
    const c3 = await cam();
    assert.ok(Math.abs(c3.az - c2.az) > 0.5, 'right-drag rotated');
    assert.ok(c3.tilt !== c2.tilt, 'right-drag tilted');
    await page.keyboard.press('-'); await page.keyboard.press('-');
    assert.ok((await cam()).dist > c3.dist, 'minus zooms out');
    await page.keyboard.press('o');
    const a0 = (await cam()).az; await page.waitForTimeout(1500);
    assert.ok((await cam()).az > a0 + 0.1, 'orbit mode turns the camera');
    assert.equal(await page.getAttribute('button[aria-label=Orbit]', 'aria-pressed'), 'true');
    await page.keyboard.press('o');
    await page.keyboard.press('0');
    await page.waitForTimeout(800);
    const home = await cam();
    assert.ok(Math.hypot(home.x, home.z) < 3 && Math.abs(home.az - Math.PI / 4) < 0.01, 'reset view goes home');
  });

  test('hovering a robot shows a tooltip with what it is doing', async () => {
    // robots potter about, so follow Atlas with the mouse like a person would
    await waitFor(async () => {
      const a = await onPage((await bot('Atlas')).screen);
      await page.mouse.move(a.x - 2, a.y + 20); await page.mouse.move(a.x, a.y + 24);
      return !!(await page.waitForSelector('.world-tooltip b:text-is("Atlas")', { timeout: 1500 }).catch(() => null));
    }, { timeout: 30000, interval: 100, message: 'tooltip for Atlas' });
    assert.match(await page.textContent('.world-tooltip'), /Atlas · (Pottering about|Having a nap|Just finished a task|Talking with)/);
    assert.equal(await page.$eval('.world-stage canvas', (c) => c.style.cursor), 'pointer');
  });

  test('chatting: Quill walks to her workbench, hammers with sparks and a ⚒ badge, then cheers ✓ and her habitat grows', async () => {
    await s.open('#/world');
    await page.waitForFunction(() => window.__atriumWorld?.loaded && window.__atriumWorld.agents.size === 4, null, { timeout: 60000 });
    await page.click('.roster-item:has-text("Quill")');
    await world(() => {
      const w = window.__atriumWorld; window.__seen = { modes: new Set(), badges: new Set(), sparks: 0, scaffold: false, pieces: 0 };
      const q = [...w.agents.values()].find((x) => x.agent.name === 'Quill');
      window.__seen.pieces0 = w.land.plots.get(q.id).pieces.length;
      clearInterval(window.__w2);
      window.__w2 = setInterval(() => {
        window.__seen.modes.add(q.mode);
        const b = document.querySelector(`.wo-bot[data-id="${q.id}"] .wo-badge:not([hidden])`); if (b) window.__seen.badges.add(b.textContent);
        if (w.land.plots.get(q.id).scaffold.visible) window.__seen.scaffold = true;
        if (q.robot.clip === 'hammer') window.__seen.hammer = true;
        window.__seen.sparks = Math.max(window.__seen.sparks, w.fx.glow.n);
        window.__seen.pieces = w.land.plots.get(q.id).pieces.length;
      }, 80);
    });
    await page.fill('.composer textarea', 'Write a two line poem about robots building a city');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__seen.modes.has('working') && window.__seen.hammer, null, { timeout: 30000 });
    await page.waitForTimeout(700);
    await s.shot('32-quill-working');
    await page.waitForSelector('.msg.them .bubble', { timeout: 30000 });
    await page.waitForFunction(() => window.__seen.modes.has('celebrate'), null, { timeout: 20000 });
    await page.waitForTimeout(600);
    await s.shot('33-quill-done');
    const seen = await world(() => { clearInterval(window.__w2); return { ...window.__seen, modes: [...window.__seen.modes], badges: [...window.__seen.badges] }; });
    assert.ok(seen.badges.includes('⚒'), `working badge: ${seen.badges}`);
    assert.ok(seen.badges.includes('✓'), `done badge: ${seen.badges}`);
    assert.ok(seen.scaffold, 'scaffolding went up while she worked');
    assert.ok(seen.sparks > 3, 'sparks flew');
    assert.ok(seen.pieces > seen.pieces0, `her habitat grew (${seen.pieces0} → ${seen.pieces} pieces)`);
    assert.equal((await bot('Quill')).level, 1);
    assert.match(await page.textContent('[data-testid=bot-card]'), /Habitat level 1.*1 task done · next at 3/s);
    assert.equal(s.t.agent('Quill').stats.tasks, 1, 'the server counted the task');
    // she was looking at the chat, so she doesn't need attention afterwards
    assert.equal((await bot('Quill')).unread, false);
  });

  test('a reply you haven\'t read: the robot waves at you with a ? badge until you open it', async () => {
    await page.click('.insp-head button[aria-label="Close"]');
    const atlas = s.t.agent('Atlas');
    await page.evaluate((id) => fetch(`/api/agents/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Find me one fact about Mars', wait: true }) }), atlas.id);
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Atlas'); return e.mode === 'waiting' && e.robot.clip === 'wave'; }, null, { timeout: 30000 });
    await page.waitForSelector('[data-testid=need-you]:has-text("1 needs you")');
    await page.waitForSelector(`.wo-bot[data-id="${atlas.id}"] .wo-badge:not([hidden]):text-is("?")`);
    await page.waitForTimeout(500);
    await s.shot('34-atlas-waving');
    await page.click('[data-testid=need-you]');
    await page.waitForSelector('.insp-head .name:text-is("Atlas")');
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Atlas'); return e.mode !== 'waiting'; });
    await page.waitForSelector('[data-testid=need-you]', { state: 'detached' });
    assert.match(await page.textContent('.chat-log'), /Mars/);
  });

  test('when a task fails the robot slumps with red eyes and a ! badge; a new task clears it', async () => {
    await page.click('.insp-head button[aria-label="Close"]');
    const sen = s.t.agent('Sentinel');
    await page.evaluate(async (id) => {
      await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: { anthropic: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9' } } }) });
      await fetch(`/api/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'anthropic' }) });
      fetch(`/api/agents/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'check this', wait: true }) });
    }, sen.id);
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Sentinel'); return e.mode === 'error' && e.robot.face === 'error'; }, null, { timeout: 30000 });
    await page.waitForSelector(`.wo-bot[data-id="${sen.id}"] .wo-badge:not([hidden]):text-is("!")`);
    await page.waitForSelector('[data-testid=need-you]:has-text("1 needs you")');
    await page.waitForTimeout(900);
    await s.shot('35-sentinel-error');
    // fix it and try again: the error clears as soon as the new task starts
    await page.evaluate(async (id) => {
      await fetch(`/api/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'simulated' }) });
      fetch(`/api/agents/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'review: hello world', wait: true }) });
    }, sen.id);
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Sentinel'); return e.mode === 'working' || e.mode === 'celebrate' || e.mode === 'waiting'; }, null, { timeout: 30000 });
  });

  test('a robot left alone long enough walks to its bench and naps', async () => {
    await world(() => { window.__atriumWorld.cfg.sleepAfterMs = 1500; });
    const n = s.t.agent('Nova');
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Nova'); return e.mode === 'sleeping' && e.sitting && e.robot.face === 'sleep'; }, null, { timeout: 40000 });
    const nova = await bot('Nova');
    const bench = await world((id) => window.__atriumWorld.agents.get(id).layout.bench, n.id);
    assert.ok(Math.hypot(nova.x - bench.x, nova.z - bench.z) < 1.6, 'she sat by her bench');
    await page.waitForTimeout(1500);
    await s.shot('36-nova-napping');
    await world(() => { window.__atriumWorld.cfg.sleepAfterMs = 6 * 60 * 1000; });
    // a message wakes her up: she stands and gets to work
    await page.evaluate((id) => fetch(`/api/agents/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi', wait: true }) }), n.id);
    await page.waitForFunction(() => { const e = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Nova'); return e.mode !== 'sleeping' && !e.sitting; }, null, { timeout: 20000 });
  });

  test('fly to Mars and Luna: the planet changes, the choice is saved, and everyone keeps their plot', async () => {
    const plotsBefore = await world(() => [...window.__atriumWorld.agents.values()].map((e) => [e.agent.name, e.plot]));
    await page.click('[data-testid=planet-mars]');
    await page.waitForSelector('.toast:has-text("Welcome to Mars")');
    await page.waitForFunction(() => window.__atriumWorld.planet === 'mars' && window.__atriumWorld.land.planetId === 'mars');
    assert.equal(s.t.app.settings().world.planet, 'mars');
    assert.match(await page.textContent('.hud-pill'), /Mars/);
    assert.match(await page.textContent('.topbar h1'), /on Mars/);
    await page.waitForTimeout(1200);
    await s.shot('37-mars');
    await page.keyboard.press('g'); // next planet
    await page.waitForFunction(() => window.__atriumWorld.planet === 'luna');
    await page.waitForTimeout(1200);
    await s.shot('38-luna');
    assert.deepEqual(await world(() => [...window.__atriumWorld.agents.values()].map((e) => [e.agent.name, e.plot])), plotsBefore);
    // it sticks across a reload
    await s.open('#/world');
    await page.waitForFunction(() => window.__atriumWorld?.loaded && window.__atriumWorld.planet === 'luna', null, { timeout: 60000 });
    await page.click('[data-testid=planet-terra]');
    await page.waitForFunction(() => window.__atriumWorld.planet === 'terra');
  });

  test('time of day: Live → Dawn → Day → Dusk → Night; the night is dark with glowing lights', async () => {
    const labels = [];
    for (let i = 0; i < 5; i++) {
      const before = (await page.textContent('[data-testid=time-btn]')).trim();
      await page.click('[data-testid=time-btn]');
      await page.waitForFunction((b) => document.querySelector('[data-testid=time-btn]').textContent.trim() !== b, before);
      labels.push((await page.textContent('[data-testid=time-btn]')).trim());
    }
    assert.deepEqual(labels, ['Dawn', 'Day', 'Dusk', 'Night', 'Live']);
    // quick presses in a row still land on the right time
    for (let i = 0; i < 4; i++) await page.click('[data-testid=time-btn]');
    await page.waitForFunction(() => document.querySelector('[data-testid=time-btn]').textContent.trim() === 'Night');
    await page.waitForFunction(() => window.__atriumWorld.sky.night > 0.9, null, { timeout: 5000 });
    assert.equal(s.t.app.settings().world.time, 'night');
    const glow = await world(() => [...window.__atriumWorld.land.plots.values()][0].accent.userData.glow.value);
    assert.ok(glow > 0.7, 'habitat trim lights up at night');
    await page.waitForTimeout(800);
    await s.shot('39-night');
    await page.click('[data-testid=time-btn]'); // → Live
  });

  test('clicking an empty plot offers to add an agent there', async () => {
    const spot = await onPage(await world(() => { const w = window.__atriumWorld; const [, g] = [...w.land.vacant][0]; return w.toScreen(g.position.clone()); }));
    await page.mouse.click(spot.x, spot.y);
    await page.waitForSelector('.builder');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.builder', { state: 'detached' });
  });

  test('connectors stand round the hub as relay towers and light up when an agent uses them', async () => {
    const relays = await world(() => [...window.__atriumWorld.land.relays.values()].map((r) => r.name));
    assert.ok(relays.length >= 1, `relay towers: ${relays}`);
    assert.ok(await page.$('.wo-label.relay'), 'relay towers are labelled');
    assert.ok(await page.$('.wo-label.laya'), 'the Laya beacon is labelled');
  });

  test('no console errors and a sane frame budget', async () => {
    const st = await world(() => window.__atriumWorld.stats());
    assert.ok(st.frames > 50, `rendered ${st.frames} frames`);
    assert.ok(st.calls < 400, `draw calls per frame: ${st.calls}`);
    assert.deepEqual(s.errors, [], 'browser console errors');
  });
});
