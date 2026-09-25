import { agentDefaults } from './runtime/agents.js';
import { id as newId, now } from './util.js';

/** First-run content: a small team and two example workflows. */
export function seed(store, { provider = 'simulated', model = '' } = {}) {
  if (store.all('agents').length || store.doc('meta', {}).seeded) return false;
  const mk = (x) => {
    const a = agentDefaults({ provider, model, ...x }, store.all('agents'));
    store.insert('agents', a);
    return a;
  };
  const nova = mk({
    name: 'Nova', role: 'Team Lead & Coordinator',
    instructions: 'You coordinate the team. Break requests into parts, delegate to the right colleague (Atlas for research, Quill for writing, Sentinel for review), then combine their answers into one clear response.',
    avatar: { color: '#7C5CFF', hair: 'bun', accessory: 'headset' },
  });
  const atlas = mk({
    name: 'Atlas', role: 'Researcher',
    instructions: 'You dig up facts. Be precise, cite where information came from, and flag uncertainty. Use web tools when you have them.',
    avatar: { color: '#22C3A6', hair: 'short', accessory: 'glasses' },
  });
  const quill = mk({
    name: 'Quill', role: 'Writer',
    instructions: 'You turn notes into clear, warm, well-structured writing. Keep it tight. Match the requested format and length.',
    avatar: { color: '#FF7A59', hair: 'long', accessory: 'none' },
  });
  const sentinel = mk({
    name: 'Sentinel', role: 'Reviewer & QA',
    instructions: 'You review work critically: accuracy, clarity, tone, risk. Give a verdict (APPROVE or REVISE) and the top fixes.',
    avatar: { color: '#3BA7FF', hair: 'buzz', accessory: 'cap' },
  });

  const n = (type, x, y, data = {}) => ({ id: newId('n'), type, x, y, data });
  const e = (from, to, fromPort = 'out') => ({ id: newId('e'), from: from.id, to: to.id, fromPort });

  // Workflow 1: research → draft → review
  {
    const start = n('trigger', 60, 200, { label: 'Topic', sampleInput: 'Why do teams adopt multi-agent AI workflows?' });
    const research = n('agent', 310, 200, { label: 'Research', agentId: atlas.id, prompt: 'Research this topic and give 5 key findings with sources where possible:\n\n{{input}}' });
    const draft = n('agent', 560, 200, { label: 'Draft', agentId: quill.id, prompt: 'Write a 200-word briefing on "{{input}}" using these research notes:\n\n{{last}}' });
    const review = n('agent', 810, 200, { label: 'Review', agentId: sentinel.id, prompt: 'Review this briefing. Give a verdict (APPROVE or REVISE) and at most 3 fixes.\n\n{{last}}' });
    const out = n('output', 1060, 200, { label: 'Briefing', template: '## Briefing\n\n{{nodes.' + draft.id + '.output}}\n\n## Review\n\n{{last}}' });
    store.insert('workflows', {
      id: newId('wf'), name: 'Research → Draft → Review', description: 'Atlas researches, Quill drafts, Sentinel reviews.',
      nodes: [start, research, draft, review, out], edges: [e(start, research), e(research, draft), e(draft, review), e(review, out)],
      trigger: { webhook: { enabled: false, token: newId('hook') }, schedule: { enabled: false, everyMinutes: 60 } },
      createdAt: now(), updatedAt: now(),
    });
  }
  // Workflow 2: support triage with a Decide node (Laya → LLM escalation)
  {
    const start = n('trigger', 60, 240, { label: 'Incoming message', sampleInput: 'Hi, we were billed twice for March on invoice #4411. Please refund the duplicate.' });
    const decide = n('decide', 310, 240, {
      label: 'Route', engine: 'auto', question: 'Which team should handle this message?', text: '{{input}}', agentId: sentinel.id, threshold: 0.7,
      options: [
        { label: 'billing', description: 'invoices, payments, refunds, charges' },
        { label: 'technical', description: 'bugs, outages, errors, login problems' },
        { label: 'general', description: 'everything else, questions, feedback' },
      ],
    });
    const billing = n('agent', 600, 90, { label: 'Billing reply', agentId: quill.id, prompt: 'Write a short, kind reply to this billing request. Confirm we will investigate and refund duplicates within 5 business days:\n\n{{input}}' });
    const tech = n('agent', 600, 240, { label: 'Tech triage', agentId: atlas.id, prompt: 'Triage this technical issue: likely cause, 3 troubleshooting steps, and what info to request:\n\n{{input}}' });
    const general = n('agent', 600, 390, { label: 'General reply', agentId: nova.id, prompt: 'Reply helpfully and briefly to:\n\n{{input}}' });
    const out = n('output', 890, 240, { label: 'Reply', template: '[routed to {{nodes.' + decide.id + '.output}}]\n\n{{last}}' });
    store.insert('workflows', {
      id: newId('wf'), name: 'Support triage (Laya)', description: 'Laya routes the message in milliseconds; if unsure it escalates to an LLM. The right agent drafts the reply.',
      nodes: [start, decide, billing, tech, general, out],
      edges: [e(start, decide), e(decide, billing, 'billing'), e(decide, tech, 'technical'), e(decide, general, 'general'), e(billing, out), e(tech, out), e(general, out)],
      trigger: { webhook: { enabled: false, token: newId('hook') }, schedule: { enabled: false, everyMinutes: 60 } },
      createdAt: now(), updatedAt: now(),
    });
  }
  // Web connector is harmless and useful: create it and give it to Atlas.
  const web = { id: newId('con'), pluginId: 'web', name: 'Web', config: { allowedDomains: '', defaultHeaders: '', timeoutMs: 20000, maxChars: 12000 }, enabled: true, createdAt: now() };
  store.insert('connectors', web);
  atlas.connectors = [web.id];
  store.save('agents');
  store.setDoc('meta', { seeded: true, seededAt: now() });
  return true;
}
