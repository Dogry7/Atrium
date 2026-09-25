/**
 * What a bot is doing right now, decided from what the agent is doing. Pure, so it is unit-tested.
 *
 * Precedence (first match wins):
 *   visiting  – carrying an A2A message to another bot (walks/runs over, talks, walks home)
 *   error     – its last task failed: slumps, red eyes, `!` badge, until it works again or you look
 *   working   – has an active task: hammers at its habitat, sparks, `⚒` badge
 *   celebrate – just finished a task: cheers, confetti, `✓` badge (a few seconds)
 *   waiting   – replied while you weren't looking at it: waves at you, `?` badge, until you open it
 *   sleeping  – nothing to do for a while: sits by its bench, `z`
 *   potter    – default: wanders its plot, now and then strolls to the hub or a neighbour
 */
export const MODES = ['visiting', 'error', 'working', 'celebrate', 'waiting', 'sleeping', 'potter'];

export const DEFAULTS = {
  celebrateMs: 4200,
  sleepAfterMs: 6 * 60 * 1000,  // idle this long → sits down for a nap
};

export function decide(s, now, cfg = DEFAULTS) {
  if (s.visiting) return 'visiting';
  if (s.errorAt && !(s.lastStartAt > s.errorAt)) return 'error';
  if (s.busy > 0) return 'working';
  if (s.doneAt && now - s.doneAt < cfg.celebrateMs) return 'celebrate';
  if (s.unread) return 'waiting';
  if (now - (s.lastActiveAt || 0) > cfg.sleepAfterMs) return 'sleeping';
  return 'potter';
}

/** The badge over a bot's head, if any, for a mode. */
export const BADGES = {
  error: { icon: '!', label: 'Hit a problem', tone: 'red' },
  working: { icon: '⚒', label: 'Working', tone: 'accent' },
  celebrate: { icon: '✓', label: 'Done', tone: 'green' },
  waiting: { icon: '?', label: 'Replied — waiting for you', tone: 'amber' },
};

/** The animation clip and face for a mode (the renderer maps these to KayKit clips). */
export const LOOK = {
  visiting: { clip: 'walk', face: 'idle' },
  error: { clip: 'error', face: 'error' },
  working: { clip: 'hammer', face: 'focus' },
  celebrate: { clip: 'cheer', face: 'happy' },
  waiting: { clip: 'wave', face: 'happy' },
  sleeping: { clip: 'sleep', face: 'sleep' },
  potter: { clip: 'idle', face: 'idle' },
};

/** Words for the follow card and tooltips. */
export function statusLine(mode, s = {}) {
  switch (mode) {
    case 'visiting': return s.visitName ? `Talking with ${s.visitName}` : 'Visiting a teammate';
    case 'error': return 'Hit a problem on the last task';
    case 'working': return s.detail ? cap(s.detail) : 'Working on a task';
    case 'celebrate': return 'Just finished a task';
    case 'waiting': return 'Replied — open the chat to read it';
    case 'sleeping': return 'Having a nap';
    default: return 'Pottering about';
  }
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
