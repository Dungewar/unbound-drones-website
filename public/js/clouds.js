// Procedurally generated Earth cloud layer — climate-banded coverage with cyclonic swirls.

import * as THREE from './three.module.js';

import { generateCloudDeckBytes } from './clouds-shared.js';
import { renderer } from './scene.js';
import { EARTH_R, TERRAIN_EXAGGERATION } from './config.js';
import { earthGroup, earthPreviewTex } from './earth.js';
import { sunDirUniform } from './sun.js';

const maxTextureSize = renderer.capabilities.maxTextureSize;
const deviceMemory = navigator.deviceMemory ?? 8;
const hardwareConcurrency = navigator.hardwareConcurrency ?? 4;
const CLOUD_PREVIEW_WIDTH = maxTextureSize >= 16384 ? 1536 : maxTextureSize >= 8192 ? 1024 : 512;
const CLOUD_FINAL_WIDTH = maxTextureSize >= 16384
  ? (deviceMemory >= 8 && hardwareConcurrency >= 8 ? 4096 : 3072)
  : maxTextureSize >= 8192 ? 2048 : 1024;
const CLOUD_PREVIEW_HEIGHT = CLOUD_PREVIEW_WIDTH / 2;
const CLOUD_FINAL_HEIGHT = CLOUD_FINAL_WIDTH / 2;
const EARTH_GUIDE_MAX_DIM = maxTextureSize >= 16384 ? 2048 : 1024;
const CLOUD_PATTERN_SCALE = maxTextureSize >= 16384 ? 1.42 : 1.28;
const CLOUD_SEGMENTS_W = 256;
const CLOUD_SEGMENTS_H = 128;
const SHELL_SEGMENTS_W = 256;
const SHELL_SEGMENTS_H = 128;
const LOW_CLOUD_ALTITUDE = 1500;
const MID_CLOUD_ALTITUDE = 5500;
const CIRRUS_ALTITUDE = 10000;
const LOW_CLOUD_THICKNESS = 1500;
const MID_CLOUD_THICKNESS = 1800;
const CIRRUS_THICKNESS = 1000;
const SUB_SHELL_SEGS_W = 128;
const SUB_SHELL_SEGS_H = 64;
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

function randomUnitFloat() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0xffffffff;
  }
  return Math.random();
}

function createDefaultCloudSeed() {
  return randomUnitFloat() * 1000;
}

const cloudSearch = new URLSearchParams(window.location.search);
const cloudSeedParam = cloudSearch.get('cloudSeed');
const parsedCloudSeed = cloudSeedParam === null ? Number.NaN : Number.parseFloat(cloudSeedParam);
const CLOUD_SEED = Number.isFinite(parsedCloudSeed) ? parsedCloudSeed : createDefaultCloudSeed();
window.__UNBOUND_CLOUD_SEED = CLOUD_SEED;

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ── Texture helpers ──────────────────────────
function createTexture(bytes, width, height, colorSpace, format = THREE.RGBAFormat) {
  const texture = new THREE.DataTexture(bytes, width, height, format);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  if (maxAnisotropy > 1) texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  renderer.initTexture(texture);
  texture.image.data = null;
  return texture;
}

function rgbToRgba(rgb) {
  const count = rgb.length / 3;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const si = i * 3;
    const di = i * 4;
    rgba[di] = rgb[si];
    rgba[di + 1] = rgb[si + 1];
    rgba[di + 2] = rgb[si + 2];
    rgba[di + 3] = 255;
  }
  return rgba;
}

function blurField(source, width, height, radius) {
  const out = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      let samples = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        const sy = Math.min(height - 1, Math.max(0, y + ky));
        for (let kx = -radius; kx <= radius; kx++) {
          const sx = (x + kx + width) % width;
          acc += source[sy * width + sx];
          samples += 1;
        }
      }
      out[y * width + x] = acc / samples;
    }
  }
  return out;
}

function readImagePixels(image, targetMaxDim) {
  const srcWidth = image?.width ?? image?.videoWidth ?? 0;
  const srcHeight = image?.height ?? image?.videoHeight ?? 0;
  if (!srcWidth || !srcHeight) return null;
  let width = srcWidth;
  let height = srcHeight;
  if (targetMaxDim && Math.max(srcWidth, srcHeight) > targetMaxDim) {
    const scale = targetMaxDim / Math.max(srcWidth, srcHeight);
    width = Math.max(1, Math.round(srcWidth * scale));
    height = Math.max(1, Math.round(srcHeight * scale));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

// ── Earth guide (ocean/land/desert/ice classification from colour texture) ──
function createEarthGuide(colorTexture) {
  const colorPixels = readImagePixels(colorTexture?.image, EARTH_GUIDE_MAX_DIM);
  if (!colorPixels) return null;
  const { width, height, data: rgba } = colorPixels;
  const ocean = new Float32Array(width * height);
  const land = new Float32Array(width * height);
  const desert = new Float32Array(width * height);
  const ice = new Float32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const px = i * 4;
    const r = rgba[px + 0] / 255;
    const g = rgba[px + 1] / 255;
    const b = rgba[px + 2] / 255;
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const sat = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
    const blueDominance = b - Math.max(r * 0.82, g * 0.92);
    const warmBias = r * 0.92 + g * 0.58 - b * 0.9;

    const iceMask = clamp01(
      smoothstep(0.62, 0.92, lum) *
      (1 - smoothstep(0.12, 0.34, sat))
    );
    const oceanMask = clamp01(
      smoothstep(0.02, 0.22, blueDominance) *
      (1 - iceMask) *
      (0.45 + sat * 0.55) *
      (1 - smoothstep(0.68, 0.92, lum))
    );
    const desertMask = clamp01(
      smoothstep(0.48, 0.82, lum) *
      smoothstep(0.08, 0.42, warmBias) *
      (1 - oceanMask) *
      (1 - iceMask)
    );

    ocean[i] = oceanMask;
    ice[i] = iceMask;
    desert[i] = desertMask;
    land[i] = clamp01(1 - oceanMask * 0.94 - iceMask * 0.32);
  }

  let elevation = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    elevation[i] = land[i] * (1 - desert[i] * 0.5) * (1 - ice[i] * 0.4);
  }
  elevation = blurField(elevation, width, height, 6);

  return { width, height, ocean, land, desert, ice, elevation };
}

function serializeEarthGuide(guide) {
  if (!guide) return null;
  return {
    width: guide.width,
    height: guide.height,
    ocean: guide.ocean,
    land: guide.land,
    desert: guide.desert,
    ice: guide.ice,
    elevation: guide.elevation,
  };
}

function getEarthGuideTransferList(guide) {
  if (!guide) return [];
  return [
    guide.ocean.buffer,
    guide.land.buffer,
    guide.desert.buffer,
    guide.ice.buffer,
    guide.elevation.buffer,
  ];
}

// ── Cloud deck texture management ────────────
function createCloudDeckTextures(deckSet) {
  const { width, height } = deckSet;
  return {
    width,
    height,
    lowColor: createTexture(rgbToRgba(deckSet.lowColor), width, height, THREE.SRGBColorSpace, THREE.RGBAFormat),
    lowAlpha: createTexture(deckSet.lowAlpha, width, height, THREE.NoColorSpace, THREE.RedFormat),
    lowDepth: createTexture(deckSet.lowDepth, width, height, THREE.NoColorSpace, THREE.RedFormat),
    midColor: createTexture(rgbToRgba(deckSet.midColor), width, height, THREE.SRGBColorSpace, THREE.RGBAFormat),
    midAlpha: createTexture(deckSet.midAlpha, width, height, THREE.NoColorSpace, THREE.RedFormat),
    midDepth: createTexture(deckSet.midDepth, width, height, THREE.NoColorSpace, THREE.RedFormat),
    cirrusColor: createTexture(rgbToRgba(deckSet.cirrusColor), width, height, THREE.SRGBColorSpace, THREE.RGBAFormat),
    cirrusAlpha: createTexture(deckSet.cirrusAlpha, width, height, THREE.NoColorSpace, THREE.RedFormat),
    cirrusDepth: createTexture(deckSet.cirrusDepth, width, height, THREE.NoColorSpace, THREE.RedFormat),
  };
}

function buildCloudDeck(width, height, earthGuide) {
  return createCloudDeckTextures(generateCloudDeckBytes({
    width,
    height,
    earthGuide,
    cloudSeed: CLOUD_SEED,
    patternScale: CLOUD_PATTERN_SCALE,
  }));
}

function disposeCloudDeck(deck) {
  Object.values(deck).forEach((texture) => texture?.dispose?.());
}

function releaseEarthGuide() {
  earthGuide = null;
}

// ── Init ─────────────────────────────────────
let earthGuide = createEarthGuide(earthPreviewTex);
let cloudDeck = buildCloudDeck(CLOUD_PREVIEW_WIDTH, CLOUD_PREVIEW_HEIGHT, earthGuide);
earthPreviewTex.dispose();
earthPreviewTex.image = null;
const cloudRoot = new THREE.Group();
earthGroup.add(cloudRoot);
let cloudTexturesEnabled = true;
let cloudWorker = null;
const cloudShadowsEnabledUniform = { value: 1 };
window.__UNBOUND_CLOUD_ATLAS = {
  previewWidth: CLOUD_PREVIEW_WIDTH,
  finalWidth: CLOUD_FINAL_WIDTH,
  activeWidth: cloudDeck.width,
  patternScale: CLOUD_PATTERN_SCALE,
};

// ── Cloud layer factory ──────────────────────
// shellHeight (0–1): 0 = base shell (full coverage), >0 = volumetric sub-shell
// (only pixels whose depth exceeds shellHeight are visible, creating 3D shapes).
function createCloudLayer({
  altitude,
  thickness,
  geometrySegmentsW,
  geometrySegmentsH,
  colorMap,
  alphaMap,
  depthMap,
  opacity,
  bumpScale,
  shellHeight = 0,
}) {
  const thicknessScaled = thickness * TERRAIN_EXAGGERATION;
  const shellHeightUniform = { value: shellHeight };
  const material = new THREE.MeshPhongMaterial({
    color: '#ffffff',
    map: colorMap,
    alphaMap,
    displacementMap: depthMap,
    displacementScale: thicknessScaled,
    displacementBias: 0,
    bumpMap: depthMap,
    bumpScale,
    transparent: true,
    opacity,
    depthWrite: false,
    emissive: new THREE.Color('#000000'),
    emissiveIntensity: 0,
    specular: new THREE.Color('#000000'),
    shininess: 1,
    fog: false,
  });
  material.userData.colorMap = colorMap;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sunDirUniform;
    shader.uniforms.uCloudShadowsEnabled = cloudShadowsEnabledUniform;
    shader.uniforms.uShellHeight = shellHeightUniform;
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'varying vec3 vShellWorldNormal;\nvoid main() {',
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\nvShellWorldNormal = normalize(mat3(modelMatrix) * normalize(position));',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform vec3 uSunDir;\nuniform float uCloudShadowsEnabled;\nuniform float uShellHeight;\nvarying vec3 vShellWorldNormal;\nvoid main() {',
    );
    const alphaMapFragment = `#ifdef USE_ALPHAMAP
        diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).r;
      #endif${
        shellHeight > 0
          ? `
        float _cloudThickness = texture2D(bumpMap, vBumpMapUv).r;
        diffuseColor.a *= smoothstep(uShellHeight - 0.1, uShellHeight + 0.08, _cloudThickness);`
          : ''
      }`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      alphaMapFragment,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_phong_fragment>',
      `#include <lights_phong_fragment>
      float _cloudDayFactor = mix(1.0, smoothstep(-0.08, 0.05, dot(vShellWorldNormal, uSunDir)), uCloudShadowsEnabled);
      reflectedLight.directDiffuse *= _cloudDayFactor;
      reflectedLight.directSpecular *= _cloudDayFactor;
      reflectedLight.indirectDiffuse *= _cloudDayFactor;
      reflectedLight.indirectDiffuse += diffuseColor.rgb * (300.0 + 54000.0 * (1.0 - uCloudShadowsEnabled));`,
    );
  };
  material.needsUpdate = true;

  return new THREE.Mesh(
    new THREE.SphereGeometry(
      EARTH_R + altitude * TERRAIN_EXAGGERATION,
      geometrySegmentsW,
      geometrySegmentsH,
    ),
    material,
  );
}

// ── 3D cloud shells ──────────────────────────
const cloudMesh = createCloudLayer({
  altitude: LOW_CLOUD_ALTITUDE,
  thickness: LOW_CLOUD_THICKNESS,
  geometrySegmentsW: CLOUD_SEGMENTS_W,
  geometrySegmentsH: CLOUD_SEGMENTS_H,
  colorMap: cloudDeck.lowColor,
  alphaMap: cloudDeck.lowAlpha,
  depthMap: cloudDeck.lowDepth,
  opacity: 1.0,
  bumpScale: 0.45,
});
cloudMesh.renderOrder = 4;
cloudRoot.add(cloudMesh);

const midMesh = createCloudLayer({
  altitude: MID_CLOUD_ALTITUDE,
  thickness: MID_CLOUD_THICKNESS,
  geometrySegmentsW: SHELL_SEGMENTS_W,
  geometrySegmentsH: SHELL_SEGMENTS_H,
  colorMap: cloudDeck.midColor,
  alphaMap: cloudDeck.midAlpha,
  depthMap: cloudDeck.midDepth,
  opacity: 0.85,
  bumpScale: 0.32,
});
midMesh.renderOrder = 5;
cloudRoot.add(midMesh);

const cirrusMesh = createCloudLayer({
  altitude: CIRRUS_ALTITUDE,
  thickness: CIRRUS_THICKNESS,
  geometrySegmentsW: SHELL_SEGMENTS_W,
  geometrySegmentsH: SHELL_SEGMENTS_H,
  colorMap: cloudDeck.cirrusColor,
  alphaMap: cloudDeck.cirrusAlpha,
  depthMap: cloudDeck.cirrusDepth,
  opacity: 0.35,
  bumpScale: 0.18,
});
cirrusMesh.renderOrder = 7;
cloudRoot.add(cirrusMesh);

// ── Volumetric sub-shells (3D puffy depth) ───
function createSubShells(baseAlt, thickness, colorMap, alphaMap, depthMap, baseOpacity, baseBumpScale, count, baseRenderOrder) {
  const shells = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const shell = createCloudLayer({
      altitude: baseAlt + thickness * t,
      thickness: thickness * Math.max(0.05, 1 - t) * 0.4,
      geometrySegmentsW: SUB_SHELL_SEGS_W,
      geometrySegmentsH: SUB_SHELL_SEGS_H,
      colorMap,
      alphaMap,
      depthMap,
      opacity: baseOpacity * 0.25 * (1 - t * 0.5),
      bumpScale: baseBumpScale * (1 - t * 0.6),
    });
    shell.renderOrder = baseRenderOrder;
    cloudRoot.add(shell);
    shells.push(shell);
  }
  return shells;
}

const lowSubs = createSubShells(LOW_CLOUD_ALTITUDE, LOW_CLOUD_THICKNESS, cloudDeck.lowColor, cloudDeck.lowAlpha, cloudDeck.lowDepth, 1.0, 0.45, 2, 4);
const midSubs = createSubShells(MID_CLOUD_ALTITUDE, MID_CLOUD_THICKNESS, cloudDeck.midColor, cloudDeck.midAlpha, cloudDeck.midDepth, 0.85, 0.32, 2, 5);
const cirrusSubs = createSubShells(CIRRUS_ALTITUDE, CIRRUS_THICKNESS, cloudDeck.cirrusColor, cloudDeck.cirrusAlpha, cloudDeck.cirrusDepth, 0.35, 0.18, 1, 7);

const allLowMeshes = [cloudMesh, ...lowSubs];
const allMidMeshes = [midMesh, ...midSubs];
const allCirrusMeshes = [cirrusMesh, ...cirrusSubs];
const allCloudMeshes = [...allLowMeshes, ...allMidMeshes, ...allCirrusMeshes];

// ── Hot-swap cloud deck textures ─────────────
function applyCloudDeckToMeshes(meshes, nextColorMap, nextAlphaMap, nextDepthMap) {
  for (const mesh of meshes) {
    mesh.material.userData.colorMap = nextColorMap;
    mesh.material.map = nextColorMap;
    mesh.material.alphaMap = nextAlphaMap;
    mesh.material.displacementMap = nextDepthMap;
    mesh.material.bumpMap = nextDepthMap;
    mesh.material.needsUpdate = true;
  }
}

function swapCloudDeck(nextDeck) {
  const previousDeck = cloudDeck;
  cloudDeck = nextDeck;
  window.__UNBOUND_CLOUD_ATLAS.activeWidth = nextDeck.width;
  applyCloudDeckToMeshes(allLowMeshes, nextDeck.lowColor, nextDeck.lowAlpha, nextDeck.lowDepth);
  applyCloudDeckToMeshes(allMidMeshes, nextDeck.midColor, nextDeck.midAlpha, nextDeck.midDepth);
  applyCloudDeckToMeshes(allCirrusMeshes, nextDeck.cirrusColor, nextDeck.cirrusAlpha, nextDeck.cirrusDepth);
  disposeCloudDeck(previousDeck);
}

// ── High-res worker ──────────────────────────
function requestHighResCloudDeck() {
  if (typeof Worker === 'undefined') {
    releaseEarthGuide();
    return;
  }
  if (CLOUD_FINAL_WIDTH <= CLOUD_PREVIEW_WIDTH) {
    releaseEarthGuide();
    return;
  }

  const guideForWorker = serializeEarthGuide(earthGuide);
  const transferList = getEarthGuideTransferList(guideForWorker);
  releaseEarthGuide();
  const worker = new Worker(new URL('./clouds-worker.js', import.meta.url).href, { type: 'module' });
  cloudWorker = worker;
  const requestId = `${Date.now()}-${Math.random()}`;

  worker.onmessage = (event) => {
    if (event.data?.id !== requestId) return;
    swapCloudDeck(createCloudDeckTextures(event.data.deckSet));
    cloudWorker = null;
    worker.terminate();
  };

  worker.onerror = () => {
    cloudWorker = null;
    worker.terminate();
  };

  worker.postMessage({
    id: requestId,
    width: CLOUD_FINAL_WIDTH,
    height: CLOUD_FINAL_HEIGHT,
    earthGuide: guideForWorker,
    cloudSeed: CLOUD_SEED,
    patternScale: CLOUD_PATTERN_SCALE,
  }, transferList);
}

requestHighResCloudDeck();

// ── Public API ───────────────────────────────
let cirrusRotation = 0.014;

export function setCloudTextureLightingMode(texturesOn) {
  cloudTexturesEnabled = texturesOn;
  allCloudMeshes.forEach((mesh) => {
    mesh.material.emissive.set(texturesOn ? '#000000' : '#f0f4ff');
    mesh.material.emissiveIntensity = texturesOn ? 0 : 0.55;
    mesh.material.needsUpdate = true;
  });
}

export function setCloudsVisible(visible) {
  allCloudMeshes.forEach((m) => { m.visible = visible; });
}

export function setCloudShadowsEnabled(enabled) {
  cloudShadowsEnabledUniform.value = enabled ? 1 : 0;
}

export function updateClouds(dt) {
  cirrusRotation += dt * 0.00060;
  allLowMeshes.forEach((m) => { m.rotation.y = 0; });
  allMidMeshes.forEach((m) => { m.rotation.y = 0; });
  allCirrusMeshes.forEach((m) => { m.rotation.y = cirrusRotation; m.rotation.x = 0.006; });
}

export function disposeClouds() {
  cloudWorker?.terminate();
  cloudWorker = null;
  disposeCloudDeck(cloudDeck);
  allCloudMeshes.forEach((mesh) => {
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  });
  cloudRoot.removeFromParent();
}
