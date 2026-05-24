// Atmosphere — single-scattering volume approximation with Rayleigh, Mie, and ozone.
//
// The shader integrates extinction along the view ray and sun ray for each
// sample so the limb, disc tint, and terminator all come from the same model.

import * as THREE from './three.module.js';
import {
  EARTH_R, EARTH_POSITION, TERRAIN_EXAGGERATION,
} from './config.js';
import { sunDirUniform } from './sun.js';

const ATMOSPHERE_HEIGHT = 200000 * TERRAIN_EXAGGERATION;
const ATMOSPHERE_OUTER_R = EARTH_R + ATMOSPHERE_HEIGHT;
const ATMOSPHERE_GROUND_R = EARTH_R;
const ATMO_SEGMENTS = 256;

// ── Shared uniforms (also consumed by earth surface aerial perspective) ───
export const atmosphereUniforms = {
  uPlanetCenter: { value: EARTH_POSITION.clone() },
  uGroundRadius: { value: ATMOSPHERE_GROUND_R },
  uAtmosphereRadius: { value: ATMOSPHERE_OUTER_R },
  uSunDir: sunDirUniform,
  uAerialEnabled: { value: 1 },
  uRayleighBeta: { value: new THREE.Vector3(8.4e-6, 1.58e-5, 3.45e-5).divideScalar(TERRAIN_EXAGGERATION) },
  uMieBeta: { value: new THREE.Vector3(2.05e-5, 2.05e-5, 1.9e-5).divideScalar(TERRAIN_EXAGGERATION) },
  uOzoneBeta: { value: new THREE.Vector3(1.8e-6, 4.1e-6, 2.5e-7).divideScalar(TERRAIN_EXAGGERATION) },
  uRayleighScaleHeight: { value: 8200 * TERRAIN_EXAGGERATION },
  uMieScaleHeight: { value: 1400 * TERRAIN_EXAGGERATION },
  uOzoneCenter: { value: 25000 * TERRAIN_EXAGGERATION },
  uOzoneWidth: { value: 18000 * TERRAIN_EXAGGERATION },
  uIntensity: { value: 12.5 },
  uAlphaScale: { value: 0.92 },
  uAirglowColor: { value: new THREE.Color('#5b7dff') },
  uAirglowIntensity: { value: 0.014 },
  uTwilightLift: { value: 0.028 },
};

// ── Atmosphere shaders ───────────────────────
const ATMO_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMO_FRAG = /* glsl */ `
  #define VIEW_SAMPLES 20
  #define LIGHT_SAMPLES 8
  const float PI = 3.141592653589793;

  varying vec3 vWorldPos;
  uniform vec3 uPlanetCenter;
  uniform float uGroundRadius;
  uniform float uAtmosphereRadius;
  uniform vec3 uSunDir;
  uniform vec3 uRayleighBeta;
  uniform vec3 uMieBeta;
  uniform vec3 uOzoneBeta;
  uniform float uRayleighScaleHeight;
  uniform float uMieScaleHeight;
  uniform float uOzoneCenter;
  uniform float uOzoneWidth;
  uniform float uIntensity;
  uniform float uAlphaScale;
  uniform vec3 uAirglowColor;
  uniform float uAirglowIntensity;
  uniform float uTwilightLift;

  vec2 raySphere(vec3 origin, vec3 dir, float radius) {
    vec3 oc = origin - uPlanetCenter;
    float b = dot(oc, dir);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  float densityRayleigh(float height) {
    return exp(-max(height, 0.0) / uRayleighScaleHeight);
  }

  float densityMie(float height) {
    return exp(-max(height, 0.0) / uMieScaleHeight);
  }

  float densityOzone(float height) {
    float dist = abs(height - uOzoneCenter) / uOzoneWidth;
    return max(0.0, 1.0 - dist);
  }

  vec3 extinction(vec3 opticalDepth) {
    return exp(-(
      uRayleighBeta * opticalDepth.x +
      uMieBeta * opticalDepth.y +
      uOzoneBeta * opticalDepth.z
    ));
  }

  vec3 integrateSunDepth(vec3 samplePos) {
    vec2 groundHit = raySphere(samplePos, uSunDir, uGroundRadius);
    if (groundHit.x > 0.0) return vec3(-1.0);

    vec2 atmoHit = raySphere(samplePos, uSunDir, uAtmosphereRadius);
    float sunDistance = atmoHit.y;
    if (sunDistance <= 0.0) return vec3(0.0);

    float stepSize = sunDistance / float(LIGHT_SAMPLES);
    vec3 opticalDepth = vec3(0.0);

    for (int i = 0; i < LIGHT_SAMPLES; i++) {
      float t = (float(i) + 0.5) * stepSize;
      vec3 pos = samplePos + uSunDir * t;
      float height = length(pos - uPlanetCenter) - uGroundRadius;
      opticalDepth += vec3(
        densityRayleigh(height),
        densityMie(height),
        densityOzone(height)
      ) * stepSize;
    }

    return opticalDepth;
  }

  void main() {
    vec3 rayOrigin = cameraPosition;
    vec3 rayDir = normalize(vWorldPos - cameraPosition);
    float cameraAltitude = length(rayOrigin - uPlanetCenter);

#if ATMOSPHERE_INSIDE_PASS == 1
    if (cameraAltitude > uAtmosphereRadius) discard;
#else
    if (cameraAltitude <= uAtmosphereRadius) discard;
#endif

    vec2 atmoHit = raySphere(rayOrigin, rayDir, uAtmosphereRadius);
    if (atmoHit.y <= 0.0) discard;

    float tStart = max(atmoHit.x, 0.0);
    float tEnd = atmoHit.y;

    vec2 groundHit = raySphere(rayOrigin, rayDir, uGroundRadius);
    bool hitsGround = groundHit.x > 0.0;
    if (hitsGround) discard;

    float segmentLength = tEnd - tStart;
    if (segmentLength <= 0.0) discard;

    float stepSize = segmentLength / float(VIEW_SAMPLES);
    vec3 opticalDepth = vec3(0.0);
    vec3 rayleighAccum = vec3(0.0);
    vec3 mieAccum = vec3(0.0);
    float densityAccum = 0.0;
    float litDensityAccum = 0.0;
    float twilightDensityAccum = 0.0;

    for (int i = 0; i < VIEW_SAMPLES; i++) {
      float t = tStart + (float(i) + 0.5) * stepSize;
      vec3 samplePos = rayOrigin + rayDir * t;
      float height = length(samplePos - uPlanetCenter) - uGroundRadius;

      if (height < 0.0) continue;

      vec3 localDensity = vec3(
        densityRayleigh(height),
        densityMie(height),
        densityOzone(height)
      );
      float densityWeight = localDensity.x + localDensity.y * 0.35 + localDensity.z * 0.15;
      opticalDepth += localDensity * stepSize;
      densityAccum += densityWeight * stepSize;

      vec3 sunDepth = integrateSunDepth(samplePos);
      if (sunDepth.x < 0.0) continue;

      vec3 sampleDir = normalize(samplePos - uPlanetCenter);
      float sampleSun = dot(sampleDir, uSunDir);
      float sunWeight = smoothstep(-0.05, 0.15, sampleSun);
      float twilightWeight = smoothstep(-0.28, 0.02, sampleSun)
        * (1.0 - smoothstep(0.02, 0.28, sampleSun));
      litDensityAccum += densityWeight * stepSize * sunWeight;
      twilightDensityAccum += densityWeight * stepSize * twilightWeight;

      vec3 transmittance = extinction(opticalDepth + sunDepth);
      rayleighAccum += localDensity.x * transmittance * stepSize * sunWeight;
      mieAccum += localDensity.y * transmittance * stepSize * sunWeight;
    }

    float mu = dot(uSunDir, -rayDir);
    float mu2 = mu * mu;
    float phaseR = (3.0 / (16.0 * PI)) * (1.0 + mu2);

    float g = 0.82;
    float g2 = g * g;
    float mieDenom = pow(max(1.0 + g2 - 2.0 * g * mu, 0.001), 1.5);
    float phaseM = (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + mu2)) / ((2.0 + g2) * mieDenom);

    vec3 scatter = phaseR * uRayleighBeta * rayleighAccum
      + phaseM * uMieBeta * mieAccum;

    vec3 color = 1.0 - exp(-scatter * uIntensity);
    vec3 shellNormal = normalize(vWorldPos - uPlanetCenter);
    float viewZenith = clamp(dot(shellNormal, -rayDir), 0.0, 1.0);
    float limbFactor = smoothstep(0.0, 0.24, 1.0 - viewZenith);
    float litRatio = densityAccum > 0.0 ? litDensityAccum / densityAccum : 0.0;
    float twilightRatio = densityAccum > 0.0 ? twilightDensityAccum / densityAccum : 0.0;

    float shellSun = dot(shellNormal, uSunDir);
    float horizonBoost = 1.0 + 1.55 * pow(limbFactor, 1.35) * mix(0.38, 1.0, litRatio);
    float twilightBand = 1.0 - smoothstep(0.04, 0.42, abs(shellSun + 0.02));
    float nightSide = smoothstep(0.0, 0.55, -shellSun);
    vec3 twilightColor = mix(vec3(0.82, 0.86, 1.0), uAirglowColor, 0.7)
      * (uTwilightLift * twilightRatio * pow(limbFactor, 1.35) * twilightBand);
    vec3 airglow = uAirglowColor
      * (uAirglowIntensity * pow(limbFactor, 1.85) * (0.2 + 0.8 * nightSide));
    color = color * horizonBoost + twilightColor + airglow;
    float alpha = clamp(max(color.r, max(color.g, color.b)) * uAlphaScale, 0.0, 1.0);

    if (alpha <= 0.0005) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Atmosphere meshes ────────────────────────
function createAtmosphereMaterial(insidePass) {
  const mat = new THREE.ShaderMaterial({
    defines: {
      ATMOSPHERE_INSIDE_PASS: insidePass ? 1 : 0,
    },
    uniforms: atmosphereUniforms,
    vertexShader: ATMO_VERTEX,
    fragmentShader: ATMO_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: insidePass ? THREE.BackSide : THREE.FrontSide,
    fog: false,
  });
  mat.toneMapped = false;
  return mat;
}

const atmosphereGeometry = new THREE.SphereGeometry(
  ATMOSPHERE_OUTER_R,
  ATMO_SEGMENTS,
  ATMO_SEGMENTS / 2,
);

const atmosphereOuterMesh = new THREE.Mesh(
  atmosphereGeometry,
  createAtmosphereMaterial(false),
);
atmosphereOuterMesh.renderOrder = 8;

const atmosphereInnerMesh = new THREE.Mesh(
  atmosphereGeometry,
  createAtmosphereMaterial(true),
);
atmosphereInnerMesh.renderOrder = 8;

// Call from main.js after earthGroup is created.
export function attachAtmosphere(earthGroup) {
  earthGroup.add(atmosphereOuterMesh);
  earthGroup.add(atmosphereInnerMesh);
}

export function setAtmosphereVisible(visible) {
  atmosphereUniforms.uAerialEnabled.value = visible ? 1 : 0;
  atmosphereOuterMesh.visible = visible;
  atmosphereInnerMesh.visible = visible;
}

export function disposeAtmosphere() {
  atmosphereOuterMesh.material.dispose();
  atmosphereInnerMesh.material.dispose();
  // Both meshes share the same geometry — dispose once.
  atmosphereGeometry.dispose();
}
