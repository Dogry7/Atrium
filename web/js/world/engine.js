import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { Robot } from './robot.js';
import { Sky } from './sky.js';
import { Land } from './land.js';
import { Effects } from './fx.js';
import { CameraRig } from './camera.js';
import { Overlay } from './overlay.js';
import { NavGrid } from './nav.js';
import { decide, BADGES, statusLine, DEFAULTS } from './behaviour.js';
import { HUB, DECK_H, plotLayout, levelFor, ringsFor, walkRadius, colonyObstacles, dayFraction, PLANETS, MAX_PLOTS } from './colony.js';
import { looks, hashCode } from './character.js';

/**
 * The 3D colony. Same public surface the page has always used, so the page and the tests talk
 * to it the same way: sync(agents, busy, connectors), handle(event), select/focusOn/zoomBy/fit.
 */
const rand = (a, b) => a + Math.random() * (b - a);
const V = () => new THREE.Vector3();

export class WorldEngine {
  constructor(canvas, { onSelect, onHover, onOpen, onVacant, planet = 'terra', time = 'live', quality = 'auto', overlayParent } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect; this.onHover = onHover; this.onOpen = onOpen; this.onVacant = onVacant;
    this.planet = PLANETS[planet] ? planet : 'terra';
    this.timeSetting = time; this.quality = quality;
    this.agents = new Map(); this.visitors = new Map();
    this.selected = null; this.hovered = null; this.showNames = true;
    this.cfg = { ...DEFAULTS };
    this.pageLoad = Date.now();
    this.loaded = false; this.progress = 0; this.error = null;

    // --- three
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = quality !== 'low'; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.maxDpr = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.75);
    this.dpr = quality === 'low' ? Math.min(1, this.maxDpr) : this.maxDpr;
    // 'auto' remembers what this machine could handle last time, so a slow laptop doesn't stutter on every visit
    if (quality === 'auto') {
      try {
        const g = JSON.parse(localStorage.getItem('atrium.gfx') || 'null');
        if (g && g.maxDpr === this.maxDpr && Date.now() - (g.at || 0) < 3 * 86400e3) { this.dpr = g.dpr; if (g.shadowsOff) { renderer.shadowMap.enabled = false; this.shadowsOff = true; } this.minFrameMs = g.minFrameMs || 0; }
      } catch { /* private mode: learn again */ }
    }
    renderer.setPixelRatio(this.dpr);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2600);
    this.sky = new Sky(this.scene); this.sky.setPlanet(this.planet);
    this.fx = new Effects(this.scene);
    this.rig = new CameraRig(this.camera, canvas);
    this.overlay = new Overlay(overlayParent || canvas.parentElement);
    this.ray = new THREE.Raycaster();
    this.#bindInput();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement);
    this.rig.set(new THREE.Vector3(0, 0, 0), 62, { az: Math.PI / 4, tilt: 0.92, instant: true });

    this.pending = null;
    this.ready = loadAssets((p) => { this.progress = p; }).then((kits) => {
      if (this.destroyed) return;
      this.kits = kits;
      this.land = new Land(this.scene, kits);
      this.loaded = true;
      if (this.pending) { const [a, b, c] = this.pending; this.pending = null; this.sync(a, b, c); } else this.#layout();
      this.home(true);
    }).catch((e) => { this.error = `Couldn't load the world: ${e.message}`; console.error(e); });

    this.running = true; this.last = performance.now(); this.t = 0; this.frames = 0; this.fpsAcc = 0; this.fps = 60; this.slow = 0; this.fast = 0;
    requestAnimationFrame(this.#loop);
  }

  destroy() {
    this.destroyed = true; this.running = false;
    this.ro?.disconnect(); this.rig.unbind?.(); this.unbind?.(); this.overlay.destroy();
    for (const e of [...this.agents.values(), ...this.visitors.values()]) e.robot.dispose();
    this.renderer.dispose();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h; this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ camera helpers
  #rings() { let max = 0; for (const e of this.agents.values()) max = Math.max(max, e.plot); return ringsFor(max); }
  /** Camera distance that frames the colony's rings (scale > 1 = more room). */
  #frameDist(scale) {
    const R = walkRadius(this.#rings());
    const fovV = THREE.MathUtils.degToRad(this.camera.fov), fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
    const need = R * scale;
    return Math.max(need / Math.tan(fovH / 2), need * 0.62 / Math.tan(fovV / 2));
  }
  fit() { this.rig.set(new THREE.Vector3(0, 0, 0), this.#frameDist(1.15), { tilt: 0.8 }); this.rig.orbit = false; this.rig.moved = false; }
  home(instant = false) { this.rig.set(new THREE.Vector3(0, 0, 2), this.#frameDist(0.78), { az: Math.PI / 4, tilt: 0.66, instant }); this.rig.moved = false; }
  zoomBy(f) { this.rig.zoomBy(f); }
  toggleOrbit() { this.rig.orbit = !this.rig.orbit; return this.rig.orbit; }
  focusOn(id) {
    const e = this.agents.get(id) || this.visitors.get(id); if (!e) return;
    this.rig.set(new THREE.Vector3(e.x, 0, e.z), Math.min(this.rig.want.dist, 30));
    this.rig.moved = true;
  }
  /** Screen point (CSS px) for a world point, and whether it's in front of the camera. */
  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, visible: p.z < 1 && p.z > -1 };
  }

  // ------------------------------------------------------------------ planet & time
  setPlanet(id) {
    if (!PLANETS[id] || id === this.planet) return false;
    this.planet = id; this.sky.setPlanet(id);
    if (this.loaded) this.#layout(true);
    return true;
  }
  setTime(setting) { this.timeSetting = setting; this.dayT = null; }
  get timeFraction() { return dayFraction(this.timeSetting); }

  // ------------------------------------------------------------------ roster
  sync(agents, busy = {}, connectors = []) {
    if (!this.loaded) { this.pending = [agents, busy, connectors]; return; }
    const seen = new Set();
    const now = performance.now();
    for (const a of agents) {
      seen.add(a.id);
      let e = this.agents.get(a.id);
      const L = looks(a);
      if (!e) {
        const fresh = this.initialized;
        const plot = Number.isInteger(a.plot) ? a.plot : this.#fallbackPlot();
        const layout = plotLayout(plot);
        const start = fresh ? { ...HUB.spawn } : { x: layout.work.x + rand(-0.8, 0.8), z: layout.work.z + rand(-0.8, 0.8) };
        const robot = new Robot(this.kits, L);
        this.scene.add(robot.root);
        e = {
          id: a.id, agent: a, L, robot, plot, layout, x: start.x, z: start.z, heading: layout.facing, path: [], moving: false,
          mode: null, s: { busy: 0, errorAt: 0, lastStartAt: 0, doneAt: 0, unread: false, lastActiveAt: Math.max(this.pageLoad, Date.parse(a.stats?.lastActiveAt || 0) || 0), visiting: null },
          nextIdle: now + rand(800, 4000), idleClip: 'idle', sitting: false, arrived: !fresh, level: levelFor(a.stats?.tasks), sparkAt: 0,
        };
        robot.root.position.set(e.x, DECK_H, e.z);
        this.agents.set(a.id, e);
        if (fresh) {
          this.land.landerArrive(); this.fx.poof(V().set(e.x, DECK_H + 0.4, e.z), L.color);
          e.spawning = true;
          robot.play('spawn', { then: () => { e.spawning = false; e.arrived = true; this.#goto(e, e.layout.work, () => { e.nextIdle = performance.now() + 1500; }); } });
        }
      }
      e.agent = a;
      if (e.L.color !== L.color || e.L.hair !== L.hair || e.L.accessory !== L.accessory || e.L.skin !== L.skin || e.L.hairColor !== L.hairColor) {
        if (e.L.hair !== L.hair || e.L.accessory !== L.accessory) {
          const old = e.robot; const r = new Robot(this.kits, L); r.root.position.copy(old.root.position); r.root.rotation.copy(old.root.rotation);
          this.scene.remove(old.root); old.dispose(); this.scene.add(r.root); e.robot = r; e.mode = null;
        } else e.robot.recolor(L);
        e.L = L;
      }
      if (Number.isInteger(a.plot) && a.plot !== e.plot) { e.plot = a.plot; e.layout = plotLayout(a.plot); this.#goto(e, e.layout.work); }
      e.s.busy = busy[a.id] || 0;
      const lvl = levelFor(a.stats?.tasks);
      if (lvl !== e.level) { e.level = lvl; e.levelUp = true; }
    }
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) {
      const e = this.agents.get(id);
      this.fx.poof(V().set(e.x, DECK_H + 0.6, e.z), e.L.color, 50);
      this.scene.remove(e.robot.root); e.robot.dispose(); this.overlay.remove(id);
      this.land.removePlot(id);
      this.agents.delete(id);
      if (this.selected === id) this.selected = null;
    }
    // remote A2A agents are visitors by the lander; other connectors are relay towers round the hub
    this.layaConnector = connectors.find((c) => c.pluginId === 'laya');
    this.land.setRelays(connectors.filter((c) => c.pluginId !== 'a2a-remote' && c.pluginId !== 'laya'));
    const seenV = new Set();
    for (const c of connectors.filter((x) => x.pluginId === 'a2a-remote')) {
      seenV.add(c.id);
      let v = this.visitors.get(c.id);
      const name = c.info?.card?.name || c.name;
      if (!v) {
        const h = hashCode(c.id);
        const L = { color: '#8b93a8', skin: '#dfe6f2', hairColor: '#ffc65c', hair: 'none', accessory: ['headset', 'none', 'glasses'][h % 3] };
        const robot = new Robot(this.kits, L, { visitor: true });
        this.scene.add(robot.root);
        const spot = HUB.visitorSpots[this.visitors.size % HUB.visitorSpots.length];
        v = { id: c.id, visitor: true, agent: { id: c.id, name }, L, robot, x: HUB.lander.x + 0.4, z: HUB.lander.z + 1.7, heading: 0, path: [], spot, s: {}, hidden: 0 };
        robot.root.position.set(v.x, DECK_H, v.z);
        this.visitors.set(c.id, v);
        if (this.initialized) { this.land.landerArrive(); v.hidden = 2.2; robot.root.visible = false; }
        this.#goto(v, spot);
      }
      v.agent.name = name; v.status = c.status;
    }
    for (const [id, v] of [...this.visitors]) if (!seenV.has(id)) { this.scene.remove(v.robot.root); v.robot.dispose(); this.overlay.remove(id); this.visitors.delete(id); }
    this.#layout();
    this.initialized = true;
  }

  #fallbackPlot() {
    const taken = new Set([...this.agents.values()].map((e) => e.plot));
    for (let i = 0; i < MAX_PLOTS; i++) if (!taken.has(i)) return i;
    return taken.size;
  }

  /** Plots, habitats, planet ring size, vacant lots and the walking grid. */
  #layout(force = false) {
    if (!this.loaded) return;
    const rings = this.#rings();
    this.land.setPlanet(this.planet, rings);
    for (const e of this.agents.values()) {
      const pv = this.land.ensurePlot(e.agent, e.level);
      if (e.levelUp) {
        e.levelUp = false;
        if (this.initialized) this.fx.confetti(V().set(pv.layout.building.x, DECK_H + 2.4, pv.layout.building.z), 90);
      }
    }
    const used = new Set([...this.agents.values()].map((e) => e.plot));
    const ringCount = 3 * rings * (rings + 1);
    const vacant = []; for (let i = 0; i < ringCount; i++) if (!used.has(i)) vacant.push(i);
    this.land.setVacant(vacant);
    const key = JSON.stringify([rings, this.planet, [...this.agents.values()].map((e) => [e.plot, e.level]).sort(), this.land.relays.size]);
    if (key !== this.navKey || force) {
      this.navKey = key;
      this.nav = new NavGrid({
        radius: walkRadius(rings),
        obstacles: colonyObstacles({ plots: [...this.agents.values()].map((e) => ({ index: e.plot, level: e.level })), relays: this.land.relays.size, scatterList: this.land.scatterList }),
      });
      for (const e of [...this.agents.values(), ...this.visitors.values()]) {
        if (!this.nav.freeAt(e.x, e.z)) { const f = this.nav.nearestFree(e.x, e.z); if (f) { e.x = f.x; e.z = f.z; } }
        if (e.path.length && e.dest) this.#goto(e, e.dest, e.onArrive, e.run);
      }
    }
  }

  // ------------------------------------------------------------------ movement
  #goto(e, target, then, run = false) {
    e.dest = { x: target.x, z: target.z }; e.onArrive = then || null; e.run = run;
    e.sitting = false;
    const path = this.nav ? this.nav.path(e.x, e.z, target.x, target.z) : [{ x: target.x, z: target.z }];
    if (!path) { e.path = []; e.x = target.x; e.z = target.z; this.#arrive(e); return; }
    e.path = path;
    if (!path.length) this.#arrive(e);
  }
  #arrive(e) { const cb = e.onArrive; e.onArrive = null; e.dest = null; cb?.(); }

  #step(e, dt) {
    if (!e.path.length || e.spawning) { e.moving = false; return; }
    const n = e.path[0];
    const dx = n.x - e.x, dz = n.z - e.z, d = Math.hypot(dx, dz);
    const sp = (e.run ? 3.3 : 1.55) * dt;
    if (d > 0.001) e.targetHeading = Math.atan2(dx, dz);
    if (d <= sp) { e.x = n.x; e.z = n.z; e.path.shift(); if (!e.path.length) { e.moving = false; this.#arrive(e); return; } }
    else { e.x += (dx / d) * sp; e.z += (dz / d) * sp; }
    e.moving = true;
  }

  #face(e, x, z) { e.targetHeading = Math.atan2(x - e.x, z - e.z); }

  // ------------------------------------------------------------------ behaviour
  #think(e, now) {
    const r = e.robot;
    if (e.visitor) {
      const clip = e.path.length ? 'walk' : 'idle';
      if (r.clip !== clip) r.play(clip);
      r.setFace(e.status === 'error' ? 'error' : e.bubbleThink ? 'think' : 'idle');
      if (!e.path.length) e.targetHeading = Math.atan2(-e.x, -e.z) + Math.PI;
      return;
    }
    const mode = decide(e.s, Date.now(), this.cfg);
    if (mode !== e.mode) this.#enter(e, mode, e.mode);
    e.mode = mode;
    if (e.spawning || !e.arrived) return;
    if (e.moving) {
      const clip = e.run ? 'run' : 'walk';
      if (r.clip !== clip) r.play(clip, { fade: 0.2 });
      if (mode !== 'working') r.setFace('idle');
      return;
    }
    switch (mode) {
      case 'visiting': {
        const to = this.agents.get(e.s.visiting?.toId);
        const v = e.visits?.[0];
        if (!to || (v?.giveUpAt && Date.now() > v.giveUpAt && v.reply == null)) { e.visits?.shift(); this.#startVisit(e); break; }
        if (to) this.#face(e, to.x, to.z);
        const clip = e.talking ? 'interact' : 'idle';
        if (r.clip !== clip && r.clip !== 'wave') r.play(clip);
        r.setFace(e.talking ? 'talk' : 'idle');
        break;
      }
      case 'error':
        if (r.clip !== 'hit' && r.clip !== 'idle2') r.play('hit', { then: () => r.play('idle2', { fade: 0.4 }) });
        r.setFace('error');
        break;
      case 'working': {
        const w = e.layout.work;
        if (Math.hypot(e.x - w.x, e.z - w.z) > 0.45) { if (!e.dest || !e.run) this.#goto(e, w, null, true); break; }
        this.#face(e, e.layout.building.x, e.layout.building.z);
        const clip = e.typing && now < e.typing ? 'work' : 'hammer';
        if (r.clip !== clip) r.play(clip, { fade: 0.35 });
        r.setFace(e.thinking ? 'think' : 'focus');
        if (clip === 'hammer' && now > e.sparkAt) { e.sparkAt = now + rand(380, 900); this.fx.sparks(r.handWorld(V()), 8); }
        this.land.setBuilding(e.id, true);
        break;
      }
      case 'celebrate':
        if (r.clip !== 'cheer' && r.clip !== 'jump') r.play('cheer');
        r.setFace('happy');
        break;
      case 'waiting': {
        const spot = e.layout.wander[0];
        if (!e.waveSpot) { e.waveSpot = true; this.#goto(e, spot); break; }
        e.targetHeading = Math.atan2(this.camera.position.x - e.x, this.camera.position.z - e.z);
        if (r.clip !== 'wave') r.play('wave');
        r.setFace('happy');
        break;
      }
      case 'sleeping': {
        const b = e.layout.bench;
        const seat = { x: b.x + Math.sin(e.layout.facing) * 0.95, z: b.z + Math.cos(e.layout.facing) * 0.95 };
        if (!e.sitting) {
          if (Math.hypot(e.x - seat.x, e.z - seat.z) > 0.45) { if (!e.dest) this.#goto(e, seat); break; }
          e.sitting = true; e.targetHeading = e.layout.facing;
          r.play('sitDown', { then: () => r.play('sit', { fade: 0.3 }) });
        }
        r.setFace('sleep');
        if (now > (e.zAt || 0)) { e.zAt = now + 1300; this.fx.zzz(r.headTop(V()).add(V().set(0.2, 0.1, 0))); }
        break;
      }
      default: { // potter
        if (now < e.nextIdle) {
          if (!['idle', 'idle2', 'interact', 'work'].includes(r.clip)) r.play(e.idleClip);
          r.setFace('idle');
          break;
        }
        const roll = Math.random();
        let target;
        if (roll < 0.62) target = e.layout.wander[Math.floor(Math.random() * e.layout.wander.length)];
        else if (roll < 0.8) target = HUB.hangouts[Math.floor(Math.random() * HUB.hangouts.length)];
        else {
          const others = [...this.agents.values()].filter((o) => o !== e);
          target = others.length ? others[Math.floor(Math.random() * others.length)].layout.wander[1] : e.layout.work;
        }
        e.nextIdle = Infinity;
        this.#goto(e, target, () => {
          e.idleClip = ['idle', 'idle', 'idle2', 'interact', 'work'][Math.floor(Math.random() * 5)];
          e.nextIdle = performance.now() + rand(4000, 11000);
        });
      }
    }
  }

  #enter(e, mode, prev) {
    const r = e.robot;
    if (prev === 'sleeping' && e.sitting) { e.sitting = false; e.spawning = true; r.play('standUp', { then: () => { e.spawning = false; } }); }
    if (prev === 'working') this.land.setBuilding(e.id, false);
    if (prev === 'waiting') e.waveSpot = false;
    if (prev === 'visiting') e.talking = false;
    if (mode === 'celebrate' && !e.spawning) { this.fx.confetti(r.headTop(V()).add(V().set(0, 0.4, 0)), 50); if (!e.moving) r.play('jump', { then: () => r.play('cheer') }); }
    if (mode === 'error') this.fx.sparks(r.headTop(V()), 14, '#ff4f5e');
    if (mode === 'potter' && prev && prev !== 'potter') {
      e.nextIdle = performance.now() + rand(1500, 4000);
      if (prev === 'visiting' || !this.#onPlot(e)) this.#goto(e, e.layout.work);
    }
    if (mode !== 'sleeping' && e.dest && prev === 'sleeping') e.dest = null;
  }
  #onPlot(e) { return Math.hypot(e.x - e.layout.center.x, e.z - e.layout.center.z) < 5.5; }

  // ------------------------------------------------------------------ events from the server
  say(id, text, opts) { this.overlay.say(id, text, opts); }

  handle(ev) {
    if (!this.loaded) return;
    const now = performance.now();
    const e = ev.agentId ? this.agents.get(ev.agentId) : null;
    switch (ev.type) {
      case 'agent.status': {
        if (!e) break;
        const was = e.s.busy;
        e.s.busy = ev.active || 0;
        e.detail = ev.detail;
        if (e.s.busy > 0 && !was) { e.s.lastStartAt = Date.now(); e.s.errorAt = 0; }
        e.s.lastActiveAt = Date.now();
        if (!e.s.busy) { e.thinking = false; this.overlay.clear(e.id, 'think'); }
        break;
      }
      case 'agent.thinking': if (e) { e.thinking = true; this.say(e.id, '…', { kind: 'think', ms: 60000 }); } break;
      case 'agent.delta': if (e) { e.typing = now + 900; if (e.thinking) { e.thinking = false; this.overlay.clear(e.id, 'think'); } } break;
      case 'agent.tool': {
        if (!e || ev.phase !== 'start' || ev.tool === 'message_agent') break;
        const nice = ev.tool.split('__').pop().replace(/_/g, ' ');
        this.say(e.id, `${ev.connectorName ? ev.connectorName + ' · ' : ''}${nice}`, { kind: 'tool', ms: 2600 });
        if (ev.connectorId) this.#beamToConnector(e, ev.connectorId, ev.pluginId);
        if (ev.tool === 'remember' || ev.tool === 'recall') this.fx.sparks(e.robot.headTop(V()), 16, '#f5b83d');
        break;
      }
      case 'connector.call': if (ev.pluginId === 'laya') { this.land.pulseLaya(); this.orbText = 'deciding…'; this.orbUntil = now + 3000; } break;
      case 'connector.result': {
        if (ev.tool === 'decide' || ev.tool === 'laya_decide') { this.land.pulseLaya(); this.orbText = ev.preview || (ev.ok ? 'decided' : 'error'); this.orbUntil = now + 4500; }
        const v = this.visitors.get(ev.connectorId);
        if (v) { v.bubbleThink = false; this.overlay.clear(v.id, 'think'); if (ev.ok && ev.preview) this.say(v.id, ev.preview, { ms: 5000 }); }
        break;
      }
      case 'a2a.message': {
        const from = this.agents.get(ev.fromId), to = this.agents.get(ev.toId);
        if (!from || !to) break;
        if (ev.kind === 'request') {
          // the asker walks over with the message; visits queue up so every handoff is seen
          (from.visits ||= []).push({ toId: to.id, name: to.agent.name, text: ev.text, reply: null, arrived: false });
          from.s.lastActiveAt = Date.now();
          if (from.visits.length === 1) this.#startVisit(from);
          this.say(to.id, '!', { kind: 'alert', ms: 1600 });
        } else {
          // the answer: from = the teammate answering, to = the bot that asked
          const v = to.visits?.find((x) => x.toId === from.id && x.reply == null);
          if (!v) { this.say(from.id, ev.text, { ms: 6000 }); break; }
          v.reply = ev.text;
          if (v.arrived) this.#showReply(to, v);
        }
        break;
      }
      case 'agent.reply': {
        if (!e) break;
        this.overlay.clear(e.id, 'think'); e.thinking = false;
        if (ev.from?.type !== 'agent') this.say(e.id, ev.text, { ms: 5500 });
        e.s.doneAt = Date.now(); e.s.lastActiveAt = Date.now();
        if (ev.from?.type === 'user' && this.selected !== e.id) e.s.unread = true;
        this.fx.ring(V().set(e.x, DECK_H + 0.15, e.z), '#2fd18b');
        if (ev.stats) { e.agent = { ...e.agent, stats: ev.stats }; const l = levelFor(ev.stats.tasks); if (l !== e.level) { e.level = l; e.levelUp = true; this.#layout(); } }
        break;
      }
      case 'agent.error': {
        if (!e) break;
        this.overlay.clear(e.id, 'think'); e.thinking = false;
        const cancelled = ev.error === 'Cancelled';
        this.say(e.id, cancelled ? 'Stopped.' : 'Hit a problem', { kind: cancelled ? 'speech' : 'error', ms: 5000 });
        if (!cancelled) e.s.errorAt = Date.now();
        break;
      }
      case 'agent.memory': if (e) this.fx.sparks(e.robot.headTop(V()), 16, '#f5b83d'); break;
      case 'task.updated': {
        const a = this.agents.get(ev.task.agentId);
        if (a && ev.task.status.state !== 'working') { this.overlay.clear(a.id, 'think'); a.thinking = false; }
        break;
      }
      default: break;
    }
  }

  #startVisit(e) {
    const v = e.visits?.[0];
    if (!v) { e.s.visiting = null; e.talking = false; return; }
    const to = this.agents.get(v.toId);
    if (!to) { e.visits.shift(); this.#startVisit(e); return; }
    e.s.visiting = { toId: to.id, name: to.agent.name };
    e.talking = false;
    // stand beside the teammate's workbench (that's where they'll be working)
    const w = to.layout.work, c = to.layout.center;
    const side = { x: w.x + (c.x - w.x) * 0.3 + Math.cos(to.layout.facing) * 1.5, z: w.z + (c.z - w.z) * 0.3 - Math.sin(to.layout.facing) * 1.5 };
    this.#goto(e, side, () => {
      v.arrived = true; e.talking = true; v.giveUpAt = Date.now() + 60000;
      this.#face(e, to.x, to.z);
      e.robot.play('interact');
      this.say(e.id, v.text, { ms: 5200 });
      this.fx.beam((o) => e.robot.headTop(o), (o) => to.robot.headTop(o), { color: e.L.color, kind: 'link', dur: 1.6, arc: 1.2 });
      if (v.reply != null) setTimeout(() => this.#showReply(e, v), 1700);
    }, true);
  }

  #showReply(e, v) {
    const to = this.agents.get(v.toId);
    if (to && this.agents.has(e.id)) {
      this.say(to.id, v.reply, { ms: 6000 });
      this.fx.beam((o) => to.robot.headTop(o), (o) => e.robot.headTop(o), { color: to.L.color, kind: 'link', dur: 1.6, arc: 1.2 });
    }
    setTimeout(() => {
      if (!this.agents.has(e.id) || e.visits?.[0] !== v) return;
      e.visits.shift(); e.talking = false;
      if (e.visits.length) this.#startVisit(e); else { e.s.visiting = null; e.robot.play('wave'); }
    }, 2000);
  }

  #beamToConnector(e, connectorId, pluginId) {
    const from = (v) => e.robot.headTop(v);
    const v = this.visitors.get(connectorId);
    if (v) { this.fx.beam(from, (o) => v.robot.headTop(o), { color: '#e858a8', kind: 'beam' }); v.bubbleThink = true; this.say(v.id, '…', { kind: 'think', ms: 2500 }); return; }
    if (pluginId === 'laya') { this.fx.beam(from, (o) => this.land.layaPoint(o), { color: '#f5b83d', kind: 'beam', arc: 3 }); this.land.pulseLaya(); return; }
    if (!this.land.relayPoint(connectorId)) return;
    this.fx.beam(from, (o) => this.land.relayPoint(connectorId, o), { color: pluginId === 'web' ? '#3ba7ff' : '#22c3a6', kind: 'beam', arc: 3 });
    this.land.pulseRelay(connectorId);
  }

  select(id) {
    this.selected = id;
    const e = id && this.agents.get(id);
    if (e) { e.s.unread = false; if (e.s.errorAt) e.s.errorAt = 0; }
  }

  // ------------------------------------------------------------------ frame
  #loop = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this.#loop);
    // on machines that can't keep up, draw less often so the rest of the app stays responsive
    if (this.minFrameMs && now - this.last < this.minFrameMs) return;
    const real = Math.min(0.5, (now - this.last) / 1000);
    this.last = now;
    this.#perf(real);
    if (document.hidden) return;
    // simulate in small steps so a slow frame never slows the colony's clock
    let left = real;
    while (left > 1e-4) { const dt = Math.min(0.05, left); left -= dt; this.t += dt; this.#update(dt, now - left * 1000); }
    this.rig.update(real);
    this.renderer.render(this.scene, this.camera);
    this.#overlay(now);
    this.frames++;
  };

  #perf(dt) {
    this.fpsAcc += dt; this.fpsN = (this.fpsN || 0) + 1;
    if (this.fpsAcc < 1) return;
    this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0;
    if (this.quality !== 'auto' || !this.loaded) return;
    if (this.fps < 32) { this.slow++; this.fast = 0; } else if (this.fps > 55) { this.fast++; this.slow = 0; } else { this.slow = 0; this.fast = 0; }
    const before = `${this.dpr}|${this.shadowsOff}|${this.minFrameMs}`;
    // last resort for machines without a real GPU: leave the main thread at least half of each frame
    if (this.slow >= 2 && this.shadowsOff && this.dpr <= 0.6 && this.fps < 12) {
      const want = Math.min(1000, Math.max(250, Math.round(2000 / Math.max(1, this.fps))));
      if (want > (this.minFrameMs || 0) * 1.2) this.minFrameMs = want;
      this.slow = 0;
    }
    if (this.slow >= 2 && this.dpr <= 0.6 && this.renderer.shadowMap.enabled && this.fps < 20) {
      // still struggling at the lowest resolution: drop shadows too
      this.renderer.shadowMap.enabled = false; this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); this.slow = 0; this.shadowsOff = true;
    }
    if (this.slow >= 2 && this.dpr > 0.6) { this.dpr = Math.max(0.6, this.dpr - 0.25); this.renderer.setPixelRatio(this.dpr); this.resize(); this.slow = 0; }
    if (this.fast >= 4 && this.dpr < this.maxDpr) { this.dpr = Math.min(this.maxDpr, this.dpr + 0.25); this.renderer.setPixelRatio(this.dpr); this.resize(); this.fast = 0; }
    if (`${this.dpr}|${this.shadowsOff}|${this.minFrameMs}` !== before) {
      try { localStorage.setItem('atrium.gfx', JSON.stringify({ at: Date.now(), maxDpr: this.maxDpr, dpr: this.dpr, shadowsOff: !!this.shadowsOff, minFrameMs: this.minFrameMs || 0 })); } catch { /* fine */ }
    }
  }

  #update(dt, now) {
    if (this.dayT == null || now - (this.skyAt || 0) > 500) { this.dayT = dayFraction(this.timeSetting); this.skyAt = now; }
    this.sky.update(this.dayT, this.t, { x: this.rig.target.x, z: this.rig.target.z });
    if (!this.loaded) return;
    const night = this.sky.night;
    for (const e of this.agents.values()) {
      this.#step(e, dt);
      this.#think(e, now);
      this.#pose(e, dt);
      e.robot.update(dt, now);
      e.robot.ring.visible = this.selected === e.id || this.hovered === e.id;
      e.robot.ring.material.opacity = this.selected === e.id ? 0.9 : 0.4;
      e.robot.mat.glow.emissiveIntensity *= 0.7 + night * 0.6;
    }
    for (const v of this.visitors.values()) {
      if (v.hidden > 0) { v.hidden -= dt; if (v.hidden <= 0) { v.robot.root.visible = true; this.fx.poof(V().set(v.x, DECK_H + 0.5, v.z), '#ffc65c'); } else continue; }
      this.#step(v, dt); this.#think(v, now); this.#pose(v, dt); v.robot.update(dt, now);
      v.robot.ring.visible = this.hovered === v.id;
    }
    this.land.update(dt, night, now);
    this.fx.update(dt);
  }

  #pose(e, dt) {
    if (e.targetHeading != null) {
      let d = e.targetHeading - e.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      e.heading += d * Math.min(1, dt * 9);
    }
    const y = this.#deckHeight(e.x, e.z);
    e.y = e.y == null ? y : e.y + (y - e.y) * Math.min(1, dt * 12);
    e.robot.root.position.set(e.x, e.y, e.z);
    e.robot.root.rotation.y = e.heading;
  }
  /** Standing on a deck (plots and hub) or down in the street? */
  #deckHeight(x, z) {
    if (Math.hypot(x, z) < 5.3) return DECK_H;
    for (const o of this.agents.values()) if (Math.hypot(x - o.layout.center.x, z - o.layout.center.z) < 5.25) return DECK_H;
    return 0;
  }

  #overlay(now) {
    this.overlay.tick(now);
    const v = V();
    const camPos = this.camera.position;
    for (const e of [...this.agents.values(), ...this.visitors.values()]) {
      if (!this.loaded || (e.visitor && e.hidden > 0)) { this.overlay.place(e.id, 0, 0, false); continue; }
      e.robot.headTop(v); v.y += 0.18;
      const s = this.toScreen(v);
      const dist = camPos.distanceTo(v);
      const k = Math.max(0.62, Math.min(1.08, 34 / dist));
      const mode = e.visitor ? null : e.mode;
      const badge = mode ? BADGES[mode] : null;
      const tone = e.visitor ? 'pink' : mode === 'error' ? 'red' : e.s.busy > 0 ? 'accent' : mode === 'waiting' ? 'amber' : mode === 'sleeping' ? 'dim' : 'green';
      this.overlay.set(e.id, { name: e.agent.name, tone, badge, showName: this.showNames || this.selected === e.id || this.hovered === e.id || !!badge, selected: this.selected === e.id, hovered: this.hovered === e.id, visitor: e.visitor, sleeping: mode === 'sleeping' && e.sitting });
      const inView = s.visible && s.x > -60 && s.x < this.w + 60 && s.y > -80 && s.y < this.h + 60;
      this.overlay.place(e.id, s.x, s.y, inView, k, 500 - dist);
      e.screen = s;
    }
    if (this.land) {
      const lp = this.land.layaPoint(v); lp.y += 1.3; const ls = this.toScreen(lp);
      const hot = now < (this.orbUntil || 0);
      this.overlay.label('laya', hot ? `Laya · ${this.orbText}` : this.layaConnector ? 'Laya' : 'Laya · not connected', `laya${hot ? ' hot' : ''}${this.layaConnector ? '' : ' off'}`);
      this.overlay.placeLabel('laya', ls.x, ls.y, ls.visible);
      const keys = new Set(['laya']);
      let ri = 0;
      for (const r of this.land.relays.values()) {
        const key = `relay:${r.id}`; keys.add(key);
        this.overlay.label(key, r.name, `relay${r.status === 'error' ? ' err' : ''}`);
        const p = this.land.relayPoint(r.id, v); p.y += 0.6 + (ri++ % 2) * 0.9; const s = this.toScreen(p);
        this.overlay.placeLabel(key, s.x, s.y, s.visible && this.showNames);
      }
      if (this.land.vacant) for (const [i, g] of this.land.vacant) {
        const key = `vacant:${i}`; keys.add(key);
        this.overlay.label(key, '+ Empty plot · add an agent', 'vacant');
        const s = this.toScreen(v.set(g.position.x, 0.2, g.position.z));
        this.overlay.placeLabel(key, s.x, s.y, s.visible && this.hoverVacant === i);
      }
      for (const k of this.overlay.labelKeys()) if (!keys.has(k)) this.overlay.dropLabel(k);
    }
    // the follow card sits beside the selected bot
    if (this.cardEl) {
      const e = this.selected && this.agents.get(this.selected);
      if (e?.screen?.visible) {
        const cw = this.cardEl.offsetWidth || 260, ch = this.cardEl.offsetHeight || 150;
        let x = e.screen.x + 38, y = e.screen.y - 20;
        if (x + cw > this.w - 12) x = e.screen.x - cw - 38;
        x = Math.max(12, x); y = Math.max(60, Math.min(this.h - ch - 70, y));
        this.cardEl.style.transform = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`;
        this.cardEl.style.visibility = 'visible';
      } else this.cardEl.style.visibility = 'hidden';
    }
  }

  /** What the follow card shows for a bot. */
  describe(id) {
    const e = this.agents.get(id); if (!e) return null;
    const mode = e.mode || 'potter';
    return { mode, badge: BADGES[mode] || null, status: statusLine(mode, { detail: e.detail, visitName: e.s.visiting?.name }), level: e.level, tasks: e.agent.stats?.tasks || 0 };
  }

  // ------------------------------------------------------------------ input
  #pick(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const bots = [...this.agents.values(), ...this.visitors.values()].filter((e) => e.robot.root.visible);
    const hitB = this.ray.intersectObjects(bots.map((e) => e.robot.pick), false)[0];
    if (!this.land) return hitB ? { bot: bots.find((b) => b.robot.pick === hitB.object) } : null;
    const hitP = this.ray.intersectObjects(this.land.pickables(), false)[0];
    const hitR = this.ray.intersectObjects([...this.land.relays.values()].map((x) => x.group), true)[0];
    const hitV = this.ray.intersectObjects(this.land.vacantPickables(), false)[0];
    const cands = [];
    if (hitB) cands.push({ d: hitB.distance - 2, bot: bots.find((b) => b.robot.pick === hitB.object) });
    if (hitP) cands.push({ d: hitP.distance, plotOf: hitP.object.userData.plotOf });
    if (hitR) { const rel = [...this.land.relays.values()].find((x) => { for (let o = hitR.object; o; o = o.parent) if (o === x.group) return true; return false; }); if (rel) cands.push({ d: hitR.distance, relay: rel }); }
    if (hitV) cands.push({ d: hitV.distance + 0.5, vacant: hitV.object.userData.vacant });
    cands.sort((a, b) => a.d - b.d);
    return cands[0] || null;
  }

  #bindInput() {
    const c = this.canvas;
    let raf = 0, lastMove = null;
    const move = (ev) => {
      lastMove = ev;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (this.rig.dragging) return;
        const hit = this.#pick(lastMove.clientX, lastMove.clientY);
        const id = hit?.bot?.id || hit?.plotOf || null;
        this.hoverVacant = hit?.vacant ?? null;
        const rect = c.getBoundingClientRect();
        if (id !== this.hovered) {
          this.hovered = id;
          const e = id && (this.agents.get(id) || this.visitors.get(id));
          this.onHover?.(e ? { id, name: e.agent.name, x: lastMove.clientX - rect.left, y: lastMove.clientY - rect.top, visitor: !!e.visitor, status: e.visitor ? 'remote A2A agent' : statusLine(e.mode || 'potter', { detail: e.detail, visitName: e.s.visiting?.name }) } : null);
        }
        c.style.cursor = id || hit?.relay || hit?.vacant != null ? 'pointer' : '';
      });
    };
    const up = (ev) => {
      if (ev.button !== 0 || !this.rig.wasClick(ev)) return;
      const hit = this.#pick(ev.clientX, ev.clientY);
      if (hit?.bot && !hit.bot.visitor) this.onSelect?.(hit.bot.id);
      else if (hit?.bot?.visitor || hit?.relay) this.onSelect?.(null, { connectorId: hit.bot?.id || hit.relay.id });
      else if (hit?.plotOf) this.onSelect?.(hit.plotOf);
      else if (hit?.vacant != null) this.onVacant?.(hit.vacant);
      else this.onSelect?.(null);
    };
    const dbl = (ev) => { const hit = this.#pick(ev.clientX, ev.clientY); const id = hit?.bot?.id || hit?.plotOf; if (id && this.agents.has(id)) this.onOpen?.(id); };
    const leave = () => { if (this.hovered) { this.hovered = null; this.onHover?.(null); } };
    const keydown = (ev) => {
      if (ev.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.overlay')) return;
      if (ev.key.startsWith('Arrow')) { this.rig.keys.add(ev.key); ev.preventDefault(); }
    };
    const keyup = (ev) => this.rig.keys.delete(ev.key);
    const blur = () => this.rig.keys.clear();
    c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('dblclick', dbl); c.addEventListener('pointerleave', leave);
    addEventListener('keydown', keydown); addEventListener('keyup', keyup); addEventListener('blur', blur);
    this.unbind = () => {
      c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('dblclick', dbl); c.removeEventListener('pointerleave', leave);
      removeEventListener('keydown', keydown); removeEventListener('keyup', keyup); removeEventListener('blur', blur);
    };
  }

  /** Render now and sample the frame: how many distinct colours, and how much isn't blank. For tests. */
  probe(step = 24) {
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const colours = new Set(); let lit = 0, n = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4; n++;
      if (px[i] + px[i + 1] + px[i + 2] > 30) lit++;
      colours.add(`${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3}`);
    }
    return { colours: colours.size, lit: lit / n, samples: n };
  }

  /** For tests & debugging. */
  get effects() { return this.fx.list; }
  stats() { const i = this.renderer.info; return { fps: Math.round(this.fps), dpr: this.dpr, calls: i.render.calls, triangles: i.render.triangles, frames: this.frames, loaded: this.loaded, planet: this.planet, day: this.dayT }; }
}
