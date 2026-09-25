// E2E: real-provider, Laya, remote A2A and resilience paths through the UI.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { session } from './setup.js';
import { startApp, tmpDir, waitFor } from '../helpers.js';
import { anthropicMock } from '../fixtures/llm-mocks.js';
import { layaMock } from '../fixtures/laya-mock.js';

describe('Integrations through the UI', () => {
  let s, page, claude, laya;
  before(async () => {
    claude = anthropicMock(); claude.m = await claude.srv;
    laya = await layaMock();
    s = await session(); page = s.page;
  });
  after(async () => { await s.close(); await claude.m.close(); await laya.close(); });

  test('add a Claude key in Settings, switch Nova to Claude, and chat (streamed from the Messages API)', async () => {
    await s.open('#/settings');
    await page.fill('#prov-anthropic-apiKey', 'sk-ant-test');
    await page.fill('#prov-anthropic-baseUrl', claude.m.url);
    await page.click('[data-testid=save-anthropic]');
    await page.waitForSelector('text=Connected · 2 models available');
    await page.waitForSelector('.settings-card .badge:has-text("configured")');
    // the key is never sent back to the browser in clear text
    await s.open('#/settings');
    assert.equal(await page.inputValue('#prov-anthropic-apiKey'), 'sk-a••••test');
    // switch Nova to Claude in the agent editor
    await s.open('#/agents');
    await page.click('button[aria-label="Edit Nova"]');
    await page.click('.seg button:has-text("Claude")');
    await page.waitForFunction(() => document.querySelector('#ag-model')?.value === 'claude-sonnet-5');
    assert.ok(await page.$('#model-list option[value="claude-opus-5-5"]'), 'model list fetched from the provider');
    await page.click('[data-testid=save-agent]');
    await page.waitForSelector('.toast:has-text("Nova updated")');
    await s.open('#/world');
    await page.click('.roster-item:has-text("Nova")');
    assert.match(await page.textContent('.insp-head'), /Anthropic · claude-sonnet-5/);
    await page.fill('.composer textarea', 'hello');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.them .bubble:has-text("Hello from mock Claude (model claude-sonnet-5)")');
    const req = claude.requests.filter((r) => r.url === '/v1/messages').pop();
    assert.equal(req.headers['x-api-key'], 'sk-ant-test');
    await s.shot('20-claude-chat');
  });

  test('a bad key shows a helpful error in the chat with a link to Settings', async () => {
    await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: { anthropic: { apiKey: 'sk-wrong' } } }) }));
    await page.fill('.composer textarea', 'are you there?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.error:has-text("API key was rejected (401)")');
    assert.ok(await page.$('.msg.error button:has-text("Open Settings")'));
    await s.shot('21-error');
  });

  test('connect Laya and run Support triage: Laya routes, low confidence escalates', async () => {
    await s.open('#/connectors');
    await page.click('[data-testid=add-plugin-laya]');
    await page.waitForSelector('.modal code:has-text("laya-serve")');
    await page.fill('#cfg-baseUrl', laya.url);
    await page.click('[data-testid=save-connector]');
    await page.waitForSelector('.toast:has-text("Laya connected")');
    await s.open('#/workflows');
    await page.click('.wf-item:has-text("Support triage")');
    await page.waitForSelector('.node:has-text("Route")');
    await page.click('.node:has-text("Route")');
    assert.equal(await page.textContent('.wf-panel .seg button.on'), 'Laya → LLM');
    await page.click('[data-testid=wf-run]');
    await page.click('[data-testid=wf-run-go]');
    await page.waitForSelector('[data-testid=run-output]', { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=run-output]'), /routed to billing/);
    await page.click('.run-panel .seg button:has-text("Steps")');
    await page.waitForSelector('.run-panel :text("Decided by Laya")');
    assert.equal(await page.locator('.node.st-skipped').count(), 2, 'the other two branches were skipped');
    await s.shot('22-laya-route');
    // an ambiguous message escalates to the LLM agent
    await page.click('[data-testid=wf-run]');
    await page.fill('.modal textarea', 'hello, quick question about your company');
    await page.click('[data-testid=wf-run-go]');
    await page.waitForFunction(() => document.querySelector('.run-panel')?.textContent.includes('Completed'), null, { timeout: 30000 });
    await page.click('.run-panel .seg button:has-text("Steps")');
    await page.waitForSelector('.run-panel :text("escalated (Laya said")');
    await s.shot('23-laya-escalate');
  });

  test('a remote A2A agent joins as a visitor, and an agent can talk to it', async () => {
    const branch = await startApp();
    try {
      await branch.patch(`/api/agents/${branch.agent('Nova').id}`, { name: 'Remy', role: 'Branch manager' });
      await s.open('#/connectors');
      await page.click('[data-testid=add-plugin-a2a-remote]');
      await page.fill('#con-name', 'Branch office');
      await page.fill('#cfg-url', `${branch.base}/a2a/${branch.agent('Remy').id}/`);
      await page.click('.modal .chip:has-text("Sentinel")');
      await page.click('[data-testid=save-connector]');
      await page.waitForSelector('.toast:has-text("Found \\"Remy\\"")');
      await s.open('#/world');
      await page.waitForFunction(() => [...window.__atriumWorld.visitors.values()].some((v) => v.agent.name === 'Remy'));
      await page.click('.roster-item:has-text("Sentinel")');
      await page.fill('.composer textarea', 'use send_message tool with hello from HQ');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.msg.them .bubble:has-text("Remy")', { timeout: 20000 });
      await page.waitForTimeout(700);
      await s.shot('24-remote-a2a');
      assert.ok(branch.app.store.all('tasks').some((t) => t.from.type === 'external' && t.from.name === 'Sentinel' && t.input === 'hello from HQ'));
    } finally { await branch.close(); }
  });
});

describe('Resilience', () => {
  test('server restart: the UI reconnects by itself and state is intact', async () => {
    const dir = tmpDir();
    let t = await startApp({ dataDir: dir });
    const port = t.app.port;
    const s = await session({ app: t });
    try {
      await s.open('#/world');
      await s.page.waitForSelector('.roster-item');
      await t.close();
      await s.page.waitForSelector('text=Reconnecting', { timeout: 10000 });
      // start again on the same port + data
      const { createApp } = await import('../../server/app.js');
      const app2 = await createApp({ port, dataDir: dir, quiet: true });
      await s.page.waitForSelector('.badge:has-text("Reconnecting")', { state: 'detached', timeout: 20000 });
      await s.page.click('.roster-item:has-text("Atlas")');
      await s.page.fill('.composer textarea', 'still there?');
      await s.page.keyboard.press('Enter');
      await s.page.waitForSelector('.msg.them .bubble:has-text("still there")', { timeout: 15000 });
      await app2.close();
    } finally { await s.browser.close(); }
  });
});
