/**
 * A2A protocol shapes. Atrium speaks both dialects:
 *   v1.0 — methods SendMessage/GetTask/ListTasks/CancelTask, result {task}|{message},
 *          states TASK_STATE_*, parts without `kind`.
 *   v0.3 — methods message/send, tasks/get, tasks/cancel, objects carry `kind`,
 *          states lowercase ("completed").
 * Internally a Task uses lowercase states.
 */
export const V1_METHODS = { SendMessage: 'send', GetTask: 'get', ListTasks: 'list', CancelTask: 'cancel', GetExtendedAgentCard: 'card' };
export const V03_METHODS = { 'message/send': 'send', 'tasks/get': 'get', 'tasks/list': 'list', 'tasks/cancel': 'cancel', 'agent/getAuthenticatedExtendedCard': 'card' };

export const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  TASK_NOT_FOUND: -32001, TASK_NOT_CANCELABLE: -32002, UNSUPPORTED: -32004,
};

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
export const isTerminal = (state) => TERMINAL.has(normalizeState(state));

/** 'TASK_STATE_COMPLETED' | 'completed' | 'COMPLETED' → 'completed' */
export function normalizeState(s) {
  if (!s) return 'unknown';
  const x = String(s).toLowerCase().replace(/^task_state_/, '').replace(/_/g, '-');
  if (x === 'cancelled') return 'canceled';
  if (x === 'created' || x === 'submitted') return 'submitted';
  return x;
}

export function toV1State(s) {
  const n = normalizeState(s);
  const map = { submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', 'input-required': 'TASK_STATE_INPUT_REQUIRED', 'auth-required': 'TASK_STATE_AUTH_REQUIRED', completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED', rejected: 'TASK_STATE_REJECTED' };
  return map[n] || 'TASK_STATE_UNSPECIFIED';
}

export function isUserRole(role) { return /user/i.test(String(role || 'user')); }

/** Pull plain text out of an A2A message (any dialect). Data parts are JSON-encoded. */
export function messageText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  return (msg.parts || []).map((p) => {
    if (typeof p.text === 'string') return p.text;
    if (p.kind === 'text') return p.text || '';
    if (p.data !== undefined) return '```json\n' + JSON.stringify(p.data, null, 2) + '\n```';
    if (p.file) return `[file: ${p.file.name || p.file.uri || 'attachment'}]`;
    if (p.url || p.raw) return `[file: ${p.filename || p.url || 'attachment'}]`;
    return '';
  }).filter(Boolean).join('\n');
}

export function textPart(text, dialect) {
  return dialect === 'v1' ? { text } : { kind: 'text', text };
}

export function makeMessage({ role, text, messageId, contextId, taskId }, dialect) {
  const m = {
    role: dialect === 'v1' ? (role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER') : role,
    parts: [textPart(text, dialect)],
    messageId,
  };
  if (contextId) m.contextId = contextId;
  if (taskId) m.taskId = taskId;
  if (dialect !== 'v1') m.kind = 'message';
  return m;
}

/** Internal task record → wire Task for the given dialect. */
export function taskToWire(task, dialect, { historyLength } = {}) {
  const hist = (task.history || []).map((h, i) => makeMessage({ role: h.role, text: h.text, messageId: h.messageId || `${task.id}-m${i}`, contextId: task.contextId, taskId: task.id }, dialect));
  const history = historyLength != null ? hist.slice(-historyLength) : hist;
  const statusMsg = task.status.message ? makeMessage({ role: 'agent', text: task.status.message, messageId: `${task.id}-status`, contextId: task.contextId, taskId: task.id }, dialect) : undefined;
  const artifacts = (task.artifacts || []).map((a, i) => {
    const art = { artifactId: a.artifactId || `${task.id}-a${i}`, name: a.name || 'response', parts: [textPart(a.text, dialect)] };
    if (dialect === 'v1') { art.title = art.name; art.mediaType = 'text/plain'; }
    return art;
  });
  if (dialect === 'v1') {
    return {
      id: task.id, contextId: task.contextId,
      status: { state: toV1State(task.status.state), ...(statusMsg ? { message: statusMsg } : {}), timestamp: task.status.timestamp },
      artifacts, history,
      createdTime: task.createdAt, updateTime: task.updatedAt,
      metadata: { agentId: task.agentId, agentName: task.agentName },
    };
  }
  return {
    kind: 'task', id: task.id, contextId: task.contextId,
    status: { state: normalizeState(task.status.state), ...(statusMsg ? { message: statusMsg } : {}), timestamp: task.status.timestamp },
    artifacts, history,
    metadata: { agentId: task.agentId, agentName: task.agentName },
  };
}

/** Extract the agent's reply text from a wire Task/Message result (any dialect). */
export function resultText(result) {
  if (!result) return '';
  const r = result.task || result.message || result;
  if (r.parts) return messageText(r);
  const fromArtifacts = (r.artifacts || []).map((a) => messageText(a)).filter(Boolean).join('\n\n');
  if (fromArtifacts) return fromArtifacts;
  if (r.status?.message) return typeof r.status.message === 'string' ? r.status.message : messageText(r.status.message);
  const lastAgent = [...(r.history || [])].reverse().find((m) => !isUserRole(m.role));
  return lastAgent ? messageText(lastAgent) : '';
}

export function resultTask(result) {
  if (!result) return null;
  if (result.task) return result.task;
  if (result.kind === 'task' || (result.id && result.status)) return result;
  return null;
}
