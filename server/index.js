#!/usr/bin/env node
import { createApp } from './app.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };

const port = Number(flag('port') || process.env.ATRIUM_PORT || process.env.PORT || 4317);
const host = flag('host') || process.env.ATRIUM_HOST || '127.0.0.1';
const dataDir = flag('data') || process.env.ATRIUM_DATA || undefined;

let app;
try {
  app = await createApp({ port, host, dataDir });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Is Atrium already running? Try: npm start -- --port ${port + 1}\n`);
    process.exit(1);
  }
  throw e;
}

const s = app.settings();
const c = (n, t) => `\x1b[${n}m${t}\x1b[0m`;
console.log(`
  ${c('1;35', '◆ Atrium')} ${c('2', `v${app.version}`)}  multi-agent colony

  ${c('1', 'Open')}      ${c('36', app.url)}
  ${c('1', 'Agents')}    ${app.store.all('agents').length} · workflows ${app.store.all('workflows').length} · connectors ${app.store.all('connectors').length}
  ${c('1', 'Brain')}     ${s.defaultProvider === 'simulated' ? c('33', 'Simulated (offline). Add a Claude/OpenAI key in Settings') : s.defaultProvider}
  ${c('1', 'A2A')}       ${app.url}/.well-known/agent-card.json
  ${c('2', 'Ctrl+C to stop')}
`);
if (host === '0.0.0.0') console.log(c('33', '  ⚠ Listening on all interfaces. Anyone on your network can reach Atrium.\n'));

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\n  Saving and shutting down…');
    await app.close().catch(() => {});
    process.exit(0);
  });
}
