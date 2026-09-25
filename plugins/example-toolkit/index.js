/**
 * Example Atrium plugin. Copy this folder, rename it, and change the tools.
 * Atrium loads every folder in plugins/ that has an index.js default-exporting
 * an object with { id, name, create(config) }. Press "Reload plugins" on the
 * Connectors page (or restart) to pick up changes.
 */
export default {
  id: 'example-toolkit',
  name: 'Toolkit (example plugin)',
  description: 'A template plugin with handy offline tools: date & time, maths, random picks, text stats. Copy it to build your own.',
  icon: 'tool',
  category: 'connector',
  configFields: [
    { key: 'timezone', label: 'Timezone', type: 'text', default: 'Australia/Sydney', help: 'IANA timezone for the clock tool.' },
  ],

  // Called when a connector using this plugin starts. Return an instance.
  async create(config) {
    const tz = config.timezone || 'UTC';
    return {
      async listTools() {
        return [
          { name: 'now', description: 'Get the current date and time.', inputSchema: { type: 'object', properties: {} } },
          { name: 'calculate', description: 'Evaluate an arithmetic expression, e.g. "(12.5 * 4) / 3". Supports + - * / % ** and parentheses.', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
          { name: 'pick_random', description: 'Pick a random item from a list.', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] } },
          { name: 'text_stats', description: 'Count words, characters and estimate reading time for a text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        ];
      },
      async callTool(name, args) {
        switch (name) {
          case 'now': return new Date().toLocaleString('en-AU', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
          case 'calculate': {
            const expr = String(args.expression || '');
            if (!/^[\d\s+\-*/%().e]+$/i.test(expr)) throw new Error('Only numbers and + - * / % ( ) are allowed');
            const value = Function(`"use strict"; return (${expr});`)();
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Result is not a finite number');
            return `${expr} = ${value}`;
          }
          case 'pick_random': {
            const items = Array.isArray(args.items) ? args.items : String(args.items || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (!items.length) throw new Error('Give me at least one item');
            return items[Math.floor(Math.random() * items.length)];
          }
          case 'text_stats': {
            const text = String(args.text || '');
            const words = (text.match(/\S+/g) || []).length;
            return { words, characters: text.length, readingMinutes: Math.max(1, Math.round(words / 230)) };
          }
          default: throw new Error(`Unknown tool ${name}`);
        }
      },
      async test() { return { ok: true, message: `Ready · clock set to ${tz}` }; },
      async close() {},
    };
  },
};
