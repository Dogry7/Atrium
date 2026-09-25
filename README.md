# ◆ Atrium

**A multi-agent AI colony.** Build agents, give them names, jobs and tools, and watch them work as little robots in a 3D colony on another planet. They can work alone or together: they run over to each other's plots, hand off tasks (A2A) and run workflows you design.

- **A 3D colony (three.js).** Every agent is a robot with its own hex plot, and its habitat grows as it finishes tasks. You can see what each one is doing at a glance. A robot hammers at its habitat while it works (⚒), cheers when it finishes (✓), waves at you when it has replied and you haven't read it yet (?), slumps with red eyes when a task fails (!), and naps on its bench when it has been idle for a while. They run to each other's plots to hand off work. Connectors stand round the hub as relay towers and light up when they are used. Remote A2A agents land in the lander, and Laya's decisions pulse on the beacon.
- **Planets and time.** Put the colony on Terra, Mars or Luna. It has a real day/night cycle (Live follows your clock), and you can move the camera like a map: drag to pan, right-drag to rotate and tilt, scroll to zoom, and O to orbit.
- **Agent builder.** Set each agent's name, role, look, personality, model, tools, memory, and who it may talk to.
- **Single-agent or A2A.** Chat with one agent, or let them delegate. They can fan work out in parallel, and loops and runaway chains are prevented.
- **Real A2A protocol** (v1.0 + v0.3). Every agent has an Agent Card and a JSON-RPC endpoint, and it works with the official A2A SDK. Remote A2A agents can visit your colony as colleagues.
- **Workflows.** A visual editor with Agent, Decide, Condition, Tool, Transform and Output steps. Branches, parallel fan-out and joins are all supported. Run a workflow by hand, from a webhook, or on a schedule.
- **Laya** (`convaiinnovations/laya`) is built in as the "System 1" decision engine. The Decide step asks Laya first (in milliseconds) and escalates to an LLM agent when Laya isn't confident.
- **Plug-in everything.** Model providers: Claude, any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Ollama, LM Studio…), and an offline Simulated brain. Connectors: MCP servers (stdio, Streamable HTTP, SSE), Web & HTTP, Laya, remote A2A agents, plus your own drop-in plugins.
- **Drive it from anywhere.** Web UI, REST API, CLI, and an MCP server, so Claude Desktop, Cowork or Claude Code can talk to your agents.

Zero runtime dependencies. Everything stays on your machine.

---

## Quick start

```bash
cd Atrium            # this folder
npm start           # → http://127.0.0.1:4317
```

Requires Node.js 20.10+ (22 recommended). `npm install` is **only** needed to run the test suites.

On first run you get a starter team (**Nova** the coordinator, **Atlas** the researcher, **Quill** the writer and **Sentinel** the reviewer), two example workflows, and a Web connector. Until you add an API key they run on the **Simulated brain**. It's offline and deterministic: it shows every mechanic (delegation, tools, workflows, the colony), but its answers are templates.

**Give them real brains:** open **Settings → AI providers**, paste your Anthropic key (and/or OpenAI key or base URL), press **Save & test**, then **Use for all agents**. You can also set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` before `npm start`.

Options: `npm start -- --port 5000 --data ~/atrium-data --host 127.0.0.1` (or `ATRIUM_PORT`, `ATRIUM_DATA`, `ATRIUM_HOST`).

## Things to try

1. Click **Nova** and say *“Ask Atlas and Quill what they think about launching a newsletter”*. Nova walks over to both, they answer in parallel, and she combines the replies.
2. Tell Sentinel *“Remember that launch day is the 3rd of October”*. It's saved in **Memory** and recalled in later chats.
3. Open **Workflows → Research → Draft → Review** and press **Run**. Watch the steps light up while the robots get to work in the colony.
4. **Connectors → MCP server → preset “Everything”**, then give it to Atlas and ask *“use echo tool with hello”*.
5. Press **⌘K** for everything, **N** for a new agent, and **1–5** to switch pages.

## Laya (fast decisions)

Laya is a calibrated classifier (choice / score / yes-no), not a chat model, so Atrium uses it where it is strongest:

```bash
pip install "laya[serve]"
LAYA_PRELOAD=1 laya-serve          # serves http://localhost:8000 (first run downloads ~0.8 GB)
```

Then go to **Connectors → Laya decisions** and press **Add & test**. After that:

- Workflow **Decide** steps default to **Laya → LLM**: Laya routes instantly, and anything under the confidence threshold (0.7 by default) is escalated to an LLM agent. Both answers are shown in the run's Steps tab.
- Agents you give the connector get a `laya_decide` tool.
- Prefer MCP? `pip install "laya[mcp]"`, then add an MCP connector with command `laya-mcp-server`.

## A2A (Agent2Agent)

- Each agent's card lives at `http://127.0.0.1:4317/a2a/<agent-id>/.well-known/agent-card.json` (copy it from the agent editor). The root card `/.well-known/agent-card.json` is the “front desk” agent, which you choose in Settings.
- JSON-RPC methods: `SendMessage`, `GetTask`, `ListTasks`, `CancelTask` (v1.0) and `message/send`, `tasks/get`, `tasks/cancel` (v0.3). Replies use whichever dialect the caller used.
- **Settings → A2A server** lets you require a bearer token or switch the server off.
- To bring someone else's agent in, go to **Connectors → Remote A2A agent** and paste their URL. The agent appears as a visitor in the Gateway, and your agents can message it.

## Drive Atrium from outside

```bash
node bin/atrium.js agents
node bin/atrium.js chat Nova "Ask Atlas to research MCP servers"
node bin/atrium.js run "Support triage" "I was billed twice"
```

**MCP server** (Claude Desktop / Cowork / Claude Code):

```json
{ "mcpServers": { "atrium": { "command": "node", "args": [".../Atrium/bin/atrium-mcp.js"], "env": { "ATRIUM_URL": "http://127.0.0.1:4317" } } } }
```

It exposes the tools `list_agents`, `chat_with_agent`, `list_workflows`, `run_workflow` and `create_agent`.

**REST:** `POST /api/agents/Nova/chat {"message":"hi","wait":true}`, `POST /api/workflows/<id>/run {"input":"…","wait":true}`.

**Webhooks:** go to **Workflow → Triggers → Webhook** and copy the URL. Anything that POSTs JSON to it starts a run, and `&wait=1` returns the result.

## Write your own plugin

Copy `plugins/example-toolkit` to `plugins/my-thing`, edit it, and press **Reload plugins** on the Connectors page:

```js
export default {
  id: 'my-thing', name: 'My thing', description: 'What it does',
  configFields: [{ key: 'token', label: 'API token', type: 'password' }],   // form is generated for you
  async create(config) {
    return {
      async listTools() { return [{ name: 'do_it', description: '…', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]; },
      async callTool(name, args) { return `did it with ${args.q}`; },
      async test() { return { ok: true, message: 'Ready' }; },
    };
  },
};
```

Secrets (`password` fields) are masked everywhere in the UI and API.

## Tests

```bash
npm install          # dev tools only: Playwright, the MCP reference server, the A2A SDK
npm test             # unit + integration (~100 tests, ~30 s)
npm run test:e2e     # real browser journeys (Chromium)
```

What the tests cover, and what they run against:

- **Claude and OpenAI adapters:** servers that speak the real streaming wire formats (tool use, thinking blocks, retries, errors).
- **MCP:** the official `@modelcontextprotocol/server-everything`, over all three transports.
- **A2A:** the official `@a2a-js/sdk`, in both directions, plus a second live Atrium instance.
- **Laya:** the actual `laya.serve` app with stubbed weights, run when Python and `laya` are installed.
- **The UI:** 35 browser journeys in real Chromium (WebGL) that use it the way a person does: clicking robots, moving the camera, chatting, watching them work, switching planets and time of day.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design.

## Where things live

```
server/        Node server (no dependencies): API, agent runtime, workflow engine, A2A, MCP client, plugins
web/           The app (Preact + htm, no build step), including the three.js colony in web/js/world/ (models in web/assets/models, CC0)
plugins/       Your drop-in plugins
bin/           CLI and MCP server
data/          Your agents, workflows, chats, keys (git-ignored; delete to reset)
test/          unit / integration / e2e
```

## Credits

The 3D models come from CC0 (public domain) packs by [Kay Lousberg](https://kaylousberg.com) (KayKit Space Base Bits, Character Animations and Forest Nature Pack) and [Kenney](https://kenney.nl) (Nature Kit), packed as in the open-source Bot Crossing project. See `web/assets/models/CREDITS.md`. three.js is MIT-licensed and vendored in `web/lib/three`.
