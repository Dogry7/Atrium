import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { Robot } from './robot.js';
import { DECK_H } from './colony.js';

/**
 * A live 3D preview of one robot, for the agent builder: the same model the colony uses,
 * on a little deck, turning slowly and cycling through its moves.
 */
const MOVES = [['wave', 2.1], ['idle', 2.4], ['cheer', 1.7], ['idle2', 2.2], ['hammer', 2.7], ['idle', 1.6]];

export class BotPreview {
  constructor(canvas, L) {
    this.canvas = canvas; this.L = L;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 1.25, 4.1); this.camera.lookAt(0, 0.72, 0);
    const key = new THREE.DirectionalLight('#fff4e0', 2.4); key.position.set(2.5, 4, 3); key.castShadow = true; key.shadow.mapSize.set(512, 512);
    const sc = key.shadow.camera; sc.left = -2; sc.right = 2; sc.top = 2; sc.bottom = -2;
    this.scene.add(key, new THREE.HemisphereLight('#cfe0ff', '#41385e', 1.3));
    const rim = new THREE.DirectionalLight('#9d8cff', 1.4); rim.position.set(-3, 2, -2); this.scene.add(rim);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.2, DECK_H, 6), new THREE.MeshStandardMaterial({ color: '#e4e7ee', roughness: 0.7 }));
    deck.position.y = -DECK_H / 2; deck.receiveShadow = true; this.scene.add(deck);
    this.led = new THREE.Mesh(new THREE.RingGeometry(1.02, 1.1, 6, 1, Math.PI / 6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: L.color, toneMapped: false }));
    this.led.position.y = 0.005; this.scene.add(this.led);
    this.turn = new THREE.Group(); this.scene.add(this.turn);
    this.move = 0; this.moveAt = 0; this.t = 0;
    this.#resize();
    this.ready = loadAssets().then((kits) => { if (this.dead) return; this.kits = kits; this.#build(); });
    this.last = performance.now();
    const loop = (now) => { if (this.dead) return; this.raf = requestAnimationFrame(loop); this.#frame(now); };
    this.raf = requestAnimationFrame(loop);
  }
  #resize() {
    const w = this.canvas.clientWidth || 200, h = this.canvas.clientHeight || 220;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  #build() {
    if (this.robot) { this.turn.remove(this.robot.root); this.robot.dispose(); }
    this.robot = new Robot(this.kits, this.L);
    this.robot.ring.visible = false;
    this.turn.add(this.robot.root);
    this.move = 0; this.moveAt = 0;
  }
  /** New looks: recolour, or rebuild if the antenna/accessory changed. */
  set(L) {
    const prev = this.L; this.L = L;
    this.led.material.color.set(L.color);
    if (!this.robot) return;
    if (prev.hair !== L.hair || prev.accessory !== L.accessory) this.#build();
    else this.robot.recolor(L);
    this.robot.play('jump', { then: () => this.robot.play('idle') });
    this.moveAt = this.t + 1.2;
  }
  #frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
    this.turn.rotation.y = Math.sin(this.t * 0.45) * 0.7;
    if (this.robot) {
      if (this.t > this.moveAt) {
        const [clip, dur] = MOVES[this.move % MOVES.length]; this.move++;
        this.robot.play(clip); this.robot.setFace(clip === 'cheer' || clip === 'wave' ? 'happy' : clip === 'hammer' ? 'focus' : 'idle');
        this.moveAt = this.t + dur;
      }
      this.robot.update(dt, now);
    }
    this.renderer.render(this.scene, this.camera);
  }
  destroy() { this.dead = true; cancelAnimationFrame(this.raf); this.robot?.dispose(); this.renderer.dispose(); }
}
