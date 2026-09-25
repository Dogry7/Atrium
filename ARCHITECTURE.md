# Atrium: system design

Atrium is a local-first multi-agent workspace. You build agents, give them names, roles and tools, and they live as robots in a 3D colony, where you can watch them work, talk to each other (A2A) and run workflows.

## 1. Requirements

**Functional**

- Create, edit, delete agents: name, role, look, personality/instructions, model, tools, who they may talk to, memory.
- Talk to any agent directly (single-agent mode).
- Agents talk to each other (A2A mode): ask, delegate, fan out in parallel, reply. Loops are prevented.
- Standard A2A protocol on the wire so external agents can call Atrium agents and Atrium agents can call external ones.
- Workflows: a visual graph of steps (agents, decisions, conditions, tools, transforms), triggered manually, by webhook or by schedule.
- Fully modular: model providers and connectors are plugins. Built in: Claude, OpenAI-compatible, an offline Simulated brain, MCP, Web/HTTP, Laya, remote A2A agents. You add more by dropping a folder into `plugins/`.
- A live, visual world plus a timeline of everything that happened.
- Easy to drive: web UI, REST API, CLI, and an MCP server so Claude Desktop/Cowork can drive Atrium too.

**Non-functional**

- One user, one machine: `npm start` with zero runtime dependencies.
- Works offline out of the box (Simulated brain) and gets smarter the moment an API key is added.
- Every agent action is observable in real time, with sub-100ms event fan-out to the UI.
- Safe by default: binds to 127.0.0.1, secrets masked in every API response, tool loops and A2A recursion bounded.

## 2. High-level design

```
 Browser (Preact + htm, no build)                               External world
 ┌───────────────────────────────────────────┐                  ┌───────────────────┐
 │ World (three.js colony, WebGL)             │                  │ A2A clients/agents│
 │ Agents · Workflows · Connectors · Activity │                  │ Webhook senders   │
 └──────────┬──────────────────▲─────────────┘                  │ MCP servers       │
       REST │ (JSON)       SSE │ (events)                          │ LLM APIs, Laya    │
 ┌──────────▼──────────────────┴──────────────────────────────┐   └───▲─────▲────▲───┘
 │ HTTP layer  /api/*  /a2a/*  /.well-known/agent-card.json   │◄──────┘     │    │
 ├────────────────────────────────────────────────────────────┤             │    │
 │ Event bus (in-proc pub/sub + ring buffer) ──► SSE fan-out   │             │    │
 ├───────────────┬──────────────────┬─────────────────────────┤             │    │
 │ Agent runtime │ Workflow engine  │ Plugin host             │─────────────┘    │
 │ tool loop,    │ DAG, branching,  │ provider plugins        │──────────────────┘
 │ A2A calls,    │ joins, Decide    │ connector plugins       │
 │ tasks, memory │ (Laya→escalate)  │ (instances + tools)     │
 ├───────────────┴──────────────────┴─────────────────────────┤
 │ Store: JSON collections, atomic writes (data/*.json)        │
 └────────────────────────────────────────────────────────────┘
```

**Data flow for a chat message.** `POST /api/agents/:id/chat` creates a **Task** (A2A-shaped). The runtime builds a system prompt (persona, colleagues, memory) and calls the provider with streaming. Text deltas, tool calls and tool results go out as events. Tool calls may be connector tools, memory, or `message_agent`, which starts a child Task on another agent. The final reply completes the Task. The UI animates each event: the robot goes to its workbench and hammers, runs to a colleague's plot, speech bubbles appear, relay towers light up, and the habitat grows when the task completes (`agent.reply` carries the new task count).

## 3. Deep dive

### Internal message format
Anthropic-style content blocks: `text`, `tool_use`, `tool_result` (plus `thinking` blocks, preserved verbatim for Claude). Each provider maps to and from its wire format. The OpenAI adapter converts `tool_use` to `tool_calls` and `tool_result` to `role:"tool"` messages.

### Provider contract (`server/providers/*.js`)
```js
{ id, name, configFields, defaultModel,
  async listModels(settings) -> [{id, name}],
  async chat({ model, system, messages, tools, maxTokens, temperature, signal, onDelta, meta, settings })
      -> { content: Block[], stopReason: 'end_turn'|'tool_use'|'max_tokens', usage } }
```

### Connector plugin contract (`server/plugins/builtin/*.js`, `plugins/*/index.js`)
```js
export default {
  id, name, description, icon, category,
  configFields: [{ key, label, type, required, default, help, options }],
  async create(config, ctx) -> {
    async listTools() -> [{ name, description, inputSchema }],
    async callTool(name, args, callCtx) -> string | object,
    async test() -> { ok, message, tools? },
    async close() }
}
```
A **connector** is a configured instance of a plugin, for example "GitHub (MCP)". Agents attach connectors. Tools are exposed to the model as `<connector_slug>__<tool>` (sanitized, ≤64 chars) so names never collide.

### A2A
- **Internal.** The `message_agent` tool runs a child Task on the target agent. It records the **call chain**, refuses re-entry (A→B→A deadlocks become a clear tool error telling the model to reply instead), and caps depth at 4. Several `message_agent` calls in one turn run in parallel, which gives fan-out delegation.
- **External server.** Each agent publishes `/a2a/<id>/.well-known/agent-card.json` and a JSON-RPC endpoint at `/a2a/<id>`. The site root `/.well-known/agent-card.json` is the "front desk" agent. Supported methods cover both A2A **1.0** (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `{task}` envelope, `TASK_STATE_*`) and **0.3** (`message/send`, `tasks/get`, `tasks/cancel`, `kind` discriminators). The response mirrors the dialect of the request.
- **External client.** The "Remote A2A agent" connector resolves a card, tries 1.0 first, falls back to 0.3 on `-32601`, and polls non-terminal tasks. Remote agents appear as visitors by the lander at the colony hub.

### Laya (System 1 decisions)
Laya is a calibrated classifier (choice / score / noul), not a chat model. It plugs in two ways:
1. The **Laya connector** gives agents a `laya_decide` tool (via `laya-serve` `POST /v1/systemone`; Laya's own MCP server also works through the MCP connector).
2. The workflow **Decide** node, `engine: auto | laya | llm`. Auto asks Laya first. If `confidence < threshold`, it **escalates** to an LLM agent (System 2) and records both answers in the run log.

### Workflow engine
- The graph is `{ nodes, edges }`. Edges carry a `fromPort` (branch label).
- Scheduling is event-driven. A node runs once all of its inbound edges are *resolved* and at least one *fired*. A node that is not taken **propagates skip** downstream, so joins after branches work without special cases. Fan-out runs in parallel.
- Nodes: `trigger`, `agent`, `decide`, `condition`, `tool`, `transform`, `output`.
- Templates: `{{input}}`, `{{input.field}}`, `{{last}}`, `{{nodes.<id>.output}}`, `{{nodes.<id>.choice}}`.
- Triggers: manual (UI/API/CLI/MCP), webhook `POST /api/hooks/:workflowId` (token-checked), schedule (every N minutes).

### Storage
JSON files per collection. Writes are debounced (80ms), atomic (tmp + rename) and flushed on shutdown. Tasks, runs and events are capped ring buffers. *Trade-off:* SQLite would scale further, but JSON keeps zero dependencies, is human-readable, and makes export/import a single file. At single-user volumes (hundreds of agents, thousands of tasks) it is well within limits. **Revisit** if you want multi-user or hosted deployment.

### Real time
Server-Sent Events rather than WebSockets. The traffic is one-directional (server to UI), SSE is native in browsers and Node needs no library, and it reconnects automatically. `Last-Event-ID` replays missed events from the ring buffer.

### Error handling
Provider errors are mapped to human messages (missing key, 401, 429 with retry, overloaded). Tool errors return to the model as `is_error` tool results so it can recover. Tasks carry `failed` status with a reason. Every long operation is abortable (Task cancel, Run cancel).

### The colony (web/js/world)

The world is a three.js scene, split so the rules can be tested without a GPU:

- `colony.js` holds the pure rules: the hex grid, plot layout (`agent.plot` is an index into a spiral round the hub, assigned by the server so plots never move), habitat pieces per level (`levelFor(stats.tasks)`), the hub, planets, time of day, and seeded scatter.
- `behaviour.js` holds the pure state machine. Precedence is visiting > error > working > celebrate > waiting > sleeping > potter, and it maps to badges, clips and faces.
- `nav.js` does grid A* with string-pulling round habitats, relays, the lander and scatter.
- `engine.js` is the orchestrator. It has the same API the page always used: `sync`, `handle(event)`, `select`, `focusOn`, `zoomBy`. The helpers around it are `land.js` (ground, decks, habitats, relays, the Laya beacon and the lander), `robot.js` (the KayKit mannequin rig with an Atrium robot head, a screen face and 15 clips), `sky.js` (sky dome, sun and moon, stars), `fx.js` (particles and beams), `camera.js` (map-style controls) and `overlay.js` (HTML name plates, badges and bubbles).
- The simulation runs in fixed sub-steps of real time, so a slow frame never slows the colony's clock. Quality set to Auto lowers the resolution, then turns off shadows, then caps the frame rate on machines without a real GPU, and remembers the result.

## 4. Scale and reliability
Designed for one person's machine: tens of agents and a handful of concurrent tasks. The limiting factor is LLM latency, not Atrium. The bus is in-process. **Revisit:** a queue (Redis/NATS) plus a worker pool if agents must run across machines, and SQLite/Postgres for storage.

## 5. Trade-offs made explicit
| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Runtime deps | none | Express, ws, SQLite libs | `npm start` just works; smaller attack surface |
| UI | Preact+htm, no build | React+Vite | Nothing to compile; still component-based |
| Realtime | SSE | WebSocket | One-directional, auto-reconnect, no lib |
| Storage | JSON files | SQLite | Zero deps, inspectable; fine at this scale |
| Laya | Decision node + tool | Treat as chat LLM | It's a classifier: use it where it is strong, escalate where it isn't |
| A2A | Both 1.0 and 0.3 | One version | The ecosystem is mid-migration |
