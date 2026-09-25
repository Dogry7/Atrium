import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny JSON document store. One file per collection, debounced atomic writes.
 * Collections are arrays of objects with an `id`; `docs` are single objects.
 */
export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    this.timers = new Map();
    this.caps = { tasks: 500, runs: 300, events: 0 };
  }

  file(name) { return path.join(this.dir, `${name}.json`); }

  load(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try {
      const raw = fs.readFileSync(this.file(name), 'utf8');
      value = JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep a backup and start fresh rather than crash.
        try { fs.copyFileSync(this.file(name), this.file(name) + `.corrupt-${Date.now()}`); } catch {}
        console.warn(`[store] could not parse ${name}.json (${e.message}); starting fresh`);
      }
    }
    this.cache.set(name, value);
    return value;
  }

  save(name) {
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => this.flushOne(name), 80));
  }

  flushOne(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    let value = this.cache.get(name);
    const cap = this.caps[name];
    if (cap && Array.isArray(value) && value.length > cap) {
      value.splice(0, value.length - cap);
    }
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file(name));
  }

  flush() { for (const name of [...this.timers.keys()]) this.flushOne(name); }

  // ---- collection helpers
  all(name) { return this.load(name, []); }
  get(name, id) { return this.all(name).find((d) => d.id === id); }
  insert(name, doc) { this.all(name).push(doc); this.save(name); return doc; }
  update(name, id, patch) {
    const doc = this.get(name, id);
    if (!doc) return null;
    Object.assign(doc, patch);
    this.save(name);
    return doc;
  }
  remove(name, id) {
    const list = this.all(name);
    const i = list.findIndex((d) => d.id === id);
    if (i === -1) return false;
    list.splice(i, 1);
    this.save(name);
    return true;
  }
  replaceAll(name, list) { this.cache.set(name, list); this.save(name); }

  // ---- single documents
  doc(name, fallback = {}) { return this.load(name, fallback); }
  setDoc(name, value) { this.cache.set(name, value); this.save(name); return value; }
}
