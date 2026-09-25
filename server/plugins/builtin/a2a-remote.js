import { A2AClient } from '../../a2a/client.js';

/** Remote A2A agent: talk to any agent that speaks the Agent2Agent protocol. */
export default {
  id: 'a2a-remote',
  name: 'Remote A2A agent',
  description: 'Bring an external Agent2Agent (A2A) agent into your colony. Your agents can message it like a colleague.',
  icon: 'satellite',
  category: 'agent',
  configFields: [
    { key: 'url', label: 'Agent URL or card URL', type: 'text', required: true, help: 'e.g. https://agent.example.com or …/.well-known/agent-card.json' },
    { key: 'token', label: 'Bearer token', type: 'password', help: 'If the remote agent requires auth.' },
  ],

  async create(config) {
    if (!config.url) throw new Error('Enter the remote agent URL');
    const client = new A2AClient({ url: config.url, token: config.token });
    const card = await client.resolveCard();
    return {
      card,
      client,
      info: () => ({ card, endpoint: client.endpoint, dialect: client.dialect, cardError: client.cardError }),
      async listTools() {
        const skills = (card.skills || []).map((s) => s.name).filter(Boolean).slice(0, 6).join(', ');
        return [{
          name: 'send_message',
          description: `Send a message to the remote A2A agent "${card.name}"${card.description ? ` (${card.description.slice(0, 160)})` : ''}${skills ? `. Skills: ${skills}` : ''}. Returns its reply.`,
          inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'What to ask or tell the remote agent' }, contextId: { type: 'string', description: 'Optional conversation id to continue a thread' } }, required: ['message'] },
        }];
      },
      async callTool(name, args, { signal, agentName } = {}) {
        if (name !== 'send_message') throw new Error(`Unknown tool ${name}`);
        const r = await client.send(args.message, { contextId: args.contextId, signal, fromName: agentName });
        return r.text;
      },
      async test() {
        return { ok: true, message: `Found "${card.name}"${client.cardError ? ' (no card; using URL as endpoint)' : ''} · ${card.skills?.length || 0} skill(s) · endpoint ${client.endpoint}` };
      },
      async close() {},
    };
  },
};
