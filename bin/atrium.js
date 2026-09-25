#!/usr/bin/env node
/**
 * Atrium CLI. Talks to a running Atrium over its REST API.
 *   atrium agents                         list agents
 *   atrium chat <agent> "<message>"        chat and print the reply
 *   atrium workflows                      list workflows
 *   atrium run "<workflow>" ["<input>"]    run a workflow and print the result
 *   atrium tasks                          recent tasks
 * Env: ATRIUM_URL (default http://127.0.0.1:4317)
 */
const BASE = (process.env.ATRIUM_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');
const [cmd, ...rest] = process.argv.slice(2);
const c = (n, t) => (process.stdout.isTTY ? `\x1b[${n}m${t}\x1b[0m` : t);

async function call(method, path, body) {
  let res;
  try { res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { console.error(c('31', `Can't reach Atrium at ${BASE}. Start it with: npm start`)); process.exit(2); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(c('31', j.error || `HTTP ${res.status}`)); process.exit(1); }
  return j;
}

const findWorkflow = async (name) => {
  const list = await call('GET', '/api/workflows');
  const w = list.find((x) => x.id === name) || list.find((x) => x.name.toLowerCase() === name.toLowerCase()) || list.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!w) { console.error(c('31', `No workflow matching "${name}". Try: atrium workflows`)); process.exit(1); }
  return w;
};

switch (cmd) {
  case 'agents': {
    const list = await call('GET', '/api/agents');
    for (const a of list) console.log(`${c('1', a.name.padEnd(14))} ${a.role.padEnd(28)} ${c('2', `${a.provider}${a.model ? ' · ' + a.model : ''}`)}`);
    break;
  }
  case 'chat': {
    const [agent, ...words] = rest;
    const message = words.join(' ');
    if (!agent || !message) { console.error('Usage: atrium chat <agent> "<message>"'); process.exit(1); }
    process.stderr.write(c('2', `${agent} is thinking…\n`));
    const r = await call('POST', `/api/agents/${encodeURIComponent(agent)}/chat`, { message, wait: true });
    if (r.error) { console.error(c('31', r.error)); process.exit(1); }
    console.log(r.reply);
    break;
  }
  case 'workflows': {
    for (const w of await call('GET', '/api/workflows')) console.log(`${c('1', w.name)}  ${c('2', `${w.nodes.length} steps · ${w.id}`)}`);
    break;
  }
  case 'run': {
    const [name, ...inp] = rest;
    if (!name) { console.error('Usage: atrium run "<workflow>" ["<input>"]'); process.exit(1); }
    const w = await findWorkflow(name);
    process.stderr.write(c('2', `Running "${w.name}"…\n`));
    const r = await call('POST', `/api/workflows/${w.id}/run`, { input: inp.join(' '), wait: true, trigger: 'cli' });
    if (r.status !== 'completed') { console.error(c('31', `Run ${r.status}: ${r.error || ''}`)); process.exit(1); }
    console.log(typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2));
    break;
  }
  case 'tasks': {
    for (const t of (await call('GET', '/api/tasks?limit=20')).reverse()) console.log(`${t.status.state.padEnd(10)} ${c('1', t.agentName.padEnd(12))} ${t.input.replace(/\s+/g, ' ').slice(0, 70)}`);
    break;
  }
  default:
    console.log(`${c('1;35', '◆ Atrium CLI')}  (${BASE})

  atrium agents                        List agents
  atrium chat <agent> "<message>"      Chat with an agent and print the reply
  atrium workflows                     List workflows
  atrium run "<workflow>" ["<input>"]  Run a workflow and print its output
  atrium tasks                         Recent tasks`);
}
