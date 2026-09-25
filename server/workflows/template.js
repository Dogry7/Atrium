/**
 * {{ path }} templating. Paths: input, input.field, last, nodes.<id>.output, nodes.<id>.choice,
 * run.id, now. Objects are JSON-stringified. Unknown paths render as empty string.
 */
export function render(tpl, scope) {
  if (tpl == null) return '';
  return String(tpl).replace(/\{\{\s*([\w.\-[\]]+)\s*\}\}/g, (_, path) => {
    const v = lookup(scope, path);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
  });
}

export function lookup(scope, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = scope;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur === 'string' && p !== 'length') {
      // allow {{input.field}} when input is a JSON string
      try { cur = JSON.parse(cur); } catch { return undefined; }
    }
    cur = cur[p];
  }
  return cur;
}

/** Render every string inside a JSON-ish value. */
export function renderDeep(value, scope) {
  if (typeof value === 'string') {
    // A template that is exactly one {{path}} keeps its raw type (object/number)
    const m = value.match(/^\{\{\s*([\w.\-[\]]+)\s*\}\}$/);
    if (m) { const v = lookup(scope, m[1]); return v === undefined ? '' : v; }
    return render(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, scope)]));
  return value;
}
