import { EventEmitter } from 'node:events';
import { now } from './util.js';

/** In-process event bus with a ring buffer so reconnecting clients can catch up. */
export class Bus extends EventEmitter {
  constructor(size = 2000) {
    super();
    this.setMaxListeners(0);
    this.size = size;
    this.buffer = [];
    this.seq = 0;
  }

  emitEvent(type, data = {}) {
    const evt = { seq: ++this.seq, type, ts: now(), ...data };
    // Streaming deltas are high-volume and only useful live; don't let them evict history.
    if (type !== 'agent.delta') {
      this.buffer.push(evt);
      if (this.buffer.length > this.size) this.buffer.splice(0, this.buffer.length - this.size);
    }
    this.emit('event', evt);
    return evt;
  }

  since(seq) { return this.buffer.filter((e) => e.seq > seq); }
  recent(n = 200, filter) {
    const list = filter ? this.buffer.filter(filter) : this.buffer;
    return list.slice(-n);
  }
}
