import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startApp, ROOT } from '../helpers.js';
import { McpClient } from '../../server/mcp/client.js';

const run = promisify(execFile);
const CLI = path.join(ROOT, 'bin/atrium.js');

describe('Driving Atrium from outside', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });
  const cli = (...args) => run(process.execPath, [CLI, ...args], { env: { ...process.env, ATRIUM_URL: t.base } });

  test('CLI: agents, chat, workflows, run, tasks, help', async () => {
    const agents = await cli('agents');
    assert.match(agents.stdout, /Nova\s+Team Lead & Coordinator/);
    const chat = await cli('chat', 'Quill', 'Write a tagline for a coffee shop');
    assert.match(chat.stdout, /first draft on \*\*tagline for a coffee shop\*\*/);
    const wfs = await cli('workflows');
    assert.match(wfs.stdout, /Support triage \(Laya\)/);
    const out = await cli('run', 'research', 'Why tea?');
    assert.match(out.stdout, /## Briefing/);
    assert.match(out.stdout, /## Review/);
    const tasks = await cli('tasks');
    assert.match(tasks.stdout, /completed\s+Quill/);
    assert.match((await cli()).stdout, /atrium chat <agent>/);
  });

  test('CLI errors are clear: unknown workflow, server down', async () => {
    await assert.rejects(cli('run', 'no-such-flow'), (e) => /No workflow matching "no-such-flow"/.test(e.stderr));
    await assert.rejects(run(process.execPath, [CLI, 'agents'], { env: { ...process.env, ATRIUM_URL: 'http://127.0.0.1:9' } }), (e) => /Can't reach Atrium/.test(e.stderr));
  });

  test('Atrium MCP server: any MCP client (Claude Desktop, Cowork…) can use the agents', async () => {
    const c = new McpClient({ transport: 'stdio', command: process.execPath, args: [path.join(ROOT, 'bin/atrium-mcp.js')], env: { ATRIUM_URL: t.base } });
    const init = await c.connect();
    try {
    assert.equal(init.serverInfo.name, 'atrium');
    const tools = (await c.listTools()).map((x) => x.name);
    assert.deepEqual(tools, ['list_agents', 'chat_with_agent', 'list_workflows', 'run_workflow', 'create_agent']);
    const list = await c.callTool('list_agents', {});
    assert.match(list.content[0].text, /- Atlas: Researcher/);
    const created = await c.callTool('create_agent', { name: 'Scout', role: 'Researcher' });
    assert.match(created.content[0].text, /Created Scout/);
    const reply = await c.callTool('chat_with_agent', { agent: 'Scout', message: 'hello' });
    assert.match(reply.content[0].text, /I'm Scout/);
    const wf = await c.callTool('run_workflow', { workflow: 'support triage', input: 'my invoice is wrong, refund please' });
    assert.equal(wf.isError, undefined, wf.content[0].text);
    assert.match(wf.content[0].text, /\[routed to billing\]/);
    const err = await c.callTool('chat_with_agent', { agent: 'Ghost', message: 'hi' });
    assert.equal(err.isError, true);
    assert.match(err.content[0].text, /No agent called "Ghost"/);
    } finally { await c.close(); }
  });
});
