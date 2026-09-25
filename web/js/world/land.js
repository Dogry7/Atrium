import * as THREE from 'three';
import { part, accentMaterial, tinted } from './assets.js';
import {
  PLANETS, HEX, DECK, DECK_H, BUILD_SCALE, HUB, hexToWorld, hexDistance, worldToHex, inHex, plotLayout, piecesFor, pieceToWorld,
  PIECES, relaySpot, scatter, mulberry32,
} from './colony.js';

/**
 * The ground, the hub and every plot: decks, habitats that grow, flags, lamps, relay towers,
 * the Laya beacon and the lander. Static things are instanced; per-plot things live in groups.
 */
const SQ3 = Math.sqrt(3);

// ------------------------------------------------------------------ small noise
function makeNoise(seed) {
  const r = mulberry32(seed); const P = new Uint8Array(512); const p = [...Array(256).keys()].sort(() => r() - 0.5);
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  const grad = (h, x, y) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const n2 = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y), a = P[X] + Y, b = P[X + 1] + Y;
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(grad(P[a], x, y), grad(P[b], x - 1, y), u), THREE.MathUtils.lerp(grad(P[a + 1], x, y - 1), grad(P[b + 1], x - 1, y - 1), u), v);
  };
  return (x, y, oct = 4) => { let s = 0, a = 1, f = 1, n = 0; for (let i = 0; i < oct; i++) { s += n2(x * f, y * f) * a; n += a; a *= 0.5; f *= 2; } return s / n; };
}

function panelTexture(base, line) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = line; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < 40; i++) g.fillRect(((i * 97) % 8) * 32 + 2, ((i * 57) % 8) * 32 + 2, 28, 28);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
function hazardTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 32;
  const g = c.getContext('2d'); g.fillStyle = '#262a33'; g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#f5b83d';
  for (let x = -32; x < 288; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(12, 1);
  return t;
}
function deckTexture(base) {
  // the deck cap's UVs are planar across the hex, so a square panel grid reads cleanly
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 512);
  const r = mulberry32(3);
  for (let y = 0; y < 512; y += 64) for (let x = 0; x < 512; x += 64) { g.fillStyle = `rgba(0,0,0,${(r() * 0.035).toFixed(3)})`; g.fillRect(x, y, 64, 64); }
  g.strokeStyle = 'rgba(30,40,60,0.10)'; g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function poolTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const hexRing = (inner, outer) => new THREE.RingGeometry(inner, outer, 6, 1, Math.PI / 6).rotateX(-Math.PI / 2);

export class Land {
  constructor(scene, kits) {
    this.scene = scene; this.kits = kits;
    this.root = new THREE.Group(); scene.add(this.root);
    this.plots = new Map();      // agentId → PlotView
    this.relays = new Map();     // connectorId → tower
    this.planetGroup = null;
    this.time = 0;
    this.geo = {
      deck: new THREE.CylinderGeometry(DECK, DECK + 0.08, DECK_H, 6, 1).translate(0, DECK_H / 2, 0),
      kerb: new THREE.CylinderGeometry(DECK + 0.32, DECK + 0.42, DECK_H * 0.55, 6, 1).translate(0, DECK_H * 0.275, 0),
      led: hexRing(DECK - 0.22, DECK - 0.08),
      pole: new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8).translate(0, 1.3, 0),
      flag: new THREE.PlaneGeometry(1.0, 0.62, 6, 1).translate(0.5, 0, 0),
      pool: new THREE.CircleGeometry(1.8, 32).rotateX(-Math.PI / 2),
    };
    this.mat = {
      pole: new THREE.MeshStandardMaterial({ color: '#c9ceda', metalness: 0.6, roughness: 0.35 }),
      pool: new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#ffb866', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    };
    this.#buildHub();
  }

  // ------------------------------------------------------------------ planet: ground + scatter
  setPlanet(id, rings) {
    const P = PLANETS[id] || PLANETS.terra;
    if (this.planetId === id && this.rings === rings) return;
    this.planetId = id; this.rings = rings;
    if (this.planetGroup) { this.root.remove(this.planetGroup); this.planetGroup.traverse((o) => { if (o.geometry && o.userData.own) o.geometry.dispose(); }); }
    const g = new THREE.Group(); this.planetGroup = g; this.root.add(g);
    this.P = P;
    g.add(this.#ground(P, rings));
    this.scatterList = scatter(id, rings);
    g.add(this.#scatter(this.scatterList));
    // deck & hub materials follow the planet
    const deckTex = deckTexture(P.deck); deckTex.repeat.set(1, 1);
    this.deckMat = this.deckMat || new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
    this.deckMat.map?.dispose(); this.deckMat.map = deckTex; this.deckMat.color.set('#ffffff'); this.deckMat.needsUpdate = true;
    this.kerbMat = this.kerbMat || new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 });
    this.kerbMat.color.set(P.kerb);
    for (const pv of this.plots.values()) pv.deck.material = this.deckMat;
  }

  #ground(P, rings) {
    const noise = makeNoise(P.id.length * 31 + 5);
    const size = 1000, seg = 200;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position; const col = new Float32Array(pos.count * 3);
    const flatR = (rings + 0.75) * HEX * SQ3;
    const c0 = new THREE.Color(P.ground[0]), c1 = new THREE.Color(P.ground[1]), c2 = new THREE.Color(P.ground[2]), street = new THREE.Color(P.street), far = new THREE.Color(P.far);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), d = Math.hypot(x, z);
      const n = noise(x * 0.02, z * 0.02), n2 = noise(x * 0.09 + 40, z * 0.09);
      const rise = THREE.MathUtils.smoothstep(d, flatR + 3, flatR + 70);
      let y = rise * (n * 16 + 7 + noise(x * 0.006, z * 0.006, 2) * 30);
      if (P.id === 'luna') { const cr = noise(x * 0.05 + 9, z * 0.05 - 3, 2); y -= rise * Math.max(0, cr - 0.25) * 18; }
      if (d > 320) y += (d - 320) * 0.35 * (0.6 + n * 0.8);
      pos.setY(i, d < flatR + 3 ? -0.02 : y);
      tmp.copy(c0).lerp(c1, THREE.MathUtils.clamp(n * 1.4 + 0.5, 0, 1)).lerp(c2, THREE.MathUtils.clamp(n2, 0, 1) * 0.6);
      // streets between plots: inside the colony, anything not on a deck
      if (d < flatR) {
        const h = worldToHex(x, z); const c = hexToWorld(h.q, h.r);
        if (hexDistance(h) <= rings && !inHex(x, z, c.x, c.z, DECK + 0.6)) tmp.lerp(street, 0.75);
      }
      tmp.lerp(far, rise * 0.5);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false }));
    m.receiveShadow = true; m.userData.own = true; m.name = 'ground';
    return m;
  }

  #scatter(list) {
    const group = new THREE.Group(); group.name = 'scatter';
    const byPart = new Map();
    for (const s of list) { const k = `${s.kit}/${s.part}/${s.tint || ''}`; if (!byPart.has(k)) byPart.set(k, []); byPart.get(k).push(s); }
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), T = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    for (const [, items] of byPart) {
      const { kit, part: name, tint } = items[0];
      const proto = this.kits[kit]?.parts.get(name); if (!proto) continue;
      proto.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(proto.matrixWorld).invert();
      proto.traverse((o) => {
        if (!o.isMesh) return;
        const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
        const mat = tint ? (this.tints ||= new Map()).get(tint) || this.tints.set(tint, tinted(o.material, tint)).get(tint) : o.material;
        const im = new THREE.InstancedMesh(o.geometry, mat, items.length);
        im.castShadow = true; im.receiveShadow = true;
        items.forEach((s, i) => { Q.setFromAxisAngle(Y, s.rot); S.setScalar(s.scale); T.set(s.x, 0, s.z); M.compose(T, Q, S).multiply(local); im.setMatrixAt(i, M); });
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
        group.add(im);
      });
    }
    return group;
  }

  // ------------------------------------------------------------------ hub
  #buildHub() {
    const hub = new THREE.Group(); hub.name = 'hub'; this.hub = hub; this.root.add(hub);
    const metal = new THREE.MeshStandardMaterial({ color: '#5a6274', roughness: 0.6, metalness: 0.35, map: panelTexture('#8a93a8', 'rgba(0,0,0,0.25)') });
    metal.map.repeat.set(4, 4);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(DECK, DECK + 0.08, DECK_H, 6).translate(0, DECK_H / 2, 0), metal);
    deck.receiveShadow = true; hub.add(deck);
    const kerb = new THREE.Mesh(new THREE.CylinderGeometry(DECK + 0.32, DECK + 0.42, DECK_H * 0.55, 6).translate(0, DECK_H * 0.275, 0), new THREE.MeshStandardMaterial({ color: '#3c4252', roughness: 0.8 }));
    kerb.receiveShadow = true; hub.add(kerb);
    const hz = new THREE.Mesh(hexRing(DECK - 0.55, DECK - 0.1), new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.7 }));
    hz.position.y = DECK_H + 0.01; hz.receiveShadow = true; hub.add(hz);
    const pad = part(this.kits, 'base', 'landingpad_large'); pad.scale.setScalar(2.3); pad.position.y = DECK_H - 0.02; hub.add(pad);
    // lander (A2A arrivals)
    const lander = part(this.kits, 'base', 'lander_A'); lander.scale.setScalar(1.9); lander.position.set(HUB.lander.x, DECK_H + 1.1, HUB.lander.z); lander.rotation.y = Math.PI / 5;
    hub.add(lander); this.lander = lander; this.landerY = lander.position.y; this.landerAnim = null;
    // Laya beacon
    const laya = new THREE.Group(); laya.position.set(HUB.laya.x, DECK_H, HUB.laya.z); hub.add(laya); this.laya = laya;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 0.9, 8).translate(0, 0.45, 0), new THREE.MeshStandardMaterial({ color: '#2d2842', roughness: 0.4, metalness: 0.5 }));
    plinth.castShadow = true; laya.add(plinth);
    this.orbMat = new THREE.MeshStandardMaterial({ color: '#3a2a08', emissive: '#f5b83d', emissiveIntensity: 1.6, roughness: 0.2 });
    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.46, 2), this.orbMat); this.orb.position.y = 1.9; this.orb.castShadow = true; laya.add(this.orb);
    this.orbRings = [0, 1].map((i) => { const r = new THREE.Mesh(new THREE.TorusGeometry(0.78 + i * 0.22, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.8, toneMapped: false })); r.position.y = 1.9; laya.add(r); return r; });
    this.orbLight = new THREE.PointLight('#f5b83d', 3, 9, 1.6); this.orbLight.position.y = 1.9; laya.add(this.orbLight);
    this.orbGlow = 0;
  }

  /** Laya point for beams / labels (world). */
  layaPoint(v = new THREE.Vector3()) { return this.orb.getWorldPosition(v); }
  pulseLaya() { this.orbGlow = 1; }

  /** Drop the lander from orbit (a remote A2A agent is arriving). */
  landerArrive() { this.landerAnim = { t: 0 }; }

  // ------------------------------------------------------------------ relays (connectors)
  setRelays(list) {
    const want = new Set(list.map((c) => c.id));
    for (const [id, r] of this.relays) if (!want.has(id)) { this.hub.remove(r.group); this.relays.delete(id); }
    list.forEach((c, k) => {
      let r = this.relays.get(c.id);
      const color = c.pluginId === 'web' ? '#3ba7ff' : c.pluginId === 'mcp' ? '#22c3a6' : '#b18cff';
      if (!r) {
        const group = new THREE.Group();
        const tower = part(this.kits, 'base', 'structure_tall'); tower.scale.set(0.62, 0.85, 0.62); group.add(tower);
        const dish = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: '#e7ebf3', side: THREE.DoubleSide, metalness: 0.3, roughness: 0.35 }));
        dish.rotation.x = Math.PI * 0.8; dish.position.set(0, 1.95, 0.1); dish.castShadow = true; group.add(dish);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshStandardMaterial({ color: '#000', emissive: color, emissiveIntensity: 1.2 }));
        lamp.position.y = 2.25; group.add(lamp);
        r = { id: c.id, group, lamp, dish, glow: 0, color };
        this.hub.add(group); this.relays.set(c.id, r);
      }
      r.lamp.material.emissive.set(color); r.color = color;
      r.name = c.name; r.status = c.status;
      const s = relaySpot(k, list.length); r.group.position.set(s.x, DECK_H, s.z);
      r.group.rotation.y = Math.atan2(-s.x, -s.z);
    });
  }
  relayPoint(id, v = new THREE.Vector3()) { const r = this.relays.get(id); return r ? r.lamp.getWorldPosition(v) : null; }
  pulseRelay(id) { const r = this.relays.get(id); if (r) r.glow = 1; }

  // ------------------------------------------------------------------ plots
  ensurePlot(agent, level) {
    let pv = this.plots.get(agent.id);
    const index = agent.plot ?? 0;
    if (pv && pv.index !== index) { this.removePlot(agent.id); pv = null; }
    if (!pv) pv = this.#buildPlot(agent, index);
    if (pv.color !== agent.avatar?.color) {
      pv.color = agent.avatar?.color || '#7c5cff';
      pv.accent.userData.accent.value.set(pv.color); pv.ledMat.color.set(pv.color); pv.flagMat.color.set(pv.color);
    }
    if (level !== pv.level) this.#setLevel(pv, level, pv.level != null);
    return pv;
  }

  #buildPlot(agent, index) {
    const L = plotLayout(index);
    const group = new THREE.Group(); group.name = `plot-${agent.id}`;
    const color = agent.avatar?.color || '#7c5cff';
    const deck = new THREE.Mesh(this.geo.deck, this.deckMat); deck.position.set(L.center.x, 0, L.center.z); deck.receiveShadow = true;
    deck.userData.plotOf = agent.id; group.add(deck);
    const kerb = new THREE.Mesh(this.geo.kerb, this.kerbMat); kerb.position.copy(deck.position); kerb.receiveShadow = true; group.add(kerb);
    const ledMat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.75 });
    const led = new THREE.Mesh(this.geo.led, ledMat); led.position.set(L.center.x, DECK_H + 0.012, L.center.z); group.add(led);
    // flag
    const pole = new THREE.Mesh(this.geo.pole, this.mat.pole); pole.position.set(L.flag.x, DECK_H, L.flag.z); pole.castShadow = true; group.add(pole);
    const flagMat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.7 });
    const flag = new THREE.Mesh(this.geo.flag, flagMat); flag.position.set(L.flag.x, DECK_H + 2.25, L.flag.z); flag.castShadow = true; group.add(flag);
    // lamp + light pool
    const lamp = part(this.kits, 'base', 'lights'); lamp.scale.setScalar(1.4); lamp.position.set(L.lamp.x, DECK_H, L.lamp.z); group.add(lamp);
    const pool = new THREE.Mesh(this.geo.pool, this.mat.pool); pool.position.set(L.lamp.x, DECK_H + 0.02, L.lamp.z); group.add(pool);
    // bench
    const bench = part(this.kits, 'base', 'cargo_A_packed'); bench.scale.setScalar(1.25); bench.position.set(L.bench.x, DECK_H, L.bench.z); bench.rotation.y = L.facing; group.add(bench);
    const accent = accentMaterial(this.kits.base.material, color);
    const habitat = new THREE.Group(); group.add(habitat);
    const scaffold = part(this.kits, 'base', 'structure_low', { material: accent }); scaffold.visible = false; group.add(scaffold);
    this.root.add(group);
    const pv = { id: agent.id, index, layout: L, group, deck, led, ledMat, flag, flagMat, habitat, scaffold, accent, color, level: null, pieces: [], grow: [], building: false, fans: [] };
    this.plots.set(agent.id, pv);
    return pv;
  }

  #setLevel(pv, level, animate) {
    const want = piecesFor(level);
    // add what's missing (levels only ever add pieces; a lower level removes the extras)
    const have = new Map(pv.pieces.map((p) => [p.key, p]));
    const keep = new Set();
    want.forEach((p, i) => {
      const key = `${p.level}:${i}:${p.part}`; keep.add(key);
      if (have.has(key)) return;
      const w = pieceToWorld(pv.layout, p);
      const o = part(this.kits, 'base', p.part, { material: pv.accent });
      o.position.set(w.x, DECK_H + w.y, w.z); o.rotation.y = w.rot; const sc = BUILD_SCALE * (p.s || 1); o.scale.setScalar(animate ? 0.001 : sc);
      o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.userData.plotOf = pv.id; } });
      pv.habitat.add(o);
      const rec = { key, o, sc };
      pv.pieces.push(rec);
      if (animate) pv.grow.push({ o, sc, t: -0.15 * pv.grow.length });
    });
    for (const rec of [...pv.pieces]) if (!keep.has(rec.key)) { pv.habitat.remove(rec.o); pv.pieces.splice(pv.pieces.indexOf(rec), 1); }
    pv.fans = []; pv.habitat.traverse((m) => { if (/fan/i.test(m.name)) pv.fans.push(m); });
    pv.level = level;
    // the scaffold marks where the next piece will go
    const next = PIECES[level + 1]?.[0] || { part: 'structure_low', x: 2.3, z: 1.2 };
    const w = pieceToWorld(pv.layout, { ...next, y: 0 });
    pv.scaffold.position.set(w.x, DECK_H, w.z); pv.scaffold.rotation.y = w.rot; pv.scaffold.scale.setScalar(BUILD_SCALE * 0.9);
  }

  /** Show scaffolding while the agent works (its habitat is "under construction"). */
  setBuilding(agentId, on) { const pv = this.plots.get(agentId); if (pv) { pv.building = on; if (on) pv.scaffold.visible = true; } }

  /** Empty plots inside the colony's rings: a faint outline you can click to add an agent. */
  setVacant(indices) {
    this.vacant ||= new Map();
    const want = new Set(indices);
    for (const [i, m] of this.vacant) if (!want.has(i)) { this.root.remove(m); this.vacant.delete(i); }
    this.vacantMat ||= new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
    this.vacantFill ||= new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, roughness: 1, depthWrite: false });
    for (const i of want) {
      if (this.vacant.has(i)) continue;
      const L = plotLayout(i);
      const g = new THREE.Group(); g.position.set(L.center.x, 0.03, L.center.z);
      const ring = new THREE.Mesh(this.geo.led, this.vacantMat); g.add(ring);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(DECK - 0.1, 6, Math.PI / 6).rotateX(-Math.PI / 2), this.vacantFill); fill.position.y = -0.01; fill.userData.vacant = i; g.add(fill);
      g.userData.vacant = i;
      this.root.add(g); this.vacant.set(i, g);
    }
  }
  vacantPickables() { const out = []; for (const g of (this.vacant || new Map()).values()) out.push(g.children[1]); return out; }

  removePlot(agentId) {
    const pv = this.plots.get(agentId); if (!pv) return;
    this.root.remove(pv.group);
    pv.accent.dispose(); pv.ledMat.dispose(); pv.flagMat.dispose();
    this.plots.delete(agentId);
  }

  update(dt, night, now) {
    this.time += dt;
    // growth pop
    for (const pv of this.plots.values()) {
      pv.grow = pv.grow.filter((g) => {
        g.t += dt; if (g.t < 0) return true;
        const k = Math.min(1, g.t / 0.7); const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // back-out ease
        g.o.scale.setScalar(Math.max(0.001, g.sc * e));
        return k < 1;
      });
      for (const f of pv.fans) f.rotation.z += dt * 2.4;
      pv.flag.rotation.y = Math.sin(this.time * 1.6 + pv.index) * 0.25 + pv.layout.facing * 0 + 0.4;
      pv.accent.userData.glow.value = night * 0.9;
      pv.ledMat.opacity = 0.55 + night * 0.45 + (pv.building ? Math.sin(now / 160) * 0.2 : 0);
      if (!pv.building && pv.scaffold.visible) { pv.scaffold.visible = false; }
    }
    this.mat.pool.opacity = night * 0.5;
    // Laya
    this.orbGlow = Math.max(0, this.orbGlow - dt * 0.45);
    const g = this.orbGlow;
    this.orb.position.y = 1.9 + Math.sin(this.time * 1.4) * 0.12;
    this.orb.rotation.y += dt * (0.4 + g * 3);
    this.orbMat.emissiveIntensity = 1.3 + g * 2.5 + Math.sin(this.time * 2) * 0.2;
    this.orbLight.intensity = 2 + g * 8 + night * 3;
    this.orbRings.forEach((r, i) => { r.position.y = this.orb.position.y; r.rotation.x = Math.PI / 2 + Math.sin(this.time * 0.7 + i) * 0.5; r.rotation.y += dt * (i ? -0.8 : 0.6) * (1 + g * 3); r.material.opacity = 0.45 + g * 0.5; });
    // relays
    for (const r of this.relays.values()) {
      r.glow = Math.max(0, r.glow - dt * 0.9);
      r.lamp.material.emissiveIntensity = 0.8 + r.glow * 4 + night * 0.8 + (r.status === 'error' ? Math.sin(now / 90) : 0);
      r.dish.rotation.z = Math.sin(this.time * 0.5 + r.group.position.x) * 0.4;
    }
    // lander
    if (this.landerAnim) {
      const a = this.landerAnim; a.t += dt;
      const k = Math.min(1, a.t / 2.2);
      this.lander.position.y = this.landerY + (1 - (1 - (1 - k) ** 3)) * 40 * (1 - k);
      this.lander.rotation.y += dt * (1 - k) * 2;
      if (k >= 1) { this.lander.position.y = this.landerY; this.landerAnim = null; }
    }
  }

  /** Scene objects that can be clicked (plot decks and habitat pieces carry userData.plotOf). */
  pickables() { const out = []; for (const pv of this.plots.values()) { out.push(pv.deck); pv.habitat.traverse((m) => { if (m.isMesh) out.push(m); }); } return out; }
}
