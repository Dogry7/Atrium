import * as THREE from 'three';
import { PLANETS, sunHeight } from './colony.js';

/**
 * Sky dome, sun & moon light, stars and a body in the sky (a moon, Phobos, or Earth from Luna).
 * Everything is derived from one number: the fraction of the day (0 midnight, 0.5 noon).
 */
const VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const FRAG = /* glsl */`
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uStars; uniform float uTime; uniform vec3 uGround;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(max(h, 0.0), 0.55));
  col = mix(col, uGround, smoothstep(0.0, -0.08, h));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.35 + pow(s, 3.0) * 0.08);
  if (uStars > 0.01 && h > 0.0) {
    vec3 g = floor(d * 260.0);
    float r = hash(g);
    float tw = 0.6 + 0.4 * sin(uTime * 2.0 + r * 40.0);
    col += vec3(smoothstep(0.9965, 1.0, r)) * uStars * tw * 1.4 * smoothstep(0.0, 0.25, h);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const C = (h) => new THREE.Color(h);
const mixC = (a, b, t) => a.clone().lerp(b, t);

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.uni = {
      uTop: { value: C('#5fb0f0') }, uHorizon: { value: C('#cfe9ff') }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: C('#fff3d6') }, uStars: { value: 0 }, uTime: { value: 0 }, uGround: { value: C('#6ea35a') },
    };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), new THREE.ShaderMaterial({ uniforms: this.uni, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight('#fff1d6', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#cfe6ff', '#6b8f55', 1.1);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight('#8090c0', 0.15);
    scene.add(this.ambient);
    scene.fog = new THREE.Fog('#cfe3f5', 120, 420);

    // a body in the sky
    const bodyTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.bodyCanvas = bodyTex.image; this.bodyCanvas.width = this.bodyCanvas.height = 256; bodyTex.colorSpace = THREE.SRGBColorSpace;
    this.body = new THREE.Sprite(new THREE.SpriteMaterial({ map: bodyTex, fog: false, depthWrite: false, transparent: true }));
    this.body.scale.setScalar(120); this.body.renderOrder = -9;
    scene.add(this.body);
    this.planet = null; this.t = 0.5;
  }

  setPlanet(id) {
    if (this.planet?.id === id) return;
    this.planet = PLANETS[id] || PLANETS.terra;
    paintBody(this.bodyCanvas, this.planet.moon);
    this.body.material.map.needsUpdate = true;
    this.uni.uGround.value.set(this.planet.far);
    this.update(this.t, 0);
  }

  /** @param t day fraction; @param center point the shadow camera follows */
  update(t, time, center = { x: 0, z: 0 }) {
    this.t = t;
    const P = this.planet || PLANETS.terra;
    const h = sunHeight(t);                 // -1..1
    const day = THREE.MathUtils.smoothstep(h, -0.12, 0.25);
    const golden = Math.max(0, 1 - Math.abs(h - 0.06) / 0.28) * (h > -0.15 ? 1 : 0);
    const dusk = t > 0.5;
    const top = mixC(C(P.sky.night[0]), C(P.sky.day[0]), day), hor = mixC(C(P.sky.night[1]), C(P.sky.day[1]), day);
    const g = dusk ? P.sky.dusk : P.sky.dawn;
    top.lerp(C(g[0]), golden * 0.6); hor.lerp(C(g[1]), golden * 0.85);
    this.uni.uTop.value.copy(top); this.uni.uHorizon.value.copy(hor);
    this.uni.uTime.value = time;
    this.uni.uStars.value = P.id === 'luna' ? 0.35 + (1 - day) * 0.65 : Math.pow(1 - day, 2) * P.stars;

    // sun arc: rises in the east (+x), tilted south so walls never go black at noon
    const ang = (t - 0.25) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(ang) * 0.85, Math.max(-0.4, Math.sin(ang)) * 0.9 + 0.12, 0.45).normalize();
    this.uni.uSunDir.value.copy(dir);
    const sunCol = mixC(C('#ffb77a'), C('#fff4de'), THREE.MathUtils.smoothstep(h, 0.05, 0.45));
    this.uni.uSunColor.value.copy(sunCol).multiplyScalar(day);

    // light: the sun by day, a cool moon by night
    const moonDir = new THREE.Vector3(-0.5, 0.75, -0.35).normalize();
    const L = h > -0.02 ? dir : moonDir;
    this.sun.position.set(center.x + L.x * 150, L.y * 150, center.z + L.z * 150);
    this.sun.target.position.set(center.x, 0, center.z);
    this.sun.color.copy(h > -0.02 ? sunCol : C('#9fb4ff'));
    this.sun.intensity = h > -0.02 ? 0.4 + 2.4 * day : 0.55;
    this.hemi.color.copy(mixC(C('#34407a'), C(P.id === 'mars' ? '#ffe2c6' : '#d7ebff'), day));
    this.hemi.groundColor.copy(mixC(C('#141a33'), C(P.ground[0]), day * 0.8));
    this.hemi.intensity = 0.55 + day * 0.75;
    this.ambient.intensity = 0.18 + (1 - day) * 0.15;
    const fog = mixC(C(P.fog.night), C(P.fog.day), day).lerp(hor, 0.35);
    this.scene.fog.color.copy(fog);
    this.night = 1 - day;

    // the body in the sky sits opposite the sun-ish, high up
    const bd = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
    this.body.position.set(center.x + bd.x * 800, bd.y * 800, center.z + bd.z * 800);
    this.body.material.opacity = P.id === 'luna' ? 1 : 0.35 + 0.65 * (1 - day * 0.7);
  }
}

function paintBody(c, kind) {
  const ctx = c.getContext('2d'); const W = c.width, R = W * 0.42, cx = W / 2, cy = W / 2;
  ctx.clearRect(0, 0, W, W);
  const glow = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.2);
  glow.addColorStop(0, kind === 'earth' ? 'rgba(120,190,255,0.45)' : 'rgba(255,255,255,0.18)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, W);
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  if (kind === 'earth') {
    ctx.fillStyle = '#2f6fd0'; ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#5fae5a';
    for (const [x, y, rx, ry, a] of [[0.38, 0.35, 0.16, 0.1, 0.4], [0.62, 0.55, 0.12, 0.18, -0.3], [0.3, 0.66, 0.09, 0.06, 0.2], [0.7, 0.28, 0.08, 0.05, 0.8]]) { ctx.beginPath(); ctx.ellipse(W * x, W * y, W * rx, W * ry, a, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (const [x, y, rx, ry] of [[0.5, 0.2, 0.22, 0.03], [0.45, 0.78, 0.2, 0.025], [0.3, 0.5, 0.1, 0.02]]) { ctx.beginPath(); ctx.ellipse(W * x, W * y, W * rx, W * ry, 0.2, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.fillStyle = kind === 'phobos' ? '#b39b8c' : '#e9e6dc'; ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = kind === 'phobos' ? 'rgba(90,70,60,0.35)' : 'rgba(150,145,135,0.35)';
    for (let i = 0; i < 14; i++) { const a = i * 2.39, d = (i % 5) / 5 * R * 0.8; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 6 + (i * 7) % 18, 0, Math.PI * 2); ctx.fill(); }
  }
  const sh = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R); sh.addColorStop(0.35, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,10,0.75)');
  ctx.fillStyle = sh; ctx.fillRect(0, 0, W, W);
  ctx.restore();
}
