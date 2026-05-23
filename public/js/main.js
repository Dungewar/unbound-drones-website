// Entry point — wires the scene graph together and runs the animation loop.
//
// Each system lives in its own module. This file handles: module wiring,
// scroll → flight state → drone position/orientation → camera, per-frame
// system updates, debug toggles, and cleanup.

import * as THREE from 'three';

import {
  EARTH_R, SV_LOCAL, SV_LAT, SV_LON, EARTH_POSITION, DEFAULT_SUN_WORLD_DIR,
  IDLE_DRONE_ALTITUDE, FLIGHT_SCROLL_THRESHOLD,
  IDLE_EARTH_ROTATION_SPEED, FLIGHT_EARTH_ROTATION_FACTOR,
  DRONE_ORIENT_BEGIN_T, DRONE_ORIENT_FULL_T,
} from './config.js';
import {
  renderer, scene, camera, updateLocalLights,
  disposeSceneRuntime, setSceneShadowsEnabled,
  setLocalLightRigVisible, LOCAL_LIGHT_LAYER,
} from './scene.js';
import {
  drone, fgRoot, reentryTrailRoot, updateRotors, updateBlinkers, updateReentryEffect,
  setReentryBurnEnabled,
  setDroneShadowsEnabled,
} from './drone.js';
import {
  earthGroup, earthSurface,
  setEarthTextureLightingMode, setEarthLODHeatmapMode,
  setDistanceLODEnabled, setEarthShadowsEnabled, setTextureLODEnabled, setLODDistanceMode, setLODAggression,
  updateEarthTextureLOD, disposeEarthRuntime,
  preloadInitialBumpGeometry, preloadAllTileTexturesAsync,
  earthPreviewReady, firstGeometryReady, geometryApplied,
  queryBumpHeight,
} from './earth.js';
import { loadingInit, loadingItemDone, loadingSetItemStatus, loadingDone } from './loading.js';
import { sunGroup, setSunWorldDirection, setSunShadowsEnabled, disposeSun } from './sun.js';
import { attachAtmosphere, setAtmosphereVisible, disposeAtmosphere } from './atmosphere.js';
import { starfield } from './stars.js';
import { computeFlightState } from './flight.js';
import { initUI, getScrollProgress } from './ui.js';
import { buildIdleFrame, createCameraController } from './camera.js';

// ── Wire modules ─────────────────────────────
scene.add(fgRoot);
scene.add(reentryTrailRoot);
attachAtmosphere(earthGroup);

let isDisposed = false;
const cleanupUI = initUI();

function randomUnitFloat() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0xffffffff;
  }
  return Math.random();
}

function resolveInitialEarthRotation() {
  const param = new URLSearchParams(window.location.search).get('earthRotation');
  const parsed = param === null ? Number.NaN : Number.parseFloat(param);
  if (Number.isFinite(parsed)) return parsed;
  return (randomUnitFloat() - 0.5) * Math.PI * 2;
}

// ── Initial state ────────────────────────────
const yAxis = new THREE.Vector3(0, 1, 0);
let earthRotation = resolveInitialEarthRotation();
window.__UNBOUND_EARTH_ROTATION = earthRotation;
earthGroup.rotation.y = earthRotation;

let flightStartEarthRot = 0;
let wasInFlight = false;

// Drone idle position: high above SV at the un-rotated SV vector.
const fixedSV = SV_LOCAL.clone().add(EARTH_POSITION);
const fixedOut = SV_LOCAL.clone().normalize();
const idleDronePos = fixedSV.clone().addScaledVector(fixedOut, IDLE_DRONE_ALTITUDE);
fgRoot.position.copy(idleDronePos);
drone.position.set(0, 0, 0);

// Idle frame: camera offset, look offset, sun direction
const idleFrame = buildIdleFrame(idleDronePos, fixedOut, yAxis);
{
  camera.position.copy(idleDronePos).add(idleFrame.cameraOffset);
  const idleLookTarget = idleDronePos.clone().add(idleFrame.lookOffset);
  camera.lookAt(idleLookTarget);
  setSunWorldDirection(idleFrame.sunWorldDir);
}
setSunWorldDirection(DEFAULT_SUN_WORLD_DIR);

  // Kick off bump-geometry worker now that camera is at its idle position
  preloadInitialBumpGeometry();

// Create the camera controller (captures idle constants via closure)
const updateCamera = createCameraController(camera, {
  idleFrame,
  idleCamOffset: idleFrame.cameraOffset.clone(),
  idleCamUp: camera.up.clone(),
  idleDronePos,
});

// Cloud stubs — replaced once the clouds module loads during init
let updateClouds = () => {};
let setCloudsVisible = () => {};
let setCloudTextureLightingMode = () => {};
let setCloudShadowsEnabled = () => {};
let cleanupClouds = () => {};
let cloudsOn = true;
let textureDebugMode = 'textures';
let rafId = 0;

async function loadClouds() {
  const mod = await import('./clouds.js');
  if (isDisposed) { mod.disposeClouds?.(); return; }
  updateClouds = mod.updateClouds;
  setCloudsVisible = mod.setCloudsVisible || (() => {});
  setCloudTextureLightingMode = mod.setCloudTextureLightingMode || (() => {});
  setCloudShadowsEnabled = mod.setCloudShadowsEnabled || (() => {});
  cleanupClouds = mod.disposeClouds || (() => {});
  setCloudsVisible(cloudsOn);
  setCloudTextureLightingMode(textureDebugMode === 'textures');
  setCloudShadowsEnabled(shadowsOn);
}

// ── Loading orchestration ───────────────────────
const LOADING_TIMEOUT_MS = 15000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => {
      console.warn('[loading] timed out waiting for:', label);
      resolve();
    }, LOADING_TIMEOUT_MS)),
  ]);
}

loadingInit([
  { id: 'earth-imagery', label: 'Downloading earth imagery…' },
  { id: 'terrain-mesh', label: 'Building terrain mesh…' },
  { id: 'apply-mesh', label: 'Applying terrain mesh…' },
  { id: 'cloud-patterns', label: 'Generating cloud patterns…' },
  { id: 'earth-textures', label: 'Loading earth textures…' },
]);

// All work already kicked off — transition items to Loading state.
loadingSetItemStatus('earth-imagery', 'Loading…');
loadingSetItemStatus('terrain-mesh', 'Loading…');
loadingSetItemStatus('apply-mesh', 'Loading…');
loadingSetItemStatus('cloud-patterns', 'Loading…');
loadingSetItemStatus('earth-textures', 'Loading…');

// Start all loads in parallel — each marks its line done as it finishes.
const p1 = withTimeout(earthPreviewReady, 'earth preview').then(() => loadingItemDone('earth-imagery'));
const p2 = withTimeout(firstGeometryReady, 'bump geometry').then(() => loadingItemDone('terrain-mesh'));
const p3 = withTimeout(loadClouds(), 'clouds').then(() => loadingItemDone('cloud-patterns'));
const p5 = withTimeout(geometryApplied, 'geometry apply').then(() => loadingItemDone('apply-mesh'));
const p4 = withTimeout(preloadAllTileTexturesAsync(), 'earth textures').then(() => loadingItemDone('earth-textures'));

let landingSurfaceAlt = EARTH_R;

Promise.all([p1, p2, p3, p4, p5]).then(async () => {
  await Promise.race([
    geometryApplied,
    new Promise(r => setTimeout(r, 30000)),
  ]);
  try {
    const bumpH = await queryBumpHeight(SV_LAT, SV_LON);
    console.log('[main] landing bump height:', bumpH.toFixed(0), 'm — surface alt:', (EARTH_R + bumpH).toFixed(0), 'm');
    landingSurfaceAlt = EARTH_R + bumpH;
  } catch (e) { console.warn('[main] bump query failed:', e); }
  loadingDone();
  animate();
});

// ── Animation loop ───────────────────────────
const clock = new THREE.Clock();
const prevDronePos = new THREE.Vector3().copy(fgRoot.position);
const _svWorld = new THREE.Vector3();
const _svOut   = new THREE.Vector3();
const _svDir   = new THREE.Vector3();
const _sunDirFromDrone = new THREE.Vector3();

function animate() {
  rafId = requestAnimationFrame(animate);
  const time = performance.now() / 1000;
  const dt = Math.min(clock.getDelta(), 0.1);
  const sp = getScrollProgress();
  const inFlight = sp > FLIGHT_SCROLL_THRESHOLD;

  // ── Earth rotation ──
  if (!inFlight) {
    earthRotation += IDLE_EARTH_ROTATION_SPEED * dt;
    wasInFlight = false;
  } else {
    if (!wasInFlight) {
      flightStartEarthRot = earthRotation;
      wasInFlight = true;
    }
    earthRotation = flightStartEarthRot + sp * FLIGHT_EARTH_ROTATION_FACTOR;
  }
  earthGroup.rotation.y = earthRotation;
  earthGroup.updateMatrixWorld(true);

  // SV world position after rotation
  _svWorld.copy(SV_LOCAL).applyAxisAngle(yAxis, earthRotation).add(EARTH_POSITION);
  _svOut.copy(SV_LOCAL).applyAxisAngle(yAxis, earthRotation).normalize();
  _svDir.copy(_svWorld).sub(EARTH_POSITION).normalize();

  // ── Flight path → drone position ──
  const flight = computeFlightState({
    sp, inFlight,
    earthPos: EARTH_POSITION,
    svWorld: _svWorld,
    svDir: _svDir,
    idleDronePos,
    EARTH_R,
    landingSurfaceAlt,
  });
  fgRoot.position.set(flight.x, flight.y, flight.z);

  let flightFwd = flight.flightFwd;
  if (flightFwd.length() < 0.001) flightFwd = _svDir.clone().negate();
  flightFwd.normalize();

  // ── Drone orientation ──
  const radialOut = fgRoot.position.clone().sub(EARTH_POSITION).normalize();

  const idleFacing = idleFrame.facing;
  const idleUp = new THREE.Vector3(0, 1, 0);
  const idleFwdH = idleFacing.clone();
  idleFwdH.y = 0;
  if (idleFwdH.lengthSq() < 0.001) idleFwdH.copy(idleFacing);
  idleFwdH.normalize();
  const idleRight = new THREE.Vector3().crossVectors(idleUp, idleFwdH).normalize();
  const idleFwd = new THREE.Vector3().crossVectors(idleRight, idleUp).normalize();
  const idleQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(idleRight, idleUp, idleFwd),
  );

  flightFwd.addScaledVector(radialOut, -flightFwd.dot(radialOut));
  if (flightFwd.lengthSq() < 0.001) {
    flightFwd.copy(_svDir).addScaledVector(radialOut, -_svDir.dot(radialOut));
  }
  if (flightFwd.lengthSq() < 0.001) {
    flightFwd.crossVectors(radialOut, yAxis);
  }
  if (flightFwd.lengthSq() < 0.001) flightFwd.set(1, 0, 0);
  flightFwd.normalize();

  const flightRight = new THREE.Vector3().crossVectors(radialOut, flightFwd).normalize();
  const flightUp = radialOut.clone();
  flightFwd = new THREE.Vector3().crossVectors(flightRight, flightUp).normalize();
  const flightQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(flightRight, flightUp, flightFwd),
  );

  const droneBlend = inFlight
    ? THREE.MathUtils.smootherstep(flight.bezT, DRONE_ORIENT_BEGIN_T, DRONE_ORIENT_FULL_T)
    : 0;
  drone.quaternion.slerpQuaternions(idleQuat, flightQuat, droneBlend);

  // ── Camera ──
  updateCamera({
    inFlight,
    bezT: flight.bezT,
    dronePos: fgRoot.position,
    radialOut,
    flightFwd,
    svWorld: _svWorld,
    starfieldPos: starfield.position,
  });
  updateEarthTextureLOD(camera);

  // ── System updates ──
  const droneSpeed = prevDronePos.distanceTo(fgRoot.position) / Math.max(dt, 0.001);
  const droneAltitude = Math.max(0, fgRoot.position.distanceTo(EARTH_POSITION) - EARTH_R);
  prevDronePos.copy(fgRoot.position);
  updateRotors(dt, droneSpeed);
  updateBlinkers(time);
  updateReentryEffect({
    time,
    dt,
    altitude: droneAltitude,
    dronePos: fgRoot.position,
    cameraPos: camera.position,
  });
  updateClouds(dt);

  _sunDirFromDrone.copy(sunGroup.position).sub(fgRoot.position).normalize();
  updateLocalLights(_sunDirFromDrone, fgRoot.position, radialOut);

  // ── Render ──
  renderer.clear();
  setLocalLightRigVisible(false);
  camera.layers.set(0);
  renderer.render(scene, camera);
  renderer.clearDepth();
  setLocalLightRigVisible(true);
  camera.layers.set(LOCAL_LIGHT_LAYER);
  const _sceneBackground = scene.background;
  scene.background = null;
  renderer.render(scene, camera);
  scene.background = _sceneBackground;
  camera.layers.enable(0);
}


// ── Debug toggles ────────────────────────────
let wireframeOn = false;
let atmosphereOn = true;
let shadowsOn = true;
let burnOn = false;
const _wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, fog: false });
const _savedVisible = new Map();
const _savedMat = new Map();

function handleDebugTexturesClick(e) {
  const cycle = ['textures', 'lighting', 'heatmapBump', 'heatmapDistance'];
  const idx = cycle.indexOf(textureDebugMode);
  const nextMode = cycle[(idx + 1) % cycle.length];
  textureDebugMode = nextMode;

  if (nextMode === 'heatmapBump') setEarthLODHeatmapMode('bump');
  else if (nextMode === 'heatmapDistance') setEarthLODHeatmapMode('distance');
  else setEarthTextureLightingMode(nextMode === 'textures');
  setCloudTextureLightingMode(nextMode === 'textures');
  e.currentTarget.classList.toggle('active', nextMode !== 'lighting');
  e.currentTarget.textContent = nextMode === 'textures'
    ? 'Textures on'
    : nextMode === 'lighting' ? 'No texture'
    : nextMode === 'heatmapBump' ? 'Bump LOD heatmap'
    : 'Dist LOD heatmap';
}

function handleDebugCloudsClick(e) {
  cloudsOn = !cloudsOn;
  setCloudsVisible(cloudsOn);
  e.currentTarget.classList.toggle('active', cloudsOn);
  e.currentTarget.textContent = cloudsOn ? 'Clouds on' : 'Clouds off';
}

function handleDebugAtmosphereClick(e) {
  atmosphereOn = !atmosphereOn;
  setAtmosphereVisible(atmosphereOn);
  e.currentTarget.classList.toggle('active', atmosphereOn);
  e.currentTarget.textContent = atmosphereOn ? 'Atmosphere on' : 'Atmosphere off';
}

function handleDebugBurnClick(e) {
  burnOn = !burnOn;
  setReentryBurnEnabled(burnOn);
  e.currentTarget.classList.toggle('active', burnOn);
  e.currentTarget.textContent = burnOn ? 'Burn on' : 'Burn off';
}

function handleDebugShadowsClick(e) {
  shadowsOn = !shadowsOn;
  setSceneShadowsEnabled(shadowsOn);
  setSunShadowsEnabled(shadowsOn);
  setEarthShadowsEnabled(shadowsOn);
  setDroneShadowsEnabled(shadowsOn);
  setCloudShadowsEnabled(shadowsOn);
  e.currentTarget.classList.toggle('active', shadowsOn);
  e.currentTarget.textContent = shadowsOn ? 'Shadows on' : 'Shadows off';
}

let distanceLOD = true;
function handleDebugLODClick(e) {
  distanceLOD = !distanceLOD;
  setDistanceLODEnabled(distanceLOD);
  e.currentTarget.classList.toggle('active', distanceLOD);
  e.currentTarget.textContent = distanceLOD ? 'Distance LOD on' : 'Distance LOD off';
}

let textureLOD = true;
function handleDebugTextureLODClick(e) {
  textureLOD = !textureLOD;
  setTextureLODEnabled(textureLOD);
  e.currentTarget.classList.toggle('active', textureLOD);
  e.currentTarget.textContent = textureLOD ? 'Texture LOD on' : 'Texture LOD off';
}

let bumpSmoothing = (() => { try { return localStorage.getItem('unbound.bumpSmoothing') !== '0'; } catch { return true; } })();
function handleDebugSmoothClick(e) {
  bumpSmoothing = !bumpSmoothing;
  try { localStorage.setItem('unbound.bumpSmoothing', bumpSmoothing ? '1' : '0'); } catch {}
  window.location.reload();
}

function handleDebugWireframeClick(e) {
  wireframeOn = !wireframeOn;

  if (wireframeOn) {
    scene.traverse((obj) => {
      if (!obj.isMesh && !obj.isPoints && !obj.isLine) return;
      _savedVisible.set(obj, obj.visible);
      obj.visible = false;
    });
    [earthSurface, sunGroup, fgRoot].forEach((root) => {
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        _savedMat.set(obj, obj.material);
        obj.material = _wireMat;
        obj.visible = true;
      });
    });
    scene.overrideMaterial = _wireMat;
    renderer.toneMappingExposure = 1.0;
  } else {
    scene.overrideMaterial = null;
    renderer.toneMappingExposure = 0.0001;
    _savedVisible.forEach((vis, obj) => { obj.visible = vis; });
    _savedMat.forEach((mat, obj) => { obj.material = mat; });
    _savedVisible.clear();
    _savedMat.clear();
  }

  e.currentTarget.classList.toggle('active', wireframeOn);
  e.currentTarget.textContent = wireframeOn ? 'Full render' : 'Wireframe';
}

const debugTexturesButton = document.getElementById('debug-textures');
const debugCloudsButton = document.getElementById('debug-clouds');
const debugAtmosphereButton = document.getElementById('debug-atmosphere');
const debugBurnButton = document.getElementById('debug-burn');
const debugShadowsButton = document.getElementById('debug-shadows');
const debugLODButton = document.getElementById('debug-lod');
const debugTextureLODButton = document.getElementById('debug-texture-lod');
const debugWireframeButton = document.getElementById('debug-wireframe');

debugTexturesButton?.addEventListener('click', handleDebugTexturesClick);
debugCloudsButton?.addEventListener('click', handleDebugCloudsClick);
debugAtmosphereButton?.addEventListener('click', handleDebugAtmosphereClick);
debugBurnButton?.addEventListener('click', handleDebugBurnClick);
debugShadowsButton?.addEventListener('click', handleDebugShadowsClick);
debugLODButton?.addEventListener('click', handleDebugLODClick);
debugLODButton?.classList.add('active');
debugLODButton && (debugLODButton.textContent = 'Distance LOD on');
debugTextureLODButton?.addEventListener('click', handleDebugTextureLODClick);

const debugLODModeButton = document.getElementById('debug-lod-mode');
let lodDistanceModeOn = false;
function handleDebugLODModeClick(e) {
  lodDistanceModeOn = !lodDistanceModeOn;
  setLODDistanceMode(lodDistanceModeOn);
  e.currentTarget.classList.toggle('active', lodDistanceModeOn);
  e.currentTarget.textContent = lodDistanceModeOn ? 'LOD: distance' : 'LOD: angular';
}
debugLODModeButton?.addEventListener('click', handleDebugLODModeClick);

const debugAggressionInput = document.getElementById('debug-aggression');
const debugAggressionVal = document.getElementById('debug-aggression-val');
function handleAggressionInput(e) {
  const val = parseFloat(e.target.value);
  if (debugAggressionVal) debugAggressionVal.textContent = val.toFixed(1);
  setLODAggression(val);
}
debugAggressionInput?.addEventListener('input', handleAggressionInput);

const debugSmoothButton = document.getElementById('debug-smooth');
debugSmoothButton?.addEventListener('click', handleDebugSmoothClick);
if (debugSmoothButton && bumpSmoothing) {
  debugSmoothButton.classList.add('active');
  debugSmoothButton.textContent = 'Smooth bump';
}
debugWireframeButton?.addEventListener('click', handleDebugWireframeClick);

const debugMemoryButton = document.getElementById('debug-memory');
const memoryStatsPanel = document.getElementById('memory-stats');
const memTotalSpan = document.getElementById('mem-total');
let memoryStatsOn = false;
let memoryStatsTimer = null;

function updateMemoryStats() {
  if (!memoryStatsOn || !memTotalSpan) return;
  const perf = performance;
  if (perf.memory) {
    const mb = (perf.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    memTotalSpan.textContent = `${mb} MB`;
  } else {
    memTotalSpan.textContent = 'N/A';
  }
}

function handleDebugMemoryClick(e) {
  memoryStatsOn = !memoryStatsOn;
  if (memoryStatsPanel) memoryStatsPanel.style.display = memoryStatsOn ? '' : 'none';
  e.currentTarget.classList.toggle('active', memoryStatsOn);
  e.currentTarget.textContent = memoryStatsOn ? 'Memory stats on' : 'Memory stats';
  if (memoryStatsOn) {
    updateMemoryStats();
    memoryStatsTimer = setInterval(updateMemoryStats, 1000);
  } else {
    clearInterval(memoryStatsTimer);
    memoryStatsTimer = null;
  }
}
debugMemoryButton?.addEventListener('click', handleDebugMemoryClick);

// ── Cleanup ──────────────────────────────────
const DEBUG = new URLSearchParams(window.location.search).has('debug');
function _debug(...args) { if (DEBUG) console.debug('[cleanup]', ...args); }

function disposeMaterialTextureSet(material, disposedTextures) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value?.isTexture && !disposedTextures.has(value)) {
      disposedTextures.add(value);
      value.dispose?.();
    }
  }
  for (const value of Object.values(material.userData || {})) {
    if (value?.isTexture && !disposedTextures.has(value)) {
      disposedTextures.add(value);
      value.dispose?.();
    }
  }
}

function disposeSceneGraphResources(root) {
  const disposedMaterials = new Set();
  const disposedTextures = new Set();
  let geomCount = 0;
  let matCount = 0;
  root.traverse((obj) => {
    if (obj.geometry) { obj.geometry.dispose?.(); geomCount++; }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of materials) {
      if (!material || disposedMaterials.has(material)) continue;
      disposedMaterials.add(material);
      disposeMaterialTextureSet(material, disposedTextures);
      material.dispose?.();
      matCount++;
    }
  });
  _debug(`scene-graph: ${geomCount} geometries, ${matCount} materials, ${disposedTextures.size} textures disposed`);
}

function cleanupRuntime() {
  if (isDisposed) return;
  isDisposed = true;
  const t0 = performance.now();
  _debug('cleanup starting — renderer info:', renderer.info ? {
    geometries: renderer.info.memory?.geometries,
    textures: renderer.info.memory?.textures,
    programs: renderer.info.programs?.length,
    drawCalls: renderer.info.render?.calls,
  } : 'unavailable');

  cancelAnimationFrame(rafId);
  cleanupUI?.();
  debugTexturesButton?.removeEventListener('click', handleDebugTexturesClick);
  debugCloudsButton?.removeEventListener('click', handleDebugCloudsClick);
  debugAtmosphereButton?.removeEventListener('click', handleDebugAtmosphereClick);
  debugShadowsButton?.removeEventListener('click', handleDebugShadowsClick);
  debugLODButton?.removeEventListener('click', handleDebugLODClick);
  debugTextureLODButton?.removeEventListener('click', handleDebugTextureLODClick);
  debugWireframeButton?.removeEventListener('click', handleDebugWireframeClick);
  debugMemoryButton?.removeEventListener('click', handleDebugMemoryClick);
  clearInterval(memoryStatsTimer);
  cleanupClouds();
  disposeEarthRuntime();
  disposeAtmosphere();
  disposeSun();
  disposeSceneGraphResources(scene);
  _wireMat.dispose();
  disposeSceneRuntime();
  window.removeEventListener('pagehide', cleanupRuntime);
  window.removeEventListener('beforeunload', cleanupRuntime);
  _debug(`cleanup complete in ${(performance.now() - t0).toFixed(1)}ms`);
}

window.__UNBOUND_SCENE_CLEANUP = cleanupRuntime;
window.addEventListener('pagehide', cleanupRuntime);
window.addEventListener('beforeunload', cleanupRuntime);
