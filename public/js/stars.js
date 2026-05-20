// Distant starfield. The group's position is updated each frame in main.js
// to follow the camera so the stars never appear to move.

import * as THREE from 'three';
import { scene } from './scene.js';

const STAR_MIN = 260000000000;
const STAR_RANGE = 220000000000;

// Soft radial-gradient point sprite
const starTexCanvas = document.createElement('canvas');
starTexCanvas.width = 64;
starTexCanvas.height = 64;
const sctx = starTexCanvas.getContext('2d');
const grad = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
grad.addColorStop(0,    'rgba(255,255,255,1)');
grad.addColorStop(0.08, 'rgba(255,255,255,0.95)');
grad.addColorStop(0.2,  'rgba(255,255,255,0.6)');
grad.addColorStop(0.4,  'rgba(255,255,255,0.15)');
grad.addColorStop(0.7,  'rgba(255,255,255,0.02)');
grad.addColorStop(1,    'rgba(255,255,255,0)');
sctx.fillStyle = grad;
sctx.fillRect(0, 0, 64, 64);
const starTex = new THREE.CanvasTexture(starTexCanvas);

function makePoints(count, size, opacity) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = STAR_MIN + Math.random() * STAR_RANGE;
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: '#ffffff', size, map: starTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity,
    fog: false,
  });
  mat.toneMapped = false;
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export const starfield = new THREE.Group();
starfield.add(makePoints(25000, 1800000000, 0.95));
starfield.add(makePoints(3000, 3600000000, 0.85));
scene.add(starfield);
