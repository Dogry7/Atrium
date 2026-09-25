import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The CC0 model kits (see /assets/models/CREDITS.md), loaded once and shared.
 * Every Space Base / Forest model UVs into one gradient atlas (8×4 swatches), so a whole kit
 * is one material; `accentMaterial()` repaints the trim swatch in an agent's colour.
 */
const FILES = { base: 'spacebase', forest: 'forest', nature: 'nature', crew: 'crew' };
let loading = null;

export function loadAssets(onProgress) {
  if (loading) return loading;
  const loader = new GLTFLoader();
  let done = 0;
  loading = Promise.all(Object.entries(FILES).map(([key, file]) =>
    loader.loadAsync(`/assets/models/${file}.glb`).then((gltf) => { onProgress?.(++done / 4); return [key, gltf]; }),
  )).then((pairs) => {
    const kits = {};
    for (const [key, gltf] of pairs) {
      if (key === 'crew') { kits.crew = gltf; continue; }
      const parts = new Map();
      let material = null;
      for (const node of gltf.scene.children) {
        parts.set(node.name, node);
        node.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true; o.receiveShadow = true;
          material = material || o.material;
          if (key === 'nature') { o.material.vertexColors = true; }
        });
      }
      kits[key] = { parts, material };
    }
    return kits;
  });
  return loading;
}

/** A fresh instance of a kit model (geometry and material are shared, not copied). */
export function part(kits, kit, name, { material } = {}) {
  const proto = kits[kit]?.parts.get(name);
  if (!proto) { console.warn(`[world] missing model ${kit}/${name}`); return new THREE.Group(); }
  const o = proto.clone(true);
  o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
  if (material) o.traverse((m) => { if (m.isMesh) m.material = material; });
  return o;
}

/** Atlas cell of the gold trim band: col 3, row 1 of the 8×4 swatch grid. */
const TRIM = { u0: 3 / 8, u1: 4 / 8, v0: 1 / 4, v1: 2 / 4 };

/**
 * The Space Base material with its trim swatch repainted in `color`, glowing after dark
 * (`material.userData.glow.value` 0..1 is driven by the sky).
 */
export function accentMaterial(base, color) {
  const m = base.clone();
  const accent = { value: new THREE.Color(color) };
  const glow = { value: 0 };
  m.userData.accent = accent; m.userData.glow = glow;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAccent = accent; sh.uniforms.uGlow = glow;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nuniform float uGlow;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        bool isTrim = vMapUv.x > ${TRIM.u0.toFixed(4)} && vMapUv.x < ${TRIM.u1.toFixed(4)} && vMapUv.y > ${TRIM.v0.toFixed(4)} && vMapUv.y < ${TRIM.v1.toFixed(4)};
        if (isTrim) diffuseColor.rgb = uAccent * (0.55 + 0.6 * dot(diffuseColor.rgb, vec3(0.333)));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (isTrim) totalEmissiveRadiance += uAccent * uGlow * 0.9;`);
  };
  m.customProgramCacheKey = () => 'accent-trim';
  return m;
}

/** A tinted copy of a kit material (Mars rocks, visitor suits…). */
export function tinted(base, color, mix = 0.65) {
  const m = base.clone();
  const c = new THREE.Color(color);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTint = { value: c };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTint;')
      .replace('#include <map_fragment>', `#include <map_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, uTint * (0.5 + dot(diffuseColor.rgb, vec3(0.5))), ${mix.toFixed(2)});`);
  };
  m.customProgramCacheKey = () => `tint-${color}-${mix}`;
  return m;
}
