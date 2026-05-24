// Central configuration — every tunable constant lives here so camera angles,
// drone trajectory, sun position, etc. can be adjusted in one place.

import * as THREE from './three.module.js';

// ── Earth ────────────────────────────────────
export const EARTH_R = 6371000;

const REAL_EARTH_MAX_ELEVATION = 8848;
export const BUMP_DISPLACEMENT_SCALE = 263672;
export const TERRAIN_EXAGGERATION = BUMP_DISPLACEMENT_SCALE / REAL_EARTH_MAX_ELEVATION;

// Earth group offset from origin — places the planet on the right side of frame.
export const EARTH_POSITION = new THREE.Vector3(EARTH_R * 1.3, -EARTH_R * 0.3, EARTH_R);

// San Jose on the unit sphere (37.34°N, 122.01°W)
export const SV_LAT = 37.34;
export const SV_LON = -122.01;
const svLatRad = SV_LAT * Math.PI / 180;
const svLonRad = SV_LON * Math.PI / 180;
export const SV_LOCAL = new THREE.Vector3(
  EARTH_R * Math.cos(svLatRad) * Math.cos(svLonRad),
  EARTH_R * Math.sin(svLatRad),
  -EARTH_R * Math.cos(svLatRad) * Math.sin(svLonRad),
);

// ── Sun ──────────────────────────────────────
export const SUN_REAL_RADIUS = 695700000;
export const SUN_REAL_DISTANCE = 149597870700;
export const SOLAR_ILLUMINANCE_LUX = 127000;

// Frozen world-space sun direction so lighting stays consistent as the camera orbits.
export const DEFAULT_SUN_WORLD_DIR = new THREE.Vector3(
  0.8, -0.25, 0.55,
).normalize();

// ── Drone idle ────────────────────────────────
// Altitude above the SV point (metres) when the drone is at rest.
export const IDLE_DRONE_ALTITUDE = 20_000_000;

// ── Camera ───────────────────────────────────
export const CAMERA_FOV = 48;
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 500_000_000_000;

// Idle camera offset from the drone
export const IDLE_CAMERA_OUT_DISTANCE = 2.5;
export const IDLE_CAMERA_SIDE_DISTANCE = 0.7;
export const IDLE_LOOK_RIGHT_OFFSET = -1.0;
export const IDLE_LOOK_UP_OFFSET = 0.34;

// Sun framing at idle (relative to camera right/up basis)
export const IDLE_SUN_RIGHT_WEIGHT = 2.4;
export const IDLE_SUN_UP_WEIGHT = 0.14;

// Camera follow behaviour during flight (bezT = bezier progress along path)
export const CAMERA_FOLLOW_BEGIN_T = 0.12;
export const CAMERA_FOLLOW_FULL_T = 0.46;
export const CAMERA_PRE_FOLLOW_DISTANCE = 42;
export const CAMERA_FOLLOW_DISTANCE = 72;
export const CAMERA_FOLLOW_SIDE_DISTANCE = 16;
export const CAMERA_MAX_ELEVATION = Math.PI / 6;

// ── Flight ───────────────────────────────────
// Scroll progress threshold to enter flight mode
export const FLIGHT_SCROLL_THRESHOLD = 0.005;

// Earth rotation speed while idle (rad/s)
export const IDLE_EARTH_ROTATION_SPEED = 0.04;

// Earth rotation during flight (scroll-locked, proportional to progress)
export const FLIGHT_EARTH_ROTATION_FACTOR = 0.5;

// Drone orientation blend range (bezT values)
export const DRONE_ORIENT_BEGIN_T = 0.02;
export const DRONE_ORIENT_FULL_T = 0.25;

// Flight altitude and phase tuning
export const FLIGHT_ORBIT_ALTITUDE = 220_000;
export const FLIGHT_ORBIT_ENTRY_ALTITUDE = 520_000;
export const FLIGHT_DESCENT_PHASE_END = 0.26;
export const FLIGHT_CRUISE_PHASE_END = 0.88;

// Reentry burn effect
export const REENTRY_BURN_START_ALTITUDE = 180_000 * TERRAIN_EXAGGERATION;
export const REENTRY_BURN_FULL_ALTITUDE = 70_000 * TERRAIN_EXAGGERATION;
