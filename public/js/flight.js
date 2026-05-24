// Scroll-driven flight: physics-inspired orbital trajectory.
//
// 3-phase altitude profile with C2-continuous transitions:
//   Phase 1: gradual spiral descent from idle to a higher orbit-entry altitude
//   Phase 2: long orbital cruise that slowly bleeds down to the low orbit
//   Phase 3: shallow atmospheric entry to the surface
//
// The descent phase is long so altitude and angular motion happen together,
// creating a curved spiral into orbit rather than a dive-then-orbit.

import * as THREE from './three.module.js';
import {
  FLIGHT_ORBIT_ALTITUDE,
  FLIGHT_ORBIT_ENTRY_ALTITUDE,
  FLIGHT_DESCENT_PHASE_END,
  FLIGHT_CRUISE_PHASE_END,
} from './config.js';

const _orbitAxis = new THREE.Vector3();
const _idleDir   = new THREE.Vector3();
const _dir       = new THREE.Vector3();
const _tangent   = new THREE.Vector3();
const _q         = new THREE.Quaternion();

export function computeFlightState({
  sp, inFlight, earthPos, svWorld, svDir, idleDronePos, EARTH_R, landingSurfaceAlt,
}) {
  const bezT = sp;

  const idleDir = _idleDir.copy(idleDronePos).sub(earthPos).normalize();
  const idleAlt = idleDronePos.distanceTo(earthPos);

  if (!inFlight) {
    return {
      x: idleDronePos.x, y: idleDronePos.y, z: idleDronePos.z,
      flightFwd: svDir.clone().negate(),
      bezT: 0,
    };
  }

  // ── Orbit axis (idle → city great-circle plane) ──────────────────────────
  // When the drone is nearly directly above the city, idleDir ≈ svDir and the
  // cross product is numerically unstable. Blend to a stable fallback axis.
  _orbitAxis.crossVectors(svDir, idleDir);
  const axisLen = _orbitAxis.length();
  const arb = Math.abs(idleDir.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const fallbackAxis = new THREE.Vector3().crossVectors(arb, idleDir).normalize();
  if (axisLen < 0.001) {
    _orbitAxis.copy(fallbackAxis);
  } else if (axisLen < 0.08) {
    _orbitAxis.divideScalar(axisLen);
    const t = 1 - (axisLen - 0.001) / (0.08 - 0.001);
    _orbitAxis.lerp(fallbackAxis, t * t).normalize();
  } else {
    _orbitAxis.divideScalar(axisLen);
  }

  const directDot   = Math.max(-1, Math.min(1, idleDir.dot(svDir)));
  const directAngle = Math.acos(directDot);
  const longArc = 2 * Math.PI - directAngle;

  // ── Angular sweep: nested smootherstep easing ────────────────────────────
  // Nested smootherstep stretches the slow ends so the drone lingers longer
  // at the start and finish, with a higher peak speed at the midpoint to
  // cover the same angular distance in the same scroll range.
  const t1 = THREE.MathUtils.smootherstep(bezT, 0, 1);
  const thetaT = THREE.MathUtils.smootherstep(t1, 0, 1);
  const theta  = longArc * thetaT;

  // ── Altitude: 3-phase physics profile ───────────────────────────────────
  // Each phase uses smootherstep so derivatives are 0 at phase boundaries,
  // giving C2 continuity across the full profile.
  const lowOrbitAlt = EARTH_R + Math.min(FLIGHT_ORBIT_ALTITUDE, idleAlt - EARTH_R);
  const orbitEntryAlt = EARTH_R + Math.min(
    Math.max(FLIGHT_ORBIT_ENTRY_ALTITUDE, FLIGHT_ORBIT_ALTITUDE),
    idleAlt - EARTH_R,
  );

  let alt;
  if (bezT <= FLIGHT_DESCENT_PHASE_END) {
    const p = THREE.MathUtils.smootherstep(bezT, 0, FLIGHT_DESCENT_PHASE_END);
    alt = THREE.MathUtils.lerp(idleAlt, orbitEntryAlt, p);
  } else if (bezT <= FLIGHT_CRUISE_PHASE_END) {
    const p = THREE.MathUtils.smootherstep(
      bezT,
      FLIGHT_DESCENT_PHASE_END,
      FLIGHT_CRUISE_PHASE_END,
    );
    alt = THREE.MathUtils.lerp(orbitEntryAlt, lowOrbitAlt, p);
  } else {
    const p = THREE.MathUtils.smootherstep(bezT, FLIGHT_CRUISE_PHASE_END, 1.0);
    alt = THREE.MathUtils.lerp(lowOrbitAlt, landingSurfaceAlt, p);
  }

  // ── Position on arc ──────────────────────────────────────────────────────
  _q.setFromAxisAngle(_orbitAxis, theta);
  _dir.copy(idleDir).applyQuaternion(_q).normalize();

  let x = earthPos.x + _dir.x * alt;
  let y = earthPos.y + _dir.y * alt;
  let z = earthPos.z + _dir.z * alt;

  // Clamp above surface
  const dx = x - earthPos.x, dy = y - earthPos.y, dz = z - earthPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const minDist = landingSurfaceAlt;
  if (dist < minDist) {
    const scale = minDist / dist;
    x = earthPos.x + dx * scale;
    y = earthPos.y + dy * scale;
    z = earthPos.z + dz * scale;
  }

  // ── Forward: arc tangent (always tangential, never radial/nose-down) ────
  _tangent.crossVectors(_orbitAxis, _dir);
  const flightFwd = _tangent.lengthSq() > 0.001
    ? new THREE.Vector3(_tangent.x, _tangent.y, _tangent.z).normalize()
    : svDir.clone();

  return { x, y, z, flightFwd, bezT };
}
