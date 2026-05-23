// Camera system — idle framing and scroll-driven follow.
//
// buildIdleFrame() computes the initial camera pose relative to the drone.
// createCameraController() returns a per-frame update function that blends
// between the idle pose and a close flight-follow as scroll progresses.

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import {
  IDLE_CAMERA_OUT_DISTANCE, IDLE_CAMERA_SIDE_DISTANCE,
  IDLE_LOOK_RIGHT_OFFSET, IDLE_LOOK_UP_OFFSET,
  IDLE_SUN_RIGHT_WEIGHT, IDLE_SUN_UP_WEIGHT,
  CAMERA_FOLLOW_BEGIN_T, CAMERA_FOLLOW_FULL_T,
  CAMERA_PRE_FOLLOW_DISTANCE, CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOLLOW_SIDE_DISTANCE,
  CAMERA_MAX_ELEVATION,
} from './config.js';

function projectOntoPlane(vec, planeNormal, fallback) {
  vec.addScaledVector(planeNormal, -vec.dot(planeNormal));
  if (vec.lengthSq() < 0.001) vec.copy(fallback);
  if (vec.lengthSq() < 0.001) vec.set(1, 0, 0);
  return vec.normalize();
}

export function buildIdleFrame(dronePos, radialOut, worldUp) {
  const side = new THREE.Vector3().crossVectors(radialOut, worldUp);
  if (side.lengthSq() < 0.001) side.set(1, 0, 0);
  else side.normalize();

  const cameraOffset = radialOut.clone()
    .multiplyScalar(IDLE_CAMERA_OUT_DISTANCE)
    .addScaledVector(side, IDLE_CAMERA_SIDE_DISTANCE);
  const cameraPos = dronePos.clone().add(cameraOffset);
  const forward = new THREE.Vector3().subVectors(dronePos, cameraPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 0.001) right.copy(side);
  else right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const lookOffset = right.clone()
    .multiplyScalar(IDLE_LOOK_RIGHT_OFFSET)
    .addScaledVector(up, IDLE_LOOK_UP_OFFSET);
  const facing = projectOntoPlane(forward.clone().negate(), radialOut, side.clone());
  const sunWorldDir = right.clone()
    .multiplyScalar(IDLE_SUN_RIGHT_WEIGHT)
    .addScaledVector(up, IDLE_SUN_UP_WEIGHT)
    .normalize();

  return { cameraOffset, lookOffset, facing, sunWorldDir };
}

// Returns a per-frame updateCamera() function. The constants (idle frame, idle
// offsets, idle drone position) are captured once; only per-frame varying
// inputs are passed on each call.
export function createCameraController(camera, {
  idleFrame, idleCamOffset, idleCamUp, idleDronePos,
}) {
  const _followCamPos = new THREE.Vector3();
  const _followHeading = new THREE.Vector3();
  const _followRight = new THREE.Vector3();
  const _followCamUp = new THREE.Vector3();
  const _followOffset = new THREE.Vector3();
  const _cameraOffset = new THREE.Vector3();
  const _cameraLookTarget = new THREE.Vector3();
  const _idleToCityHeading = new THREE.Vector3();

  return function updateCamera({
    inFlight, bezT, dronePos, radialOut, flightFwd, svWorld, starfieldPos,
  }) {
    _idleToCityHeading.subVectors(svWorld, idleDronePos);
    _idleToCityHeading.addScaledVector(radialOut, -_idleToCityHeading.dot(radialOut));
    if (_idleToCityHeading.lengthSq() > 0.000001) _idleToCityHeading.normalize();
    else _idleToCityHeading.set(0, 0, 1);

    _followHeading.copy(flightFwd).addScaledVector(radialOut, -flightFwd.dot(radialOut));
    if (_followHeading.lengthSq() > 0.01) {
      _followHeading.normalize();
    } else {
      _followHeading.copy(_idleToCityHeading);
    }

    // Orbit elevation: flat behind → directly above
    const orbitElevationT = inFlight
      ? THREE.MathUtils.smootherstep(bezT, CAMERA_FOLLOW_BEGIN_T, CAMERA_FOLLOW_FULL_T)
      : 0;
    const followElevation = THREE.MathUtils.lerp(0, CAMERA_MAX_ELEVATION, orbitElevationT);
    const followDist = THREE.MathUtils.lerp(
      CAMERA_PRE_FOLLOW_DISTANCE, CAMERA_FOLLOW_DISTANCE, orbitElevationT,
    );
    const backOffset = followDist * Math.cos(followElevation);
    const upOffset = followDist * Math.sin(followElevation);
    _followRight.crossVectors(radialOut, _followHeading);
    if (_followRight.lengthSq() < 0.001) _followRight.set(1, 0, 0);
    else _followRight.normalize();
    const sideOffset = CAMERA_FOLLOW_SIDE_DISTANCE * orbitElevationT;

    _followCamPos.copy(dronePos)
      .addScaledVector(_followHeading, -backOffset)
      .addScaledVector(_followRight, sideOffset)
      .addScaledVector(radialOut, upOffset);
    // Camera up = drone up (radialOut), so the camera stays oriented to the drone
    // rather than tilting toward the world horizon.
    _followCamUp.copy(radialOut);

    // Blend drone-relative offsets so the camera stays a few metres from the
    // drone rather than traversing millions of metres of world space.
    const cameraTrackT = inFlight
      ? THREE.MathUtils.smootherstep(bezT, CAMERA_FOLLOW_BEGIN_T, CAMERA_FOLLOW_FULL_T)
      : 0;
    _followOffset.copy(_followCamPos).sub(dronePos);
    _cameraOffset.lerpVectors(idleCamOffset, _followOffset, cameraTrackT);
    camera.position.copy(dronePos).add(_cameraOffset);

    // Always look at the drone; blend the up vector for a smooth roll transition.
    const cameraAngleT = inFlight
      ? THREE.MathUtils.smootherstep(bezT, CAMERA_FOLLOW_BEGIN_T, CAMERA_FOLLOW_FULL_T)
      : 0;
    camera.up.copy(idleCamUp).lerp(_followCamUp, cameraAngleT).normalize();
    _cameraLookTarget.copy(dronePos).add(idleFrame.lookOffset).lerp(dronePos, cameraAngleT);
    camera.lookAt(_cameraLookTarget);
    camera.getWorldPosition(starfieldPos);
  };
}
