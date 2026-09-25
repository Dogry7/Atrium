// The colony's rules: hex layout, plots, habitat growth, walking, behaviour. All pure, no WebGL.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEX, DECK, hexToWorld, worldToHex, hexDistance, hexRing, inHex, PLOT_CELLS, MAX_PLOTS, nextPlot, plotCell, plotLayout,
  levelFor, nextLevelAt, LEVELS, piecesFor, pieceToWorld, PIECES, HUB, relaySpot, PLANETS, PLANET_IDS, TIMES, dayFraction, sunHeight, isNight,
  scatter, ringsFor, walkRadius, colonyObstacles,
} from '../../web/js/world/colony.js';
import { NavGrid } from '../../web/js/world/nav.js';
import { decide, BADGES, LOOK, MODES, statusLine, DEFAULTS } from '../../web/js/world/behaviour.js';
import { nextPlot as serverNextPlot } from '../../server/runtime/agents.js';
import { PLANETS as SERVER_PLANETS, TIMES as SERVER_TIMES } from '../../server/api.js';

describe('hex grid', () => {
  test('axial ↔ world round-trips for every cell in the colony', () => {
    for (const c of [{ q: 0, r: 0 }, ...PLOT_CELLS]) {
      const w = hexToWorld(c.q, c.r);
      assert.deepEqual(worldToHex(w.x, w.z), c);
      // a point just inside a corner still belongs to this cell
      assert.ok(inHex(w.x + HEX * 0.8, w.z, w.x, w.z, HEX));
    }
  });
  test('rings have 6k cells at distance k, and plots are unique', () => {
    for (let k = 1; k <= 4; k++) {
      const ring = hexRing(k);
      assert.equal(ring.length, 6 * k);
      for (const c of ring) assert.equal(hexDistance(c), k);
    }
    assert.equal(MAX_PLOTS, 60);
    assert.equal(new Set(PLOT_CELLS.map((c) => `${c.q},${c.r}`)).size, 60);
    assert.ok(!PLOT_CELLS.some((c) => c.q === 0 && c.r === 0), 'the hub is not a plot');
    // plots past 60 keep spiralling outwards without clashing
    const extra = new Set([...Array(100).keys()].map((i) => { const c = plotCell(i); return `${c.q},${c.r}`; }));
    assert.equal(extra.size, 100);
  });
  test('decks never overlap: the gap between them is the street', () => {
    const a = hexToWorld(0, 0), b = hexToWorld(1, 0);
    const centres = Math.hypot(b.x - a.x, b.z - a.z);
    const flat = DECK * Math.sqrt(3) / 2;
    assert.ok(centres - 2 * flat > 1.8, `street width ${(centres - 2 * flat).toFixed(2)}`);
  });
});

describe('plots', () => {
  test('the server and the client agree on the next free plot, filling gaps first', () => {
    assert.equal(nextPlot([]), 0);
    assert.equal(nextPlot([0, 1, 3]), 2);
    assert.equal(nextPlot([0, 1, 2]), 3);
    assert.equal(serverNextPlot([{ plot: 0 }, { plot: 1 }, { plot: 3 }]), 2);
    assert.equal(serverNextPlot([{ plot: null }, { plot: 0 }]), 1);
  });
  test('a plot faces the hub; its bench, workbench and wander spots are on the deck', () => {
    for (let i = 0; i < 18; i++) {
      const L = plotLayout(i);
      const toHub = Math.atan2(-L.center.x, -L.center.z);
      assert.ok(Math.abs(Math.atan2(Math.sin(L.facing - toHub), Math.cos(L.facing - toHub))) < 1e-9, `plot ${i} faces the hub`);
      for (const p of [L.work, L.bench, L.flag, L.lamp, L.building, ...L.wander]) assert.ok(inHex(p.x, p.z, L.center.x, L.center.z, DECK - 0.2), `plot ${i}: a spot is off the deck`);
    }
  });
  test('ringsFor: how many rings a colony needs', () => {
    assert.equal(ringsFor(0), 1); assert.equal(ringsFor(5), 1); assert.equal(ringsFor(6), 2); assert.equal(ringsFor(17), 2); assert.equal(ringsFor(18), 3);
  });
});

describe('habitats grow as agents finish work', () => {
  test('level thresholds', () => {
    assert.deepEqual([0, 1, 2, 3, 5, 6, 11, 12, 24, 25, 49, 50, 999].map(levelFor), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    assert.equal(nextLevelAt(0), 1); assert.equal(nextLevelAt(4), 6); assert.equal(nextLevelAt(60), null);
    assert.equal(LEVELS.length, PIECES.length);
  });
  test('each level only adds pieces, and every piece stays on its plot', () => {
    let prev = 0;
    for (let l = 0; l < PIECES.length; l++) {
      const p = piecesFor(l);
      assert.ok(p.length > prev, `level ${l} adds something`); prev = p.length;
    }
    for (const i of [0, 7, 23]) {
      const L = plotLayout(i);
      for (const p of piecesFor(6)) {
        const w = pieceToWorld(L, p);
        assert.ok(Math.hypot(w.x - L.center.x, w.z - L.center.z) + w.r * 0.6 < DECK, `plot ${i}: ${p.part} pokes off the deck`);
      }
    }
  });
});

describe('walking', () => {
  const plots = [...Array(12).keys()].map((i) => ({ index: i, level: 6 }));  // fully built colony, worst case
  const rings = 2;
  const grid = new NavGrid({ radius: walkRadius(rings), obstacles: colonyObstacles({ plots, relays: 5, scatterList: scatter('terra', rings) }) });
  test('from the hub, a bot can reach every workbench, bench and hangout (fully built habitats, 5 relays, trees)', () => {
    for (const { index } of plots) {
      const L = plotLayout(index);
      for (const [what, p] of [['work', L.work], ['bench', L.bench], ...L.wander.map((w, k) => [`wander${k}`, w])]) {
        const path = grid.path(HUB.spawn.x, HUB.spawn.z, p.x, p.z);
        assert.ok(path && path.length, `plot ${index} ${what} is reachable`);
        const end = path[path.length - 1];
        assert.ok(Math.hypot(end.x - p.x, end.z - p.z) < 1.2, `plot ${index} ${what}: path ends ${Math.hypot(end.x - p.x, end.z - p.z).toFixed(2)} away`);
      }
    }
    for (const h of [...HUB.hangouts, ...HUB.visitorSpots]) assert.ok(grid.path(HUB.spawn.x, HUB.spawn.z, h.x, h.z), 'hub spot reachable');
  });
  test('paths never cross an obstacle (string-pulled segments stay in free space)', () => {
    const a = plotLayout(0).work, b = plotLayout(9).work;
    const path = grid.path(a.x, a.z, b.x, b.z);
    assert.ok(path, 'found a path');
    let prev = a;
    for (const p of path) { assert.ok(grid.clear(prev.x, prev.z, p.x, p.z) || prev === a, 'segment is clear'); prev = p; }
    assert.ok(path.length < 12, `smoothed to ${path.length} corners`);
  });
  test('habitats and relays are solid', () => {
    const L = plotLayout(3);
    assert.equal(grid.freeAt(L.building.x, L.building.z), false, 'cannot walk through a habitat');
    const r = relaySpot(0, 5);
    assert.equal(grid.freeAt(r.x, r.z), false, 'cannot walk through a relay tower');
    assert.equal(grid.freeAt(HUB.lander.x, HUB.lander.z), false, 'cannot walk through the lander');
  });
});

describe('behaviour', () => {
  const now = 1_000_000;
  const base = { busy: 0, errorAt: 0, lastStartAt: 0, doneAt: 0, unread: false, lastActiveAt: now, visiting: null };
  test('precedence: visiting > error > working > celebrate > waiting > sleeping > potter', () => {
    assert.equal(decide({ ...base }, now), 'potter');
    assert.equal(decide({ ...base, lastActiveAt: now - DEFAULTS.sleepAfterMs - 1 }, now), 'sleeping');
    assert.equal(decide({ ...base, unread: true, lastActiveAt: 0 }, now), 'waiting');
    assert.equal(decide({ ...base, unread: true, doneAt: now - 100 }, now), 'celebrate');
    assert.equal(decide({ ...base, unread: true, doneAt: now - DEFAULTS.celebrateMs - 1 }, now), 'waiting');
    assert.equal(decide({ ...base, busy: 1, unread: true, doneAt: now }, now), 'working');
    assert.equal(decide({ ...base, busy: 1, errorAt: now - 10, lastStartAt: now - 100 }, now), 'error');
    assert.equal(decide({ ...base, busy: 1, errorAt: now - 100, lastStartAt: now - 10 }, now), 'working', 'a new task clears the error');
    assert.equal(decide({ ...base, busy: 1, errorAt: now, visiting: { toId: 'x' } }, now), 'visiting');
  });
  test('every mode has a look; badges only for the ones that need attention', () => {
    for (const m of MODES) { assert.ok(LOOK[m], m); assert.equal(typeof statusLine(m, {}), 'string'); }
    assert.deepEqual(Object.keys(BADGES).sort(), ['celebrate', 'error', 'waiting', 'working']);
    assert.equal(statusLine('visiting', { visitName: 'Atlas' }), 'Talking with Atlas');
    assert.equal(statusLine('working', { detail: 'talking with Nova' }), 'Talking with Nova');
  });
});

describe('planets and time', () => {
  test('server and client agree on planets and times', () => {
    assert.deepEqual(PLANET_IDS, SERVER_PLANETS);
    assert.deepEqual(TIMES, SERVER_TIMES);
    for (const p of Object.values(PLANETS)) for (const k of ['ground', 'sky', 'fog', 'deck', 'kerb', 'street', 'scatter']) assert.ok(p[k], `${p.id}.${k}`);
  });
  test('day fraction: fixed times, live follows the clock, night is dark', () => {
    assert.ok(isNight(dayFraction('night')));
    assert.ok(!isNight(dayFraction('day')));
    assert.ok(sunHeight(dayFraction('day')) > 0.9);
    assert.ok(Math.abs(sunHeight(dayFraction('dawn'))) < 0.15 && Math.abs(sunHeight(dayFraction('dusk'))) < 0.15);
    assert.equal(dayFraction('live', new Date(2026, 0, 1, 12, 0, 0)), 0.5);
    assert.equal(dayFraction('live', new Date(2026, 0, 1, 6, 0, 0)), 0.25);
  });
  test('scatter is deterministic and never lands on a deck', () => {
    for (const id of PLANET_IDS) {
      const a = scatter(id, 2), b = scatter(id, 2);
      assert.deepEqual(a, b);
      assert.ok(a.length > 100);
      for (const s of a) {
        const h = worldToHex(s.x, s.z); const c = hexToWorld(h.q, h.r);
        if (hexDistance(h) <= 2) assert.ok(!inHex(s.x, s.z, c.x, c.z, DECK), `${id}: ${s.part} on a deck at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);
      }
    }
  });
});
