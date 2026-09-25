/** Parse a text/event-stream body from fetch() into {event, data} objects. */
export async function* parseSSE(body, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const evt = parseBlock(raw);
        if (evt) yield evt;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) { const evt = parseBlock(buf); if (evt) yield evt; }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function parseBlock(raw) {
  let event = 'message';
  const data = [];
  let id;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let val = i === -1 ? '' : line.slice(i + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') data.push(val);
    else if (field === 'id') id = val;
  }
  if (!data.length) return null;
  return { event, data: data.join('\n'), id };
}
