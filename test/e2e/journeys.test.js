// End-to-end journeys through the real UI in Chromium, the way a person uses Atrium.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { session } from './setup.js';
import { ROOT, waitFor } from '../helpers.js';

const EVERYTHING = path.join(ROOT, 'node_modules/@modelcontextprotocol/server-everything/dist/index.js');

describe('Atrium, used like a person would', () => {
  let s, page;
  before(async () => { s = await session(); page = s.page; });
  after(async () => { await s.close(); });

  const roster = () => page.$$eval('.roster-item .n', (els) => els.map((e) => e.textContent));
  const world = (fn) => page.evaluate(fn);

  test('1. first launch: the 3D colony renders with the starter team on their own plots', async () => {
    await s.open();
    await page.waitForSelector('.roster-item');
    assert.deepEqual(await roster(), ['Nova', 'Atlas', 'Quill', 'Sentinel']);
    await page.waitForSelector('.world-loading', { state: 'detached', timeout: 60000 });
    await page.waitForFunction(() => window.__atriumWorld?.loaded && window.__atriumWorld.agents.size === 4);
    // the WebGL canvas actually drew a scene (sky, ground, decks, robots), not a blank frame
    const probe = await world(() => window.__atriumWorld.probe());
    assert.ok(probe.lit > 0.95 && probe.colours > 60, `frame: ${JSON.stringify(probe)}`);
    const plots = await world(() => [...window.__atriumWorld.agents.values()].map((e) => ({ name: e.agent.name, plot: e.plot, d: Math.hypot(e.x - e.layout.center.x, e.z - e.layout.center.z) })));
    assert.deepEqual(plots.map((p) => p.plot).sort(), [0, 1, 2, 3], 'each agent owns a different plot');
    for (const p of plots) assert.ok(p.d < 6, `${p.name} stands on their plot (${p.d.toFixed(1)} from centre)`);
    assert.match(await page.textContent('.hud-pill'), /Atrium Colony\s*· Terra\s*4 agents/);
    // every robot has a name plate in the overlay
    assert.deepEqual((await page.$$eval('.world-overlay .wo-name', (els) => els.map((e) => e.textContent))).sort(), ['Atlas', 'Nova', 'Quill', 'Sentinel']);
    assert.match(await page.textContent('.inspector'), /Running on the Simulated brain/);
    await s.shot('01-colony');
  });

  test('2. create an agent with the builder; it lands at the hub and walks to its new plot', async () => {
    await page.click('[data-testid=world-new-agent]');
    await page.waitForSelector('.builder');
    await page.fill('#ag-name', 'Pixel');
    await page.click('.chip:has-text("Writer")');
    assert.equal(await page.inputValue('#ag-role'), 'Writer');
    await page.fill('#ag-role', 'Brand Designer');
    await page.click('button.swatch[aria-label="Colour #E858A8"]');
    await page.click('.chip:text-is("Dome")');
    await page.click('.chip:text-is("Visor")');
    assert.equal(await page.textContent('.pv-name'), 'Pixel', 'live preview updates');
    // the preview is the same 3D robot the colony uses
    await page.waitForFunction(() => { const c = document.querySelector('[data-testid=bot-preview]'); return c && !!c.getContext('webgl2'); });
    await page.waitForTimeout(1200);
    await s.shot('02-builder');
    await page.click('[data-testid=save-agent]');
    await page.waitForSelector('.toast:has-text("Pixel landed in the colony")');
    await page.waitForSelector('.insp-head .name:text-is("Pixel")');
    assert.match(page.url(), /#\/world\/agt_/);
    const e = await page.waitForFunction(() => { const w = window.__atriumWorld; const p = [...w.agents.values()].find((x) => x.agent.name === 'Pixel'); return p && { x: p.x, z: p.z, plot: p.plot }; });
    const pos = await e.jsonValue();
    assert.equal(pos.plot, 4, 'got the next free plot');
    assert.equal(s.t.agent('Pixel').plot, 4, 'the server owns the plot assignment');
    assert.ok(Math.hypot(pos.x, pos.z) < 6, 'lands at the hub');
    await page.waitForTimeout(900);
    await s.shot('02-pixel-lands');
    await page.waitForFunction(() => { const p = [...window.__atriumWorld.agents.values()].find((x) => x.agent.name === 'Pixel'); return p.arrived && !p.path.length && Math.hypot(p.x - p.layout.work.x, p.z - p.layout.work.z) < 0.8; }, null, { timeout: 30000 });
    // and the plot is really hers: a deck in her colour, with her name on it
    assert.equal(await world(() => { const w = window.__atriumWorld; const p = [...w.agents.values()].find((x) => x.agent.name === 'Pixel'); return '#' + w.land.plots.get(p.id).ledMat.color.getHexString(); }), '#e858a8');
    await page.click('.insp-head button[aria-label="Close"]');
    assert.deepEqual(await roster(), ['Nova', 'Atlas', 'Quill', 'Sentinel', 'Pixel']);
  });

  test('3. builder validation: empty and duplicate names', async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('.builder');
    await page.click('[data-testid=save-agent]');
    assert.equal(await page.textContent('.field .err'), 'Give your agent a name.');
    await page.fill('#ag-name', 'nova');
    await page.fill('#ag-role', 'Copycat');
    await page.click('[data-testid=save-agent]');
    assert.equal(await page.textContent('.field .err'), 'Another agent already has this name.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.builder', { state: 'detached' });
  });

  test('4. chat with Nova: she delegates to Atlas and Quill (A2A) and runs over to their plots', async () => {
    await page.click('.roster-item:has-text("Nova")').catch(async () => { await page.goto(`${s.t.base}/#/world`); await page.click('.roster-item:has-text("Nova")'); });
    await page.waitForSelector('.insp-head .name:text-is("Nova")');
    // watch for the visual handoff in the world
    await world(() => {
      window.__sawLink = false; window.__novaVisits = [];
      const w = window.__atriumWorld; const orig = w.handle.bind(w);
      w.handle = (e) => { orig(e); if (w.effects.some((f) => f.kind === 'link')) window.__sawLink = true; };
      // where Nova goes while she delegates: record the plots she's standing on when she talks
      clearInterval(window.__watch);
      window.__watch = setInterval(() => {
        if (w.effects.some((f) => f.kind === 'link')) window.__sawLink = true;
        const nova = [...w.agents.values()].find((x) => x.agent.name === 'Nova');
        if (nova.mode === 'visiting' && nova.talking) {
          const near = [...w.agents.values()].filter((o) => o !== nova).sort((a, b) => Math.hypot(nova.x - a.layout.center.x, nova.z - a.layout.center.z) - Math.hypot(nova.x - b.layout.center.x, nova.z - b.layout.center.z))[0];
          if (!window.__novaVisits.includes(near.agent.name)) window.__novaVisits.push(near.agent.name);
        }
      }, 100);
    });
    await page.fill('.composer textarea', 'Ask Atlas and Quill what they think about launching a newsletter');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.me .bubble:has-text("launching a newsletter")', { timeout: 3000 });
    await page.waitForSelector('.step:has-text("Asked Atlas")');
    await page.waitForSelector('.step:has-text("Asked Quill")');
    await page.waitForTimeout(1200);
    await s.shot('04-a2a-in-progress');
    await page.waitForSelector('.msg.them .bubble:has-text("Quill says")', { timeout: 30000 });
    assert.match(await page.textContent('.chat-log'), /Atlas says/);
    await waitFor(() => world(() => window.__sawLink), { timeout: 45000, message: 'A2A link animation' });
    // the world plays every handoff in turn, so it can finish a little after the chat does
    await waitFor(() => world(() => window.__novaVisits.length >= 2), { timeout: 45000, message: 'Nova visiting both teammates' });
    const visits = await world(() => { clearInterval(window.__watch); return window.__novaVisits; });
    assert.deepEqual([...visits].sort(), ['Atlas', 'Quill'], `Nova walked over to talk to: ${visits}`);
    await page.waitForTimeout(600);
    await s.shot('04-a2a-done');
    // the handoffs are visible in Activity
    await page.click('[data-testid=nav-activity]');
    await page.waitForSelector('.tl-item:has-text("Ask Atlas and Quill")');
    assert.match(await page.textContent('.tl-item:has-text("Ask Atlas and Quill")'), /2 handoffs/);
    await page.click('.tl-item:has-text("Ask Atlas and Quill") .head');
    await page.waitForSelector('.io');
    await s.shot('04-activity');
  });

  test('5. replies stream in token by token', async () => {
    await s.open('#/world');
    await page.click('.roster-item:has-text("Quill")');
    await page.fill('.composer textarea', 'Write a short welcome email for new customers');
    await page.keyboard.press('Enter');
    const lengths = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const txt = await page.$$eval('.msg.them .bubble', (b) => b.map((x) => x.textContent).join('|'));
      if (/welcome email/.test(txt)) lengths.add(txt.length);
      if (/different format\?/.test(txt)) break;
      await page.waitForTimeout(40);
    }
    assert.ok(lengths.size >= 3, `saw ${lengths.size} partial renders`);
  });

  test('6. edit an agent from the inspector', async () => {
    await page.click('.insp-head button[aria-label="Edit agent"]');
    await page.waitForSelector('.builder');
    await page.fill('#ag-role', 'Senior Writer');
    await page.click('[data-testid=save-agent]');
    await page.waitForSelector('.insp-head .role:text-is("Senior Writer")');
  });

  test('7. run the seeded Research → Draft → Review workflow and watch it progress', async () => {
    await page.keyboard.press('3');
    await page.waitForSelector('.wf-item.sel:has-text("Research")');
    await page.waitForSelector('.node');
    assert.equal(await page.locator('.node').count(), 5);
    await page.click('[data-testid=wf-run]');
    await page.waitForSelector('.modal textarea');
    assert.match(await page.inputValue('.modal textarea'), /multi-agent AI workflows/);
    await page.click('[data-testid=wf-run-go]');
    await page.waitForSelector('.node.st-running');
    await s.shot('07-workflow-running');
    await page.waitForSelector('[data-testid=run-output]', { timeout: 40000 });
    assert.match(await page.textContent('[data-testid=run-output]'), /Briefing[\s\S]*Review/);
    assert.equal(await page.locator('.node.st-done').count(), 5);
    await s.shot('07-workflow-done');
    await page.click('.run-panel .seg button:has-text("Steps")');
    assert.equal(await page.locator('.run-panel .card').count(), 5);
  });

  test('8. build a new workflow from scratch (toolbar, auto-connect, drag-to-connect, config) and run it', async () => {
    await page.click('[data-testid=wf-new]');
    await page.waitForSelector('.toast:has-text("Workflow created")');
    await page.fill('input[aria-label="Workflow name"]', 'Tagline factory');
    await page.click('.node:has-text("Start")');
    await page.click('[data-testid=add-agent]');
    await page.waitForSelector('.wf-panel select');
    await page.selectOption('.wf-panel select', { label: 'Quill · Senior Writer' });
    await page.fill('.wf-panel textarea', 'Write a tagline for: ');
    await page.click('.var-chip:has-text("Run input")');
    assert.equal(await page.inputValue('.wf-panel textarea'), 'Write a tagline for: {{input}}');
    await page.click('[data-testid=add-output]');
    assert.equal(await page.locator('.wf-edges path.edge').count(), 2, 'auto-connected Start→Agent→Output');
    // add a transform and connect it by dragging from the agent's output port
    await page.click('.wf-canvas', { position: { x: 600, y: 700 } });
    await page.click('[data-testid=add-transform]');
    const port = page.locator('.node:has-text("Agent step") .port[data-port="out"]');
    const target = page.locator('.node:has-text("Transform")');
    const pb = await port.boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    const tb = await target.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator('.wf-edges path.edge').count(), 3, 'drag-connected');
    await page.waitForSelector('text=Saved');
    await s.shot('08-builder');
    await page.click('[data-testid=wf-run]');
    await page.fill('.modal textarea', 'a cosy bookshop');
    await page.click('[data-testid=wf-run-go]');
    await page.waitForSelector('[data-testid=run-output]', { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=run-output]'), /cosy bookshop/);
    // persisted server-side
    const wf = s.t.app.store.all('workflows').find((w) => w.name === 'Tagline factory');
    assert.equal(wf.nodes.length, 4);
    assert.equal(wf.edges.length, 3);
  });

  test('9. add the Toolkit plugin, give it to Atlas, and try a tool by hand', async () => {
    await page.keyboard.press('4');
    await page.click('[data-testid=add-plugin-example-toolkit]');
    await page.waitForSelector('.modal');
    await page.click('.modal .chip:has-text("Atlas")');
    await page.click('[data-testid=save-connector]');
    await page.waitForSelector('.toast:has-text("connected")');
    await page.waitForSelector('[data-testid="conn-Toolkit (example plugin)"] .badge:has-text("Connected")');
    assert.match(await page.textContent('[data-testid="conn-Toolkit (example plugin)"]'), /4 tools/);
    await page.click('[data-testid="conn-Toolkit (example plugin)"] button:has-text("Tools")');
    await page.click('.tool-row:has-text("calculate")');
    await page.fill('.modal textarea', '{"expression": "2+2"}');
    await page.click('[data-testid=tool-run]');
    await page.waitForSelector('[data-testid=tool-result]');
    assert.equal(await page.textContent('[data-testid=tool-result]'), '2+2 = 4');
    await s.shot('09-tool-explorer');
    await page.keyboard.press('Escape');
  });

  test('10. connect a real MCP server through the UI', async () => {
    await page.click('[data-testid=add-plugin-mcp]');
    await page.click('.modal .chip:has-text("Everything")');
    assert.equal(await page.inputValue('#cfg-command'), 'npx');
    // use the locally installed copy instead of downloading via npx
    await page.fill('#cfg-command', process.execPath);
    await page.fill('#cfg-args', `"${EVERYTHING}" stdio`);
    await page.click('[data-testid=save-connector]');
    await page.waitForSelector('.toast:has-text("Connected to")', { timeout: 30000 });
    await page.waitForSelector('[data-testid="conn-Everything"] .badge:has-text("Connected")');
    await s.shot('10-connectors');
  });

  test('11. Atlas uses a connector tool mid-conversation', async () => {
    await s.open('#/world');
    await page.click('.roster-item:has-text("Atlas")');
    await page.fill('.composer textarea', 'use calculate tool with 12*7');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.step:has-text("calculate")');
    await page.waitForSelector('.msg.them .bubble:has-text("12*7 = 84")', { timeout: 20000 });
  });

  test('12. settings: my name and day theme', async () => {
    await page.click('[data-testid=nav-settings]');
    await page.fill('#s-profile input', 'Ryan');
    await page.click('#s-profile button:has-text("Save")');
    await page.waitForSelector('.toast:has-text("Saved")');
    await page.click('#s-appearance button:has-text("Day")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(s.t.app.settings().userName, 'Ryan');
    await page.keyboard.press('1');
    await page.waitForTimeout(800);
    await s.shot('12-colony-day');
    await page.keyboard.press('2');
    await page.waitForSelector('.agent-card');
    await s.shot('12-agents-day');
    await page.click('[data-testid=nav-settings]');
    await page.click('#s-appearance button:has-text("Night")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  });

  test('13. command palette and keyboard shortcuts', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('Sentinel');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.insp-head .name:text-is("Sentinel")');
    await page.waitForFunction(() => document.activeElement?.matches('.composer textarea'));
    await page.keyboard.press('Escape'); // leaves the message box
    await page.keyboard.press('Escape'); // closes the agent panel
    await page.waitForSelector('.roster-item');
    await page.keyboard.press('2');
    await page.waitForSelector('.agent-grid');
    await page.keyboard.press('5');
    await page.waitForSelector('text=Every task, handoff and workflow run');
  });

  test('14. remember something, see it in Memory, forget it', async () => {
    await s.open('#/world');
    await page.click('.roster-item:has-text("Sentinel")');
    await page.fill('.composer textarea', 'Remember that launch day is the 3rd of October');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.step:has-text("Saved to memory")', { timeout: 15000 });
    await page.click('.tabs button:has-text("Memory")');
    await page.waitForSelector('.card:has-text("launch day is the 3rd of October")');
    await page.click('button[aria-label="Forget"]');
    await page.click('.modal button:has-text("Forget")');
    await page.waitForSelector('text=No memories yet');
  });

  test('15. delete an agent (with confirmation)', async () => {
    await s.open('#/agents');
    await page.click('button[aria-label="Edit Pixel"]');
    await page.click('.modal-foot button:has-text("Delete")');
    await page.waitForSelector('text=Delete Pixel?');
    await page.click('.modal button:has-text("Delete agent")');
    await page.waitForSelector('.toast:has-text("Pixel left the colony")');
    await page.waitForFunction(() => ![...document.querySelectorAll('.agent-card .n')].some((e) => e.textContent === 'Pixel'));
    assert.equal(s.t.agent('Pixel'), undefined);
  });

  test('16. no horizontal overflow, labelled controls, no console errors', async () => {
    for (const [w, h] of [[1280, 800], [1920, 1080], [1024, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const hash of ['#/world', '#/agents', '#/workflows', '#/connectors', '#/activity', '#/settings']) {
        await s.open(hash);
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 0, `${hash} overflows by ${over}px at ${w}px`);
        const unlabeled = await page.$$eval('button', (bs) => bs.filter((b) => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).map((b) => b.outerHTML.slice(0, 80)));
        assert.deepEqual(unlabeled, [], `${hash}: buttons without an accessible name`);
      }
      if (w === 1280) await s.shot('16-colony-1280');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(s.errors, [], 'browser console errors');
  });
});
