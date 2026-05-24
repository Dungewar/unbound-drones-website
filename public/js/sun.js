// Sun — photosphere mesh with limb darkening, corona glow, and directional light.

import * as THREE from './three.module.js';
import { scene } from './scene.js';
import {
  EARTH_R, EARTH_POSITION,
  SUN_REAL_RADIUS, SUN_REAL_DISTANCE, SOLAR_ILLUMINANCE_LUX,
} from './config.js';

const SUN_SHADOW_DISTANCE = EARTH_R * 2.6;
const SUN_SHADOW_EXTENT = EARTH_R + 120000;
const SUN_SHADOW_NEAR = EARTH_R;
const SUN_SHADOW_FAR = EARTH_R * 4.2;

const sunToEarthDir = new THREE.Vector3();
const _sunWorldDir = new THREE.Vector3();

// ── Sun group ────────────────────────────────
export const sunGroup = new THREE.Group();
scene.add(sunGroup);

// ── Photosphere shader ───────────────────────
const SUN_PHOTOSPHERE_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vLocalDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vLocalDir = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SUN_PHOTOSPHERE_FRAG = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vLocalDir;

  uniform vec3 uColorCenter;
  uniform vec3 uColorLimb;
  uniform float uLimbU1;
  uniform float uLimbU2;
  uniform float uGranulationStrength;

  float hash31(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p *= 2.13;
      a *= 0.5;
    }
    return v;
  }

  float sunspot(vec3 dir, vec3 centre, float r, float umbraDarkness) {
    float d = acos(clamp(dot(dir, centre), -1.0, 1.0));
    if (d > r) return 1.0;
    float t = d / r;
    float penumbra = smoothstep(0.0, 0.55, t);
    return mix(umbraDarkness, 1.0, penumbra * penumbra);
  }

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    float mu = clamp(dot(vWorldNormal, V), 0.0, 1.0);

    float oneMinusMu = 1.0 - mu;
    float ld = 1.0 - uLimbU1 * oneMinusMu - uLimbU2 * oneMinusMu * oneMinusMu;
    ld = clamp(ld, 0.18, 1.0);

    vec3 color = mix(uColorLimb, uColorCenter, pow(mu, 0.65));

    float g = fbm(vLocalDir * 90.0) * 0.6 + fbm(vLocalDir * 320.0) * 0.4;
    float granulation = mix(1.0 - uGranulationStrength, 1.0 + uGranulationStrength * 0.6, g);

    float spots = 1.0;
    spots *= sunspot(vLocalDir, normalize(vec3(-0.45, -0.12,  0.88)), 0.040, 0.18);
    spots *= sunspot(vLocalDir, normalize(vec3(-0.72, -0.55,  0.42)), 0.025, 0.22);

    color *= ld * granulation * spots;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const sunCoreMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uColorCenter: { value: new THREE.Color('#fffaf0') },
    uColorLimb:   { value: new THREE.Color('#ffb56b') },
    uLimbU1:      { value: 0.55 },
    uLimbU2:      { value: 0.18 },
    uGranulationStrength: { value: 0.06 },
  },
  vertexShader: SUN_PHOTOSPHERE_VERT,
  fragmentShader: SUN_PHOTOSPHERE_FRAG,
  fog: false,
});
sunCoreMaterial.toneMapped = false;
sunGroup.add(new THREE.Mesh(
  new THREE.SphereGeometry(SUN_REAL_RADIUS, 128, 64),
  sunCoreMaterial,
));

// ── Corona shader ────────────────────────────
const SUN_CORONA_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vSunCentre;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vSunCentre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SUN_CORONA_FRAG = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vSunCentre;

  uniform vec3 uColorInner;
  uniform vec3 uColorOuter;
  uniform float uIntensity;
  uniform float uSunRadius;
  uniform float uGlowRadius;
  uniform float uFalloffPower;

  void main() {
    vec3 V = normalize(vWorldPos - cameraPosition);
    vec3 oc = vSunCentre - cameraPosition;
    float along = dot(oc, V);
    if (along < 0.0) discard;

    vec3 closest = cameraPosition + V * along;
    float b = distance(closest, vSunCentre);

    if (b > uGlowRadius) discard;
    if (b < uSunRadius) discard;

    float t = (b - uSunRadius) / max(uGlowRadius - uSunRadius, 1e-3);
    float falloff = pow(1.0 - t, uFalloffPower);

    vec3 color = mix(uColorOuter, uColorInner, falloff);
    float alpha = falloff * uIntensity;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const SUN_CORONA_SHELL_R = SUN_REAL_RADIUS * 2.4;
const sunCoronaMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uColorInner:   { value: new THREE.Color('#fff1cc') },
    uColorOuter:   { value: new THREE.Color('#ffb060') },
    uIntensity:    { value: 0.55 },
    uSunRadius:    { value: SUN_REAL_RADIUS },
    uGlowRadius:   { value: SUN_CORONA_SHELL_R },
    uFalloffPower: { value: 2.4 },
  },
  vertexShader: SUN_CORONA_VERT,
  fragmentShader: SUN_CORONA_FRAG,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.FrontSide,
  fog: false,
});
sunCoronaMaterial.toneMapped = false;
sunGroup.add(new THREE.Mesh(
  new THREE.SphereGeometry(SUN_CORONA_SHELL_R, 96, 48),
  sunCoronaMaterial,
));

// ── Directional light (Earth shadow) ─────────
export const sunLight = new THREE.DirectionalLight('#fff5e6', SOLAR_ILLUMINANCE_LUX);
sunLight.position.set(20, 12, 15);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
sunLight.shadow.camera.near = SUN_SHADOW_NEAR;
sunLight.shadow.camera.far = SUN_SHADOW_FAR;
sunLight.shadow.camera.left = -SUN_SHADOW_EXTENT;
sunLight.shadow.camera.right = SUN_SHADOW_EXTENT;
sunLight.shadow.camera.top = SUN_SHADOW_EXTENT;
sunLight.shadow.camera.bottom = -SUN_SHADOW_EXTENT;
sunLight.shadow.normalBias = 2500;
sunLight.target.position.copy(EARTH_POSITION);
scene.add(sunLight);
scene.add(sunLight.target);

// ── Shared sun-direction uniform ─────────────
export const sunDirUniform = { value: new THREE.Vector3() };

export function setSunWorldDirection(worldDir) {
  if (!worldDir || worldDir.lengthSq() < 1e-10) return;
  _sunWorldDir.copy(worldDir).normalize();
  sunGroup.position.copy(EARTH_POSITION).addScaledVector(_sunWorldDir, SUN_REAL_DISTANCE);
  syncSunLightToEarth();
}

export function setSunShadowsEnabled(enabled) {
  sunLight.castShadow = true;
  sunLight.shadow.intensity = enabled ? 1 : 0;
  sunLight.shadow.needsUpdate = true;
}

function syncSunLightToEarth() {
  sunToEarthDir.copy(EARTH_POSITION).sub(sunGroup.position).normalize();
  sunLight.position.copy(EARTH_POSITION).addScaledVector(sunToEarthDir, -SUN_SHADOW_DISTANCE);
  sunLight.target.position.copy(EARTH_POSITION);
  sunDirUniform.value.copy(sunGroup.position).sub(EARTH_POSITION).normalize();
  sunLight.updateMatrixWorld();
  sunLight.target.updateMatrixWorld();
  sunLight.shadow.camera.updateProjectionMatrix();
}

export function disposeSun() {
  sunCoreMaterial.dispose();
  sunCoronaMaterial.dispose();
  sunLight.dispose();
}
