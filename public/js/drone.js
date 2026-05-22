// Drone mesh + per-frame updates (rotors, blinking lights).
// `fgRoot` is the world-positioned anchor; `drone` rotates inside it.

import * as THREE from 'three';
import { LOCAL_LIGHT_LAYER } from './scene.js';
import { generateCloudDeckBytes } from './clouds-shared.js';
import {
  EARTH_POSITION,
  REENTRY_BURN_START_ALTITUDE,
  REENTRY_BURN_FULL_ALTITUDE,
} from './config.js';

// ── Materials ────────────────────────────────
const shellMat = new THREE.MeshStandardMaterial({ color: '#0d0d1a', metalness: 0.9, roughness: 0.15 });
const trimMat  = new THREE.MeshStandardMaterial({ color: '#1a1a35', metalness: 0.8, roughness: 0.2 });
const darkMat  = new THREE.MeshStandardMaterial({ color: '#080812', metalness: 0.95, roughness: 0.1 });
const motorMat = new THREE.MeshStandardMaterial({ color: '#181830', metalness: 0.85, roughness: 0.18 });
const bladeMat = new THREE.MeshStandardMaterial({ color: '#334466', metalness: 0.3, roughness: 0.4, transparent: true, opacity: 0.82 });
const legMat   = new THREE.MeshStandardMaterial({ color: '#141428', metalness: 0.75, roughness: 0.25 });
const glowMat = new THREE.MeshBasicMaterial({
  color: '#ff8e2b',
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
  fog: false,
});
const bowShockMat = new THREE.MeshBasicMaterial({
  color: '#8bc5ff',
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
  fog: false,
});
const wakeMat = new THREE.MeshBasicMaterial({
  color: '#ff5b1c',
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
  fog: false,
});
const wakeCoreMat = new THREE.MeshBasicMaterial({
  color: '#ffd299',
  transparent: true,
  opacity: 0,
  blending: THREE.NormalBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
  fog: false,
});
const shockFlareMat = new THREE.SpriteMaterial({
  map: null,
  color: '#dff4ff',
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
  fog: false,
});

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function makeRibbonTexture() {
  const width = 160;
  const height = 512;
  const deck = generateCloudDeckBytes({
    width,
    height,
    earthGuide: null,
    cloudSeed: 84.21,
    patternScale: 2.05,
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const out = image.data;

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const sourceGlow = 1 - THREE.MathUtils.smoothstep(v, 0.06, 0.24);
    const tailFade = 1 - THREE.MathUtils.smoothstep(v, 0.68, 1.0);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / (width - 1);
      const centerDist = Math.abs(u * 2 - 1);
      const widthMask = Math.pow(1 - clamp01(centerDist), 1.45);

      const lowAlpha = deck.lowAlpha[i] / 255;
      const midAlpha = deck.midAlpha[i] / 255;
      const cirrusAlpha = deck.cirrusAlpha[i] / 255;
      const lowDepth = deck.lowDepth[i] / 255;
      const midDepth = deck.midDepth[i] / 255;
      const cirrusDepth = deck.cirrusDepth[i] / 255;

      const breakup = (
        lowAlpha * 0.18 +
        midAlpha * 0.34 +
        cirrusAlpha * 0.48 +
        lowDepth * 0.08 +
        midDepth * 0.22 +
        cirrusDepth * 0.28
      );
      const wispy = clamp01(breakup * widthMask * (0.22 + 0.78 * tailFade));
      const core = clamp01(Math.pow(widthMask, 5.4) * (0.34 + midDepth * 0.66) * (0.32 + 0.68 * tailFade));
      const alpha = clamp01(wispy * 0.92 + core * 0.62 + sourceGlow * core * 0.26);
      const whiteHot = clamp01(sourceGlow * 0.8 + core * 0.45);
      const ember = clamp01(wispy * 0.82 + tailFade * 0.18);

      out[i + 0] = Math.round(110 + ember * 112 + whiteHot * 74);
      out[i + 1] = Math.round(10 + ember * 86 + whiteHot * 150);
      out[i + 2] = Math.round(2 + ember * 22 + whiteHot * 118);
      out[i + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeSparkTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.46, 'rgba(255,255,255,0.48)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeShockTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(96, 96, 10, 96, 96, 96);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.22, 'rgba(255,255,255,0.95)');
  glow.addColorStop(0.56, 'rgba(180,225,255,0.4)');
  glow.addColorStop(1, 'rgba(180,225,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 192, 192);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeAftConeGeometry() {
  const geometry = new THREE.ConeGeometry(1, 1, 24, 1, true);
  geometry.translate(0, -0.5, 0);
  return geometry;
}

const trailTexture = makeRibbonTexture();
const sparkTexture = makeSparkTexture();
const shockTexture = makeShockTexture();
shockFlareMat.map = shockTexture;
const aftConeGeometry = makeAftConeGeometry();
const _tmpColor = new THREE.Color();
const _tmpTrailColor = new THREE.Color();
const _burnGlowColor = new THREE.Color('#fff1bf');
const _wakeCoreColor = new THREE.Color('#ffd18c');
const _wakeShockColor = new THREE.Color('#96deff');
const _wakeTailColor = new THREE.Color('#ff6120');
const _wakeHotColor = new THREE.Color('#fff3d4');
const _wakeDeepColor = new THREE.Color('#9b1400');
const _emberColor = new THREE.Color('#ff6e1c');
const _emberHotColor = new THREE.Color('#fff0aa');
const heatResponsiveMats = [];
let reentryBurnEnabled = false;
const TRAIL_SAMPLE_SPACING = 0.18;
const TRAIL_RAW_MAX_SAMPLES = 56;
const TRAIL_RENDER_SAMPLES = 112;
const TRAIL_MAX_AGE = 1.65;
const TRAIL_INSERT_LIMIT = 96;
const trailSamples = [];
const _trailTangent = new THREE.Vector3();
const _trailRadial = new THREE.Vector3();
const _trailCameraDir = new THREE.Vector3();
const _trailRight = new THREE.Vector3();
const _trailPrevRight = new THREE.Vector3();
const _trailLeftPos = new THREE.Vector3();
const _trailRightPos = new THREE.Vector3();
const _trailColor = new THREE.Color();
const _trailHeadColor = new THREE.Color('#fff0d0');
const _trailMidColor = new THREE.Color('#ff7e28');
const _trailTailColor = new THREE.Color('#7f1000');
const _trailFallbackUp = new THREE.Vector3(0, 1, 0);
const _trailRootPos = new THREE.Vector3();
const _trailCurve = new THREE.CatmullRomCurve3([], false, 'centripetal');
const trailCurvePoints = Array.from({ length: TRAIL_RENDER_SAMPLES }, () => new THREE.Vector3());

function addHeatResponsiveMaterial(material, hotColor, hotEmissive, hotIntensity) {
  heatResponsiveMats.push({
    material,
    baseColor: material.color.clone(),
    baseEmissive: material.emissive.clone(),
    baseEmissiveIntensity: material.emissiveIntensity ?? 0,
    hotColor: new THREE.Color(hotColor),
    hotEmissive: new THREE.Color(hotEmissive),
    hotIntensity,
  });
}

addHeatResponsiveMaterial(shellMat, '#631400', '#ff6a00', 1.3);
addHeatResponsiveMaterial(trimMat, '#5f1600', '#ff7d1a', 0.95);
addHeatResponsiveMaterial(darkMat, '#431000', '#ff5400', 0.8);
addHeatResponsiveMaterial(motorMat, '#652300', '#ff8a2b', 0.95);
addHeatResponsiveMaterial(legMat, '#5a1800', '#ff6b1c', 0.65);

// ── Hierarchy ────────────────────────────────
export const fgRoot = new THREE.Group();
export const drone = new THREE.Group();
export const reentryTrailRoot = new THREE.Group();
fgRoot.add(drone);

const body = new THREE.Group();
drone.add(body);

function createTrailRibbonLayer({
  width,
  opacity,
  blending,
  renderOrder,
}) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(TRAIL_RENDER_SAMPLES * 2 * 3);
  const colors = new Float32Array(TRAIL_RENDER_SAMPLES * 2 * 3);
  const uvs = new Float32Array(TRAIL_RENDER_SAMPLES * 2 * 2);
  const indices = [];
  for (let i = 0; i < TRAIL_RENDER_SAMPLES - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const material = new THREE.MeshBasicMaterial({
    map: trailTexture,
    transparent: true,
    opacity,
    blending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    vertexColors: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = renderOrder;
  reentryTrailRoot.add(mesh);

  return { mesh, geometry, positions, colors, uvs, width };
}

const trailRibbonLayers = [
  createTrailRibbonLayer({
    width: 0.22,
    opacity: 0.72,
    blending: THREE.NormalBlending,
    renderOrder: 8,
  }),
  createTrailRibbonLayer({
    width: 0.62,
    opacity: 0.24,
    blending: THREE.AdditiveBlending,
    renderOrder: 7,
  }),
];

// ── Body shell ───────────────────────────────
const mainBody = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 24, 0, Math.PI * 2, 0, Math.PI),
  shellMat,
);
mainBody.scale.set(0.22, 0.075, 0.32);
mainBody.castShadow = true;
mainBody.receiveShadow = true;
body.add(mainBody);

const topAccent = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.018, 0.42), darkMat);
topAccent.position.set(0, 0.08, 0.02);
body.add(topAccent);

const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.025, 0.44), darkMat);
bottomPlate.position.set(0, -0.08, 0);
body.add(bottomPlate);

for (let s = -1; s <= 1; s += 2) {
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.03, 0.5), trimMat);
  trim.position.set(s * 0.21, 0.01, 0);
  body.add(trim);
}

// ── Nose cone ────────────────────────────────
const nose = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  darkMat,
);
nose.rotation.x = -Math.PI / 2;
nose.position.set(0, -0.01, 0.31);
nose.scale.set(0.22, 0.06, 0.08);
body.add(nose);

// ── Camera pod ───────────────────────────────
const camHousing = new THREE.Mesh(
  new THREE.CylinderGeometry(0.055, 0.06, 0.03, 16),
  new THREE.MeshStandardMaterial({ color: '#111122', metalness: 0.9, roughness: 0.15 }),
);
camHousing.position.set(0, -0.045, 0.33);
body.add(camHousing);

const camLens = new THREE.Mesh(
  new THREE.CylinderGeometry(0.04, 0.042, 0.01, 16),
  new THREE.MeshStandardMaterial({ color: '#1a1a2e', metalness: 0.3, roughness: 0.1 }),
);
camLens.position.set(0, -0.045, 0.345);
body.add(camLens);

const camGlass = new THREE.Mesh(
  new THREE.SphereGeometry(0.032, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2),
  new THREE.MeshStandardMaterial({
    color: '#335577', metalness: 0.05, roughness: 0.05,
    emissive: '#112233', emissiveIntensity: 0.3,
  }),
);
camGlass.rotation.x = -Math.PI / 2;
camGlass.position.set(0, -0.045, 0.348);
body.add(camGlass);

const camHighlight = new THREE.Mesh(
  new THREE.SphereGeometry(0.008, 8, 8),
  new THREE.MeshBasicMaterial({ color: '#aaccff' }),
);
camHighlight.position.set(0.01, -0.03, 0.352);
body.add(camHighlight);

// ── Reentry heat / plasma ───────────────────
const heatShell = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 18),
  glowMat,
);
heatShell.position.set(0, -0.004, 0.2);
heatShell.scale.set(0.17, 0.08, 0.24);
body.add(heatShell);

const bowShock = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 18),
  bowShockMat,
);
bowShock.position.set(0, -0.005, 0.33);
bowShock.scale.set(0.08, 0.055, 0.11);
body.add(bowShock);

const reentryLight = new THREE.PointLight('#ff8f36', 0, 4.5, 2);
reentryLight.position.set(0, 0.02, 0.2);
body.add(reentryLight);

const wakeCone = new THREE.Mesh(
  aftConeGeometry,
  wakeMat,
);
wakeCone.rotation.x = Math.PI / 2;
wakeCone.position.set(0, -0.01, -0.16);
wakeCone.scale.set(0.2, 0.2, 1.35);
wakeCone.visible = false;
body.add(wakeCone);

const wakeCoreCone = new THREE.Mesh(
  aftConeGeometry,
  wakeCoreMat,
);
wakeCoreCone.rotation.x = Math.PI / 2;
wakeCoreCone.position.set(0, -0.008, -0.14);
wakeCoreCone.scale.set(0.11, 0.11, 0.95);
wakeCoreCone.visible = false;
body.add(wakeCoreCone);

const shockFlare = new THREE.Sprite(shockFlareMat);
shockFlare.position.set(0, -0.005, 0.35);
shockFlare.scale.set(0.08, 0.08, 1);
body.add(shockFlare);

const plumeSprites = [];
const plumeSpriteSpecs = [
  { width: 0.36, length: 1.8, color: '#fff3d6', opacity: 0.38, depth: 0.18, spread: 0.02, phase: 0.1, blend: THREE.NormalBlending },
  { width: 0.56, length: 2.8, color: '#ffb04d', opacity: 0.28, depth: 0.38, spread: 0.03, phase: 1.2, blend: THREE.AdditiveBlending },
  { width: 0.74, length: 4.1, color: '#ff6a1f', opacity: 0.2, depth: 0.7, spread: 0.05, phase: 2.1, blend: THREE.AdditiveBlending },
  { width: 0.96, length: 5.6, color: '#db2e00', opacity: 0.12, depth: 1.1, spread: 0.07, phase: 3.4, blend: THREE.AdditiveBlending },
];
for (let i = 0; i < plumeSpriteSpecs.length; i++) {
  const spec = plumeSpriteSpecs[i];
  const material = new THREE.SpriteMaterial({
    map: trailTexture,
    color: spec.color,
    transparent: true,
    opacity: 0,
    blending: spec.blend,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0.08);
  sprite.position.set(0, 0, -0.22 - spec.depth);
  sprite.scale.set(spec.width, spec.length, 1);
  body.add(sprite);
  plumeSprites.push({ sprite, material, ...spec });
}

const plasmaStreaks = [];
for (let i = 0; i < 28; i++) {
  const depthT = i / 27;
  const material = new THREE.SpriteMaterial({
    map: trailTexture,
    color: i < 5 ? '#fff2d0' : i < 14 ? '#ff8d2e' : '#ff3f0d',
    transparent: true,
    opacity: 0,
    blending: i < 6 ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0.08);
  body.add(sprite);
  plasmaStreaks.push({
    sprite,
    material,
    depthT,
    phase: i * 0.47,
    side: i % 2 === 0 ? -1 : 1,
    spread: 0.025 + depthT * 0.16,
    drift: 0.018 + depthT * 0.085,
    depth: 0.24 + depthT * 4.8,
    width: 0.08 + depthT * 0.16,
    length: 0.9 + depthT * 3.8,
    opacity: 0.12 + (1 - depthT) * 0.12,
  });
}

const emberSprites = [];
for (let i = 0; i < 20; i++) {
  const material = new THREE.SpriteMaterial({
    map: sparkTexture,
    color: '#ff9d3f',
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  body.add(sprite);
  emberSprites.push({
    sprite,
    material,
    phase: i * 0.73,
    side: i % 2 === 0 ? -1 : 1,
    drift: 0.4 + (i % 5) * 0.12,
    spread: 0.08 + (i % 4) * 0.035,
    depth: 0.4 + i * 0.42,
    size: 0.07 + (i % 3) * 0.025,
  });
}

function clearTrailGeometry() {
  trailSamples.length = 0;
  for (const layer of trailRibbonLayers) {
    layer.mesh.visible = false;
    layer.geometry.setDrawRange(0, 0);
  }
}

function appendTrailSample(currentPos) {
  if (trailSamples.length === 0) {
    trailSamples.unshift({ pos: currentPos.clone(), age: 0 });
    return;
  }

  const front = trailSamples[0];
  const dist = front.pos.distanceTo(currentPos);
  if (dist < TRAIL_SAMPLE_SPACING * 0.25) {
    front.pos.copy(currentPos);
    front.age = 0;
    return;
  }

  const newSamples = [{ pos: currentPos.clone(), age: 0 }];
  if (dist > TRAIL_SAMPLE_SPACING) {
    const dirBack = front.pos.clone().sub(currentPos).normalize();
    const insertCount = Math.min(
      TRAIL_INSERT_LIMIT,
      Math.max(0, Math.floor(dist / TRAIL_SAMPLE_SPACING) - 1),
    );
    for (let step = 0; step < insertCount; step++) {
      const travelled = TRAIL_SAMPLE_SPACING * (step + 1);
      newSamples.push({
        pos: currentPos.clone().addScaledVector(dirBack, travelled),
        age: 0,
      });
    }
  }

  trailSamples.unshift(...newSamples);
}

function ageTrailSamples(dt) {
  for (const sample of trailSamples) sample.age += dt;
  while (trailSamples.length > TRAIL_RAW_MAX_SAMPLES) trailSamples.pop();
  while (trailSamples.length && trailSamples[trailSamples.length - 1].age > TRAIL_MAX_AGE) {
    trailSamples.pop();
  }
}

function updateTrailGeometry(cameraPos, burn) {
  if (trailSamples.length < 2 || burn <= 0.001) {
    for (const layer of trailRibbonLayers) {
      layer.mesh.visible = false;
      layer.geometry.setDrawRange(0, 0);
    }
    return;
  }

  const rawCount = trailSamples.length;
  let renderCount = rawCount;
  if (rawCount >= 4) {
    _trailCurve.points = trailSamples.map((sample) => sample.pos);
    renderCount = Math.min(TRAIL_RENDER_SAMPLES, Math.max(rawCount * 4, 18));
    const spacedPoints = _trailCurve.getSpacedPoints(renderCount - 1);
    for (let i = 0; i < renderCount; i++) {
      trailCurvePoints[i].copy(spacedPoints[i]);
    }
  } else {
    for (let i = 0; i < renderCount; i++) {
      trailCurvePoints[i].copy(trailSamples[i].pos);
    }
  }

  const drawCount = (renderCount - 1) * 6;
  _trailRootPos.copy(trailCurvePoints[0]);
  reentryTrailRoot.position.copy(_trailRootPos);

  for (let layerIndex = 0; layerIndex < trailRibbonLayers.length; layerIndex++) {
    const layer = trailRibbonLayers[layerIndex];
    _trailPrevRight.set(0, 0, 0);
    for (let i = 0; i < renderCount; i++) {
      const samplePos = trailCurvePoints[i];
      const prevPos = i === 0 ? trailCurvePoints[i] : trailCurvePoints[i - 1];
      const nextPos = i === renderCount - 1 ? trailCurvePoints[i] : trailCurvePoints[i + 1];
      _trailTangent.copy(prevPos).sub(nextPos);
      if (_trailTangent.lengthSq() < 1e-6) _trailTangent.set(0, 0, 1);
      else _trailTangent.normalize();

      _trailRadial.copy(samplePos).sub(EARTH_POSITION);
      if (_trailRadial.lengthSq() < 1e-6) _trailRadial.copy(_trailFallbackUp);
      else _trailRadial.normalize();

      _trailRight.crossVectors(_trailRadial, _trailTangent);
      if (_trailRight.lengthSq() < 1e-6) {
        _trailCameraDir.copy(cameraPos).sub(samplePos);
        if (_trailCameraDir.lengthSq() > 1e-6) _trailCameraDir.normalize();
        _trailRight.crossVectors(_trailCameraDir, _trailTangent);
      }
      if (_trailRight.lengthSq() < 1e-6) _trailRight.set(1, 0, 0);
      else _trailRight.normalize();
      if (_trailPrevRight.lengthSq() > 0.5 && _trailRight.dot(_trailPrevRight) < 0) {
        _trailRight.multiplyScalar(-1);
      }
      if (_trailPrevRight.lengthSq() > 0.5) {
        _trailRight.lerp(_trailPrevRight, 0.62).normalize();
      }
      _trailPrevRight.copy(_trailRight);

      const ageT = renderCount <= 1 ? 0 : i / (renderCount - 1);
      const life = Math.pow(1 - ageT, 0.78);
      const flare = 0.58 + 0.42 * Math.pow(1 - ageT, 0.4);
      const width = layer.width * life * flare * (0.72 + burn * 0.38);
      _trailLeftPos.copy(samplePos).addScaledVector(_trailRight, width).sub(_trailRootPos);
      _trailRightPos.copy(samplePos).addScaledVector(_trailRight, -width).sub(_trailRootPos);

      const posOffset = i * 6;
      layer.positions[posOffset + 0] = _trailLeftPos.x;
      layer.positions[posOffset + 1] = _trailLeftPos.y;
      layer.positions[posOffset + 2] = _trailLeftPos.z;
      layer.positions[posOffset + 3] = _trailRightPos.x;
      layer.positions[posOffset + 4] = _trailRightPos.y;
      layer.positions[posOffset + 5] = _trailRightPos.z;

      _trailColor.copy(_trailHeadColor)
        .lerp(_trailMidColor, Math.min(1, ageT * 1.25))
        .lerp(_trailTailColor, Math.max(0, ageT - 0.45) / 0.55)
        .multiplyScalar((0.35 + life * 0.65) * (layerIndex === 0 ? 1 : 0.78));

      const colorOffset = i * 6;
      layer.colors[colorOffset + 0] = _trailColor.r;
      layer.colors[colorOffset + 1] = _trailColor.g;
      layer.colors[colorOffset + 2] = _trailColor.b;
      layer.colors[colorOffset + 3] = _trailColor.r;
      layer.colors[colorOffset + 4] = _trailColor.g;
      layer.colors[colorOffset + 5] = _trailColor.b;

      const uvOffset = i * 4;
      const vCoord = 1 - ageT;
      layer.uvs[uvOffset + 0] = 0;
      layer.uvs[uvOffset + 1] = vCoord;
      layer.uvs[uvOffset + 2] = 1;
      layer.uvs[uvOffset + 3] = vCoord;
    }

    layer.geometry.attributes.position.needsUpdate = true;
    layer.geometry.attributes.color.needsUpdate = true;
    layer.geometry.attributes.uv.needsUpdate = true;
    layer.geometry.computeBoundingSphere();
    layer.geometry.setDrawRange(0, drawCount);
    layer.mesh.visible = true;
  }
}

// ── Antenna mast ─────────────────────────────
const antBase = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.04, 8), darkMat);
antBase.position.set(0, 0.09, -0.08);
body.add(antBase);

const antMast = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.16, 8), trimMat);
antMast.position.set(0, 0.18, -0.08);
body.add(antMast);

// ── Vents ────────────────────────────────────
for (let v = 0; v < 3; v++) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.006, 0.25), darkMat);
  vent.position.set(0, 0.09, -0.05 + v * 0.09);
  body.add(vent);
}

// ── Blinking lights ──────────────────────────
const blinkData = [];
function addBlinker(mesh, phase, speed) {
  blinkData.push({
    mesh, phase, speed,
    baseIntensity: mesh.material.emissiveIntensity || 0.5,
  });
}

const beacon = new THREE.Mesh(
  new THREE.SphereGeometry(0.018, 8, 8),
  new THREE.MeshStandardMaterial({
    color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1.5,
    metalness: 0.1, roughness: 0.2,
  }),
);
beacon.position.set(0, 0.1, -0.22);
body.add(beacon);
addBlinker(beacon, 0, 4.0);

const navLightGeo = new THREE.SphereGeometry(0.015, 8, 8);

const navRed = new THREE.Mesh(navLightGeo, new THREE.MeshStandardMaterial({
  color: '#ff3333', emissive: '#ff0000', emissiveIntensity: 1.2, metalness: 0.1, roughness: 0.2,
}));
navRed.position.set(-0.2, 0.03, 0.26);
body.add(navRed);
addBlinker(navRed, 0.5, 3.5);

const navGreen = new THREE.Mesh(navLightGeo, new THREE.MeshStandardMaterial({
  color: '#33ff33', emissive: '#00ff00', emissiveIntensity: 1.2, metalness: 0.1, roughness: 0.2,
}));
navGreen.position.set(0.2, 0.03, 0.26);
body.add(navGreen);
addBlinker(navGreen, 1.0, 3.5);

const navWhite = new THREE.Mesh(navLightGeo, new THREE.MeshStandardMaterial({
  color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.8, metalness: 0.1, roughness: 0.2,
}));
navWhite.position.set(0, 0.03, -0.3);
body.add(navWhite);
addBlinker(navWhite, 0.75, 2.8);

const ledGeo = new THREE.BoxGeometry(0.016, 0.01, 0.45);
for (let s = -1; s <= 1; s += 2) {
  const ledStrip = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({
    color: '#4a9eff', emissive: '#4a9eff', emissiveIntensity: 0.8, metalness: 0.2, roughness: 0.3,
  }));
  ledStrip.position.set(s * 0.2, 0.02, 0.02);
  body.add(ledStrip);
  addBlinker(ledStrip, s * 0.3, 1.5);
}

// ── Arms + rotors ────────────────────────────
const rotorGroups = [];
const armAngles = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4];

armAngles.forEach((angle) => {
  const armG = new THREE.Group();
  armG.rotation.y = angle;
  body.add(armG);

  const armLen = 0.58;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, armLen, 12), shellMat);
  arm.castShadow = true;
  arm.rotation.x = Math.PI / 2;
  arm.position.set(0, 0.015, armLen / 2 + 0.18);
  armG.add(arm);

  const fairing = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.032, 0.1, 12), trimMat);
  fairing.rotation.x = Math.PI / 2;
  fairing.position.set(0, 0.015, 0.22);
  armG.add(fairing);

  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 16), motorMat);
  motor.castShadow = true;
  motor.position.set(0, 0.02, armLen + 0.18);
  armG.add(motor);

  const motorCap = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.05, 0.015, 16), darkMat);
  motorCap.position.set(0, 0.07, armLen + 0.18);
  armG.add(motorCap);

  for (let v = 0; v < 4; v++) {
    const vAngle = v * Math.PI / 2;
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.06, 0.006), darkMat);
    vent.position.set(
      Math.cos(vAngle) * 0.052,
      0.02,
      armLen + 0.18 + Math.sin(vAngle) * 0.052,
    );
    armG.add(vent);
  }

  // Rotor (3-blade)
  const rotor = new THREE.Group();
  rotor.position.set(0, 0.1, armLen + 0.18);
  armG.add(rotor);
  rotorGroups.push(rotor);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 16), darkMat);
  rotor.add(hub);

  const hubTop = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    trimMat,
  );
  hubTop.position.y = 0.014;
  rotor.add(hubTop);

  for (let b = 0; b < 3; b++) {
    const bladeG = new THREE.Group();
    bladeG.rotation.y = b * Math.PI * 2 / 3;
    rotor.add(bladeG);
    for (let side = -1; side <= 1; side += 2) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.004, 0.22), bladeMat);
      blade.position.set(0, 0, side * 0.11);
      bladeG.add(blade);
    }
  }
});

// ── Landing gear ─────────────────────────────
for (let side = -1; side <= 1; side += 2) {
  const legG = new THREE.Group();
  legG.position.set(side * 0.14, -0.08, 0.05);
  body.add(legG);

  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.14, 8), legMat);
  leg.castShadow = true;
  leg.rotation.z = side * 0.35;
  leg.position.y = -0.05;
  legG.add(leg);

  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.01, 0.08), darkMat);
  foot.position.set(0, -0.12, 0.01);
  legG.add(foot);
}

drone.position.set(0, 0, 0);
drone.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
fgRoot.traverse((node) => {
  node.layers.set(LOCAL_LIGHT_LAYER);
});

// ── Per-frame updates ────────────────────────
export function updateRotors(dt, droneSpeed) {
  const rotorSpd = 0.2 + droneSpeed * 0.015;
  rotorGroups.forEach((r, i) => {
    const dir = i % 2 === 0 ? 1 : -1;
    r.rotation.y += dir * rotorSpd * dt * 68 * (1 + i * 0.03);
  });
}

export function updateBlinkers(time) {
  for (const bd of blinkData) {
    if (bd.speed > 3.5) {
      // Fast strobe
      bd.mesh.material.emissiveIntensity =
        bd.baseIntensity * (Math.sin(time * bd.speed) > 0.6 ? 1.5 : 0.2);
    } else {
      const v = 0.5 + 0.5 * Math.sin(time * bd.speed + bd.phase);
      bd.mesh.material.emissiveIntensity = bd.baseIntensity * (0.7 + 0.3 * v);
    }
  }
}

function applyReentryBurn(time, burn) {
  const flicker = burn > 0
    ? 0.82 + 0.18 * Math.sin(time * 26) + 0.08 * Math.sin(time * 53 + 0.7)
    : 1;
  const hotness = burn * flicker;
  const wakeStrength = Math.pow(burn, 0.86);

  for (const data of heatResponsiveMats) {
    data.material.color.copy(data.baseColor).lerp(data.hotColor, burn * 0.55);
    data.material.emissive.copy(data.baseEmissive).lerp(data.hotEmissive, burn);
    data.material.emissiveIntensity = THREE.MathUtils.lerp(
      data.baseEmissiveIntensity,
      data.hotIntensity,
      hotness,
    );
  }

  glowMat.opacity = 0.2 * hotness;
  _tmpColor.set('#ff7b24').lerp(_burnGlowColor, burn * 0.44);
  glowMat.color.copy(_tmpColor);
  heatShell.scale.set(
    0.18 + burn * 0.08,
    0.09 + burn * 0.04,
    0.25 + burn * 0.12,
  );

  bowShockMat.opacity = 0.26 * hotness;
  bowShockMat.color.copy(_wakeShockColor).lerp(_burnGlowColor, burn * 0.08);
  bowShock.scale.set(
    0.08 + burn * 0.08,
    0.055 + burn * 0.03,
    0.11 + burn * 0.09,
  );
  bowShock.position.z = 0.33 + burn * 0.04;

  shockFlareMat.opacity = 0.18 * hotness;
  shockFlareMat.color.copy(_burnGlowColor).lerp(_wakeShockColor, 0.12);
  const flareScale = 0.07 + burn * 0.05;
  shockFlare.scale.set(flareScale, flareScale, 1);
  shockFlare.position.z = 0.35 + burn * 0.03;

  wakeMat.opacity = 0;
  wakeCoreMat.opacity = 0;

  for (const layer of plumeSprites) {
    layer.material.opacity = 0;
  }
  for (const streak of plasmaStreaks) {
    streak.material.opacity = 0;
  }
  for (const ember of emberSprites) {
    ember.material.opacity = 0;
  }

  reentryLight.intensity = 25_000 * hotness;
  reentryLight.distance = 6 + burn * 4.5;
}

export function updateReentryEffect({
  time,
  dt,
  altitude,
  dronePos,
  cameraPos,
}) {
  const burnT = reentryBurnEnabled
    ? 1 - THREE.MathUtils.smoothstep(
      altitude,
      REENTRY_BURN_FULL_ALTITUDE,
      REENTRY_BURN_START_ALTITUDE,
    )
    : 0;
  const burn = THREE.MathUtils.clamp(burnT, 0, 1);

  applyReentryBurn(time, burn);
  ageTrailSamples(dt);
  if (burn > 0.03) appendTrailSample(dronePos);
  updateTrailGeometry(cameraPos, burn);
}

export function setReentryBurnEnabled(on) {
  reentryBurnEnabled = on;
  if (!on) {
    applyReentryBurn(0, 0);
    clearTrailGeometry();
  }
}

export function setDroneShadowsEnabled(on) {
  fgRoot.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = on;
      node.receiveShadow = on;
    }
  });
}
