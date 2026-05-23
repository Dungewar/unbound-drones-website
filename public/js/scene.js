// Renderer, scene, camera, and ambient/fill/rim lights.
// The sun light lives in earth.js since it's tied to the visible sun mesh.

import * as THREE from 'three';
import { CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR } from './config.js';

export const canvas = document.getElementById('c');
export const LOCAL_LIGHT_LAYER = 1;

export const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  // Required: scene spans 0.05m (drone parts) to 60M+m (stars)
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.useLegacyLights = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.0001;
renderer.autoClear = false;

export const scene = new THREE.Scene();
scene.background = new THREE.Color('#020210');
scene.fog = new THREE.Fog('#020210', 200, 800);

export const camera = new THREE.PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  CAMERA_NEAR,
  CAMERA_FAR,
);
camera.position.set(0, 0.1, 4.2);
camera.lookAt(0, 0, 0);
camera.layers.enable(LOCAL_LIGHT_LAYER);
scene.add(camera);

// ── Lighting ─────────────────────────────────
// Faint warm ambient so deep shadows on the Earth surface don't crush to
// pure black under tone mapping — Earthshine + airglow contribute a small
// floor in reality. Kept very low so the night side still reads as night.
const WORLD_AMBIENT_INTENSITY = 0.0025;
const WORLD_FILL_INTENSITY = 0.005;

const ambient = new THREE.AmbientLight('#142238', WORLD_AMBIENT_INTENSITY);
scene.add(ambient);

// Hemisphere fill: cool sky tone from above, near-black ground from below.
// Lower than before so it can't lift the night side off the floor; the
// noticeable shadow tinting now comes from the sun-aware fill below.
const worldFill = new THREE.HemisphereLight('#4f6a99', '#02050a', WORLD_FILL_INTENSITY);
scene.add(worldFill);

export function setWorldFillEnabled(enabled) {
  ambient.intensity = enabled ? WORLD_AMBIENT_INTENSITY : 0;
  worldFill.intensity = enabled ? WORLD_FILL_INTENSITY : 0;
}

export function setSceneShadowsEnabled(enabled) {
  keyLight.castShadow = true;
  keyLight.shadow.intensity = enabled ? 1 : 0;
  keyLight.shadow.needsUpdate = true;
}

// keyLight = the "sun" for local objects (drone, city). Re-pointed every
// frame from main.js so its shadow direction tracks the actual sun. The
// position values here are placeholders that updateLocalLights() overwrites.
export const keyLight = new THREE.DirectionalLight('#fff3dc', 38000);
keyLight.position.set(3, 4, 8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 40;
keyLight.shadow.camera.left = -8;
keyLight.shadow.camera.right = 8;
keyLight.shadow.camera.top = 8;
keyLight.shadow.camera.bottom = -8;
keyLight.shadow.bias = -0.0001;
keyLight.shadow.normalBias = 0.02;
keyLight.layers.set(LOCAL_LIGHT_LAYER);
scene.add(keyLight);
scene.add(keyLight.target);

// fill = the cool sky bounce — opposite-ish to the sun, low intensity,
// distinctly blue so shadowed faces of the drone read as "lit by sky", not
// "lit by another sun". Direction is updated each frame from main.js.
export const fill = new THREE.DirectionalLight('#6f8fc6', 3200);
fill.position.set(-3, 2, -4);
fill.layers.set(LOCAL_LIGHT_LAYER);
scene.add(fill);
scene.add(fill.target);

// rim = a back-light positioned roughly opposite the sun relative to the
// drone, so silhouettes catch a thin warm edge when the sun is in front of
// the camera and a thin cool edge when it's behind.
export const rim = new THREE.DirectionalLight('#ffffff', 9000);
rim.position.set(0, 0.5, -5);
rim.layers.set(LOCAL_LIGHT_LAYER);
scene.add(rim);
scene.add(rim.target);

const bottomGlow = new THREE.PointLight('#1a3a66', 6000, 10);
bottomGlow.position.set(0, -2, 1);
bottomGlow.layers.set(LOCAL_LIGHT_LAYER);
scene.add(bottomGlow);

const localLightRig = [keyLight, fill, rim, bottomGlow];

export function setLocalLightRigVisible(visible) {
  localLightRig.forEach((light) => {
    light.visible = visible;
  });
}

// ── Sun-tracking update for local lights ────────────
// Pre-allocated scratch vectors so the per-frame call is allocation-free.
const _sunDir = new THREE.Vector3();
const _fillDir = new THREE.Vector3();
const _rimDir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _warmRim = new THREE.Color('#ffd6a8');
const _coolRim = new THREE.Color('#a6c3ff');

// sunWorldDir: unit vector from the drone toward the sun (world space).
// dronePos: drone world position. Up: drone's local up (radial-out from
// Earth, supplied so fill/rim sit relative to the drone's orientation).
export function updateLocalLights(sunWorldDir, dronePos, droneUp) {
  _sunDir.copy(sunWorldDir).normalize();

  // Key sits along the sun direction, a few metres "above" the drone in
  // light-space — far enough that the shadow camera bounds (±8 m) comfortably
  // cover the drone+platform without the light intersecting them.
  keyLight.position.copy(dronePos).addScaledVector(_sunDir, 12);
  keyLight.target.position.copy(dronePos);
  keyLight.target.updateMatrixWorld();
  keyLight.updateMatrixWorld();

  // Warm tint shifts toward white when the sun is overhead, more amber when
  // it's grazing the drone's horizon — same idea as midday vs. golden hour.
  const elevation = Math.max(0, _sunDir.dot(droneUp));
  keyLight.color.setRGB(
    1.0,
    0.92 + 0.06 * elevation,
    0.78 + 0.18 * elevation,
  );

  // Fill comes from roughly opposite the sun, biased upward along the
  // drone's up vector so it reads as skylight rather than ground bounce.
  _fillDir.copy(_sunDir).multiplyScalar(-1).addScaledVector(droneUp, 0.6).normalize();
  fill.position.copy(dronePos).addScaledVector(_fillDir, 8);
  fill.target.position.copy(dronePos);
  fill.target.updateMatrixWorld();
  fill.updateMatrixWorld();

  // Rim sits 90° off the sun in the drone's horizontal plane so it always
  // catches a silhouette edge regardless of where the sun is. Colour shifts
  // warm when sun is in front of the camera-side, cool when it's behind.
  _right.crossVectors(_sunDir, droneUp);
  if (_right.lengthSq() < 1e-6) _right.crossVectors(_sunDir, _up);
  _right.normalize();
  _rimDir.crossVectors(droneUp, _right).normalize().multiplyScalar(-1);
  rim.position.copy(dronePos).addScaledVector(_rimDir, 8);
  rim.target.position.copy(dronePos);
  rim.target.updateMatrixWorld();
  rim.updateMatrixWorld();

  // Rim hue: warmer when the sun is behind the camera (front-lit subject,
  // rim should pick up reflected warm sun); cooler when sun is in front
  // (back-lit, rim picks up cool sky).
  const backlitMix = 0.5 - 0.5 * _sunDir.dot(droneUp);
  rim.color.copy(_coolRim).lerp(_warmRim, 1.0 - backlitMix);
}

// ── Resize handling ──────────────────────────
let resizeT;
function handleResize() {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, 200);
}

window.addEventListener('resize', handleResize);

export function disposeSceneRuntime() {
  window.removeEventListener('resize', handleResize);
  clearTimeout(resizeT);
  // Force the WebGL context to be lost while the canvas is still in the DOM
  // (cleanup runs inside beforeunload/pagehide before React unmounts).
  renderer.forceContextLoss();
  renderer.dispose();
  renderer.info?.dispose?.();
  // Release Three.js-side references so the GC can collect them.
  scene.background = null;
  scene.fog = null;
}
