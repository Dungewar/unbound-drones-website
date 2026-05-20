// Earth surface — sphere mesh with adaptive bump displacement and day/night textures.
// Sun, atmosphere, and city are in their own modules.

import * as THREE from 'three';
import { scene, renderer, camera, LOCAL_LIGHT_LAYER } from './scene.js';
import {
  EARTH_R, EARTH_POSITION, TERRAIN_EXAGGERATION,
  BUMP_DISPLACEMENT_SCALE, SOLAR_ILLUMINANCE_LUX, CAMERA_FOV,
} from './config.js';
import { sunDirUniform } from './sun.js';
import { atmosphereUniforms } from './atmosphere.js';

// ── Earth group ──────────────────────────────
export const earthGroup = new THREE.Group();
earthGroup.position.copy(EARTH_POSITION);
scene.add(earthGroup);

// ── Texture LOD loading ──────────────────────
const texLoader = new THREE.TextureLoader();
texLoader.crossOrigin = 'anonymous';
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// ── Texture load queue (off-thread decode) ──
const TILE_LOAD_CONCURRENCY = 6;
const tileLoadQueue = [];
let activeTileLoads = 0;

function drainTileLoadQueue() {
  while (activeTileLoads < TILE_LOAD_CONCURRENCY && tileLoadQueue.length > 0) {
    const job = tileLoadQueue.shift();
    if (earthDisposed || job.token !== job.tile.requestToken) continue;
    activeTileLoads++;
    loadTileTexturesAsync(job).finally(() => {
      activeTileLoads--;
      drainTileLoadQueue();
    });
  }
}

const TILE_CACHE = 'earth-tiles-v1';

async function fetchCachedBlob(url) {
  try {
    const cache = await caches.open(TILE_CACHE);
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      cache.put(url, res.clone());
    }
    return res.blob();
  } catch {
    return fetch(url).then(r => r.blob());
  }
}

async function loadTileTexturesAsync({ tile, lodIndex, token, onComplete }) {
  const lod = EARTH_TEXTURE_LOD_LEVELS[lodIndex];
  try {

    const [colorBlob, nightBlob] = await Promise.all([
      fetchCachedBlob(tileTextureURL(lod, 'day', tile)),
      fetchCachedBlob(tileTextureURL(lod, 'night', tile)),
    ]);
    const [colorBitmap, nightBitmap] = await Promise.all([
      createImageBitmap(colorBlob),
      createImageBitmap(nightBlob),
    ]);
    if (earthDisposed || token !== tile.requestToken) {
      colorBitmap.close();
      nightBitmap.close();
      onComplete?.();
      return;
    }
    const colorTexture = new THREE.Texture(colorBitmap);
    colorTexture.flipY = false;
    colorTexture.name = `earth-${lod.id}-day-r${tile.row}-c${tile.col}`;
    configureTileTexture(colorTexture);

    const nightTexture = new THREE.Texture(nightBitmap);
    nightTexture.flipY = false;
    nightTexture.name = `earth-${lod.id}-night-r${tile.row}-c${tile.col}`;
    configureTileTexture(nightTexture);

    applyTileTextures(tile, lodIndex, colorTexture, nightTexture);
    publishEarthLODState();
    onComplete?.();

  } catch (err) {
    console.warn(`[earth] failed to load ${lod.id} tile r${tile.row} c${tile.col}`, err);
    if (token === tile.requestToken) tile.pendingLODIndex = -1;
    onComplete?.();
  }
}

// ── Geometry worker ─────────────────────────
const geometryWorker = new Worker('/js/earth-geometry-worker.js');
let geometryRequestId = 0;
let _sampleRequestId = 0;
const _sampleResolvers = new Map();

geometryWorker.onmessage = (e) => {
  const { id, phase, error } = e.data;

  if (phase === 3 && _sampleResolvers.has(id)) {
    _sampleResolvers.get(id)(e.data.height);
    _sampleResolvers.delete(id);
    return;
  }

  if (id !== geometryRequestId || earthDisposed) return;

  if (phase === -1 || error) {
    console.warn('[earth] geometry worker error:', error);
    pendingGeometryLODIndex = -1;
    publishEarthLODState();
    if (_firstGeometryResolve) { _firstGeometryResolve(); _firstGeometryResolve = null; }
    if (_geometryAppliedResolve) { _geometryAppliedResolve(); _geometryAppliedResolve = null; }
    return;
  }

  if (phase === 'progress') {
    console.log(`[earth] ${e.data.step}`);
    return;
  }

  if (phase === 0) {
    elevationRanges = e.data.elevationRanges;
    subdivTargets = computeBumpSubdivTargets();
    bumpDepths = computeBumpDepths();
    const maxD = Math.max(...bumpDepths);
    const depthBins = new Array(maxD + 1).fill(0);
    for (let i = 0; i < bumpDepths.length; i++) depthBins[bumpDepths[i]]++;
    console.log(`[earth] phase 0 — ${bumpDepths.length} cells, depth distribution: ${depthBins.map((c, d) => `d${d}=${c.toLocaleString()}`).join(' ')}`);
    if (subdivTargets) {
      let stMin = Infinity, stMax = -Infinity, stSum = 0;
      for (let i = 0; i < subdivTargets.length; i++) {
        const v = subdivTargets[i];
        if (v < stMin) stMin = v;
        if (v > stMax) stMax = v;
        stSum += v;
      }
      console.log(`[earth] phase 0 — subdivTarget range [${stMin.toFixed(1)}, ${stMax.toFixed(1)}], avg ${(stSum / subdivTargets.length).toFixed(1)}`);
    }
    if (earthRenderMode === 'heatmap' && heatmapLODMode === 'bump') rebuildHeatmapForMode();
    console.log(`[earth] phase 0 — depths received, waiting for worker assembly...`);
    if (_firstGeometryResolve) { console.log('[earth] terrain mesh building started'); _firstGeometryResolve(); _firstGeometryResolve = null; }
    return;
  }

  if (phase === 1) {
    // Progress only — assembly happens in the worker
    console.log(`[earth] row ${e.data.row + 1}/${e.data.totalRows}`);
    return;
  }

  if (phase === 2) {
    console.log(`[earth] phase 2 — received assembled geometry (${e.data.totalVertices.toLocaleString()} verts)`);
    const lodIndex = pendingGeometryLODIndex;
    if (lodIndex < 0) return;
    const lod = EARTH_TEXTURE_LOD_LEVELS[lodIndex];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(e.data.positions, 3));
    geo.setAttribute('uv', new THREE.Int16BufferAttribute(e.data.uvs, 2, true));
    geo.setAttribute('normal', new THREE.Int8BufferAttribute(e.data.normals, 3, true));
    geo.setIndex(new THREE.Uint32BufferAttribute(e.data.indices, 1));

    const groups = e.data.groups;
    for (let i = 0; i < groups.length; i += 3) {
      geo.addGroup(groups[i], groups[i + 1], groups[i + 2]);
    }

    const globalUVAttr = new THREE.Int16BufferAttribute(e.data.globalUVs, 2, true);
    geo.setAttribute('_globalUV', globalUVAttr);
    earthGlobalUV = globalUVAttr;
    earthTileUV = geo.getAttribute('uv');

    // Track per-tile triangle counts for bump-mode heatmap
    for (let i = 0; i < groups.length; i += 3) {
      const mat = groups[i + 2];
      if (mat < earthTiles.length) {
        earthTiles[mat].bumpTris = groups[i + 1] / 3;
      }
    }

    earthSurface.geometry.dispose();
    earthSurface.geometry = geo;

    // The geometry now reflects pending depths — make them active
    if (pendingDynamicDepths) {
      activeDepths = pendingDynamicDepths;
      pendingDynamicDepths = null;
    }

    earthHeatmapUVActive = false;
    if (earthRenderMode === 'heatmap') {
      const attrUv = geo.getAttribute('uv');
      const attrGlobal = geo.getAttribute('_globalUV');
      if (attrUv && attrGlobal) {
        geo.setAttribute('uv', attrGlobal);
        geo.setAttribute('_globalUV', attrUv);
        earthHeatmapUVActive = true;
      }
      if (heatmapLODMode === 'distance') rebuildHeatmapFromActiveDepths();
    }

    activeGeometryLODIndex = lodIndex;
    pendingGeometryLODIndex = -1;
    if (_geometryAppliedResolve) { console.log('[earth] geometry applied to mesh'); _geometryAppliedResolve(); _geometryAppliedResolve = null; }
    if (_firstGeometryResolve) { _firstGeometryResolve(); _firstGeometryResolve = null; }

    const vertCount = geo.getAttribute('position').count;
    const triCount = geo.index ? geo.index.count / 3 : 0;
    const geometryParams = getAdaptiveBumpParamsForLOD(lod);
    publishEarthLODState({
      ...geometryParams,
      source: lod.bumpSource,
      vertices: vertCount,
      triangles: triCount,
    });
    console.log(
      `[earth] ${lod.id} adaptive mesh: ${vertCount.toLocaleString()} vertices, ${triCount.toLocaleString()} triangles`,
    );

    // If camera has moved during the build, start another rebuild immediately
    if (distanceLODEnabled && bumpDepths) {
      camera.getWorldPosition(_earthCameraWorld2);
      const combinedDepths = computePerCellCombinedDepths(_earthCameraWorld2);
      if (combinedDepths) {
        let changed = !activeDepths || activeDepths.length !== combinedDepths.length;
        if (!changed) {
          for (let i = 0; i < combinedDepths.length; i++) {
            if (combinedDepths[i] !== activeDepths[i]) { changed = true; break; }
          }
        }
        if (changed) {
          console.log('[earth] camera moved during build — starting next rebuild');
          requestAdaptiveGeometryLOD(EARTH_TEXTURE_LOD_LEVELS.length - 1, combinedDepths);
        }
      }
    }
  }
};

// Camera pos for phase 2 continuous-rebuild check
const _earthCameraWorld2 = new THREE.Vector3();

export const EARTH_TILE_ROWS = 12;
export const EARTH_TILE_COLS = 24;

export const EARTH_TEXTURE_LOD_LEVELS = [
  {
    id: 'far-256',
    label: '256px tiles',
    minTileDistance: 16_000_000,
    minCameraAltitude: 14_000_000,
    tileSize: 256,
    bumpSource: '/assets/lod/earth-bump-2048.jpg',
    bumpWidth: 2048,
    bumpDetailScale: 0.50,
    heatmapColor: '#2f7df6',
  },
  {
    id: 'orbit-512',
    label: '512px tiles',
    minTileDistance: 8_000_000,
    minCameraAltitude: 6_000_000,
    tileSize: 512,
    bumpSource: '/assets/lod/earth-bump-4096.jpg',
    bumpWidth: 4096,
    bumpDetailScale: 0.80,
    heatmapColor: '#26c485',
  },
  {
    id: 'surface-1024',
    label: '1024px tiles',
    minTileDistance: 0,
    minCameraAltitude: 0,
    tileSize: 1024,
    bumpSource: '/assets/lod/earth-bump-8192.jpg',
    bumpWidth: 8192,
    bumpDetailScale: 1,
    heatmapColor: '#ffb000',
  },
];

// baseSegments as clean multiples of the tile grid so cells never straddle tiles.
// 336×168 on 8192×4096 bump ≈ 24×24 px/cell → log2(24) ≈ 4.6
// Pixel-aware cap (floor(log2(pxPerCell))) computed per LOD in the worker.
// maxDepth here is an absolute safety ceiling only.
const FULL_DETAIL_BUMP_PARAMS = {
  baseSegmentsLon: 336,  // 24 × 14
  baseSegmentsLat: 168,  // 12 × 14
  maxDepth: 8,
  threshold: 0.05,
};

// Maximum screen-pixel geometric error allowed before a cell needs more
// subdivision.  Lower → more triangles, higher → fewer.  1.5 px is
// imperceptible at any viewing distance.
const MAX_GEOMETRIC_ERROR_PIXELS = 1.5;

function configureColorTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
}

let earthTexturesEnabled = true;
let earthRenderMode = 'textures';
let heatmapLODMode = 'bump';        // 'bump' | 'distance' — which LOD data the heatmap shows
let distanceLODEnabled = true;
let textureLODEnabled = false;
let lastCameraAltitude = 0;
let activeGeometryLODIndex = -1;
let pendingGeometryLODIndex = -1;
let earthDisposed = false;
let _loggedFirstFrame = false;
let _firstGeometryResolve = null;
let _geometryAppliedResolve = null;
export const firstGeometryReady = new Promise(r => { _firstGeometryResolve = r; });
export const geometryApplied = new Promise(r => { _geometryAppliedResolve = r; });

// Dynamic-screen-error LOD state
let elevationRanges = null;       // Uint8Array — raw pixel ranges (0-255) per base cell
let bumpDepths = null;            // Uint8Array — bump-only depths (0-5) per base cell
let activeDepths = null;          // Uint8Array — current depths used by active geometry
let pendingDynamicDepths = null;  // Uint8Array — depths sent to worker, pending build
let subdivTargets = null;         // Uint8Array — continuous targets for heatmap colouring
let dynamicDepthRequestId = 0;
const earthShadowsEnabledUniform = { value: 1 };

let earthCellHeatmapTex = null;   // per-cell CanvasTexture for heatmap mode
let heatmapCanvas = null;
let heatmapCtx = null;
let heatmapRequestId = 0;
const heatmapWorker = new Worker('/js/heatmap-worker.js');

heatmapWorker.onmessage = (e) => {
  const { id, phase } = e.data;
  if (id !== heatmapRequestId) return;

  const baseLon = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon;
  const baseLat = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLat;

  if (phase === 'chunk') {
    const { startCol, endCol, pixels } = e.data;
    const isFirstChunk = startCol === 0;

    if (isFirstChunk) {
      if (earthCellHeatmapTex) {
        earthCellHeatmapTex.dispose();
        earthCellHeatmapTex = null;
      }
      heatmapCanvas = document.createElement('canvas');
      heatmapCanvas.width = baseLon;
      heatmapCanvas.height = baseLat;
      heatmapCtx = heatmapCanvas.getContext('2d');
    }
    if (!heatmapCtx) return;

    const chunkCols = endCol - startCol;
    const imgData = new ImageData(
      new Uint8ClampedArray(pixels), chunkCols, baseLat,
    );
    heatmapCtx.putImageData(imgData, startCol, 0);

    if (!earthCellHeatmapTex) {
      earthCellHeatmapTex = new THREE.CanvasTexture(heatmapCanvas);
      earthCellHeatmapTex.magFilter = THREE.NearestFilter;
      earthCellHeatmapTex.minFilter = THREE.NearestFilter;
      earthCellHeatmapTex.generateMipmaps = false;
      earthCellHeatmapTex.colorSpace = THREE.SRGBColorSpace;
      for (const tile of earthTiles) applyTileRenderMode(tile);
    }
    earthCellHeatmapTex.needsUpdate = true;
  }
};
let earthGlobalUV = null;         // global UV attribute (before tile-local remap)
let earthTileUV = null;           // tile-local UV attribute (normal rendering)
let earthHeatmapUVActive = false; // whether heatmap (global) UVs are currently active

let _earthPreviewResolve;
export const earthPreviewReady = new Promise(r => { _earthPreviewResolve = r; });
export const earthPreviewTex = texLoader.load(
  '/assets/earth-preview.jpg',
  () => _earthPreviewResolve(),
  undefined,
  () => _earthPreviewResolve(),
);
configureColorTexture(earthPreviewTex);
if (maxAniso > 1) earthPreviewTex.anisotropy = maxAniso;

// ── Surface material ─────────────────────────
const earthTiles = [];
const earthSurfaceMaterials = [];
const EARTH_TILE_LON_SPAN = (Math.PI * 2) / EARTH_TILE_COLS;
const EARTH_TILE_LAT_SPAN = Math.PI / EARTH_TILE_ROWS;
const EARTH_TILE_BOUNDING_RADIUS = BUMP_DISPLACEMENT_SCALE + (
  EARTH_R + BUMP_DISPLACEMENT_SCALE
) * Math.sin(Math.hypot(EARTH_TILE_LON_SPAN, EARTH_TILE_LAT_SPAN) * 0.5);

function pointOnEarth(u, v, radius = EARTH_R) {
  const phi = u * 2 * Math.PI;
  const theta = v * Math.PI;
  const sinTheta = Math.sin(theta);
  return new THREE.Vector3(
    -radius * Math.cos(phi) * sinTheta,
    radius * Math.cos(theta),
    radius * Math.sin(phi) * sinTheta,
  );
}

function createEarthTileMaterial(row, col) {
  const material = new THREE.MeshPhongMaterial({
    color: '#b8b8b8',
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.6,
    specular: new THREE.Color('#000000'),
    shininess: 1,
    fog: false,
  });
  material.onBeforeCompile = applyEarthSurfaceShader;
  material.userData.tile = { row, col };
  return material;
}

function requestHeatmapBuild(mode, subdivTargetsData, normMax) {
  const id = ++heatmapRequestId;
  const baseLon = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon;
  const baseLat = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLat;
  const copy = new Float32Array(subdivTargetsData);
  heatmapWorker.postMessage(
    { id, mode: 'bump', baseLon, baseLat, subdivTargets: copy, normMax },
    [copy.buffer],
  );
}

function applyTileRenderMode(tile) {
  const lod = EARTH_TEXTURE_LOD_LEVELS[tile.activeLODIndex];
  if (earthRenderMode === 'textures') {
    tile.material.map = tile.colorTexture;
    tile.material.emissiveMap = tile.nightTexture;
    tile.material.color.set('#b8b8b8');
    tile.material.emissiveIntensity = 0.6;
  } else if (earthRenderMode === 'heatmap') {
    tile.material.map = null;
    tile.material.emissiveMap = null;
    if (earthCellHeatmapTex) {
      tile.material.map = earthCellHeatmapTex;
      tile.material.color.set('#ffffff');
    } else if (tile.bumpTris > 0) {
      // Color by triangle density: blue (flat) → green → red (mountainous)
      const t = Math.min(1, tile.bumpTris / 1200);
      tile.material.color.setHSL(0.6 - t * 0.6, 0.8, 0.25 + t * 0.35);
    } else {
      tile.material.color.set(lod?.heatmapColor ?? '#404040');
    }
    tile.material.emissiveIntensity = 0;
  } else {
    tile.material.map = null;
    tile.material.emissiveMap = null;
    tile.material.color.set('#c8c8c8');
    tile.material.emissiveIntensity = 0;
  }
  tile.material.needsUpdate = true;
}

for (let row = 0; row < EARTH_TILE_ROWS; row++) {
  for (let col = 0; col < EARTH_TILE_COLS; col++) {
    const material = createEarthTileMaterial(row, col);
    earthSurfaceMaterials.push(material);
    earthTiles.push({
      row,
      col,
      material,
      activeLODIndex: -1,
      pendingLODIndex: -1,
      targetLODIndex: 0,
      requestToken: 0,
      colorTexture: null,
      nightTexture: null,
      bumpTris: 0,
      localCenter: pointOnEarth(
        (col + 0.5) / EARTH_TILE_COLS,
        (row + 0.5) / EARTH_TILE_ROWS,
      ),
      localBoundingRadius: EARTH_TILE_BOUNDING_RADIUS,
      inFrustum: true,
      inHorizon: true,
      visible: true,
      distance: Infinity,
    });
  }
}

function baseSegmentsForLOD(lod) {
  const p = getAdaptiveBumpParamsForLOD(lod);
  return {
    lon: scaledEven(p.baseSegmentsLon * 2, EARTH_TILE_COLS),
    lat: scaledEven(p.baseSegmentsLat * 2, EARTH_TILE_ROWS),
  };
}


function buildGroupedSphereGeometry(radius, lonSegments, latSegments) {
  // Per-tile vertex grids with tile-local UVs [0,1].  Each tile gets its own
  // independent grid so UVs never overflow tile boundaries — no clamping
  // seams, no repeat/offset, no derivative inflation, correct mipmaps.
  const positions = [];
  const normals = [];
  const uvAttr = [];
  const allIndices = [];
  const geometry = new THREE.BufferGeometry();

  const segsPerCol = Math.max(2, Math.ceil(lonSegments / EARTH_TILE_COLS));
  const segsPerRow = Math.max(2, Math.ceil(latSegments / EARTH_TILE_ROWS));

  for (let row = 0; row < EARTH_TILE_ROWS; row++) {
    for (let col = 0; col < EARTH_TILE_COLS; col++) {
      const u0 = col / EARTH_TILE_COLS;
      const u1 = (col + 1) / EARTH_TILE_COLS;
      const v0 = row / EARTH_TILE_ROWS;
      const v1 = (row + 1) / EARTH_TILE_ROWS;

      const groupStart = allIndices.length;
      const baseIdx = positions.length / 3;
      const w = segsPerCol + 1;

      for (let ty = 0; ty <= segsPerRow; ty++) {
        for (let tx = 0; tx <= segsPerCol; tx++) {
          const tu = tx / segsPerCol;
          const tv = ty / segsPerRow;
          const globalU = u0 + tu * (u1 - u0);
          const globalV = v0 + tv * (v1 - v0);
          const p = pointOnEarth(globalU, globalV, radius);
          positions.push(p.x, p.y, p.z);
          const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
          normals.push(p.x / len, p.y / len, p.z / len);
          uvAttr.push(tu, tv);
        }
      }

      for (let ty = 0; ty < segsPerRow; ty++) {
        for (let tx = 0; tx < segsPerCol; tx++) {
          const TL = baseIdx + ty * w + tx;
          const TR = baseIdx + ty * w + (tx + 1);
          const BL = baseIdx + (ty + 1) * w + tx;
          const BR = baseIdx + (ty + 1) * w + (tx + 1);
          allIndices.push(TR, TL, BR, TL, BL, BR);
        }
      }

      const groupCount = allIndices.length - groupStart;
      geometry.addGroup(groupStart, groupCount, row * EARTH_TILE_COLS + col);
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvAttr, 2));
  geometry.setIndex(allIndices);
  return geometry;
}

const _initialSegments = baseSegmentsForLOD(EARTH_TEXTURE_LOD_LEVELS[EARTH_TEXTURE_LOD_LEVELS.length - 1]);
export const earthSurface = new THREE.Mesh(
  buildGroupedSphereGeometry(EARTH_R, _initialSegments.lon, _initialSegments.lat),
  earthSurfaceMaterials,
);
earthSurface.castShadow = true;
earthSurface.receiveShadow = true;
earthGroup.add(earthSurface);

function resolveTileLODIndex(tileDistance) {
  for (let i = 0; i < EARTH_TEXTURE_LOD_LEVELS.length; i++) {
    if (tileDistance >= EARTH_TEXTURE_LOD_LEVELS[i].minTileDistance) return i;
  }
  return EARTH_TEXTURE_LOD_LEVELS.length - 1;
}

function resolveGeometryLODIndex(cameraAltitude) {
  for (let i = 0; i < EARTH_TEXTURE_LOD_LEVELS.length; i++) {
    if (cameraAltitude >= EARTH_TEXTURE_LOD_LEVELS[i].minCameraAltitude) return i;
  }
  return EARTH_TEXTURE_LOD_LEVELS.length - 1;
}

function disposeTextureWithBitmap(texture) {
  if (!texture) return;
  const bitmap = texture.source?.data;
  texture.dispose?.();
  if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}

function disposeTileTextures(tile) {
  if (tile.colorTexture) disposeTextureWithBitmap(tile.colorTexture);
  if (tile.nightTexture) disposeTextureWithBitmap(tile.nightTexture);
  tile.colorTexture = null;
  tile.nightTexture = null;
}

function scaledEven(value, minValue) {
  return Math.max(minValue, Math.round(value / 2) * 2);
}

function getAdaptiveBumpParamsForLOD(lod) {
  const detailScale = lod.bumpDetailScale;
  return {
    baseSegmentsLon: scaledEven(FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon * detailScale, 24),
    baseSegmentsLat: scaledEven(FULL_DETAIL_BUMP_PARAMS.baseSegmentsLat * detailScale, 12),
    maxDepth: Math.max(3, Math.round(FULL_DETAIL_BUMP_PARAMS.maxDepth * detailScale)),
    threshold: FULL_DETAIL_BUMP_PARAMS.threshold / detailScale,
    displacementScale: BUMP_DISPLACEMENT_SCALE,
    tileRows: EARTH_TILE_ROWS,
    tileCols: EARTH_TILE_COLS,
  };
}

// ── LOD depth computation ──────────────────────────────────────
// Bump mode (always-on base) — per-cell adaptive depth from the
//   bump map's pixel-scale roughness.
// Distance mode (optional) — subtracts a uniform penalty from each
//   cell's bump depth based on camera altitude, preserving the
//   terrain-adaptive character while reducing overall detail.

// Distance mode: per-cell depth cap from camera distance.
// Bump mode: continuous subdiv targets from bump-map precision only.
//   subdivTarget = elevationRange / (1/255)  — one grayscale level = 1 sub-cell
function computeBumpSubdivTargets() {
  if (!elevationRanges) return null;
  const maxSubdiv = 1 << FULL_DETAIL_BUMP_PARAMS.maxDepth;
  const targets = new Float32Array(elevationRanges.length);
  for (let i = 0; i < elevationRanges.length; i++) {
    // Continuous target — no rounding, so the heatmap gets a smooth
    // gradient across the full range.
    targets[i] = Math.max(0, Math.min(maxSubdiv,
      elevationRanges[i] * 255));
  }
  return targets;
}

// Pixel-aware cap from the highest-res bump LOD
const MAX_BUMP_LOD = EARTH_TEXTURE_LOD_LEVELS[EARTH_TEXTURE_LOD_LEVELS.length - 1];
const PIXEL_MAX_DEPTH = Math.ceil(Math.log2(MAX_BUMP_LOD.bumpWidth / FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon));

function computeBumpDepths() {
  if (!elevationRanges) return null;
  const threshold = 1 / 255;
  const depths = new Int32Array(elevationRanges.length);
  for (let i = 0; i < elevationRanges.length; i++) {
    const range = elevationRanges[i];
    if (range <= threshold) {
      depths[i] = 0;
    } else {
      depths[i] = Math.min(PIXEL_MAX_DEPTH, Math.ceil(Math.log2(range / threshold)) + 1);
    }
  }
  return depths;
}

// Precomputed cell normals on the unit sphere — computed once per init
let _cellNormals = null;
function ensureCellNormals() {
  if (_cellNormals) return;
  const baseLon = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon;
  const baseLat = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLat;
  _cellNormals = new Float32Array(baseLon * baseLat * 3);
  for (let i = 0; i < baseLon; i++) {
    const phi = ((i + 0.5) / baseLon) * 2 * Math.PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    for (let j = 0; j < baseLat; j++) {
      const theta = ((j + 0.5) / baseLat) * Math.PI;
      const sinTheta = Math.sin(theta);
      const idx = (i * baseLat + j) * 3;
      _cellNormals[idx]     = -cosPhi * sinTheta;
      _cellNormals[idx + 1] = Math.cos(theta);
      _cellNormals[idx + 2] = sinPhi * sinTheta;
    }
  }
}
function computePerCellCombinedDepths(cameraWorldPos) {
  if (!bumpDepths) return null;
  ensureCellNormals();

  const R = EARTH_R;
  const fovRad = CAMERA_FOV * Math.PI / 180;
  const pixelsPerRadian = window.innerHeight / fovRad;
  const baseLon = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLon;
  const baseLat = FULL_DETAIL_BUMP_PARAMS.baseSegmentsLat;
  const maxD = FULL_DETAIL_BUMP_PARAMS.maxDepth;
  const maxSubdiv = 1 << maxD;
  const TARGET_PX_PER_TRI = 0.5;
  const cellAngularWidth = (Math.PI * 2) / baseLon;
  const cellWidthM = cellAngularWidth * R;

  // Camera direction from earth center (world space)
  const cdx = cameraWorldPos.x - EARTH_POSITION.x;
  const cdy = cameraWorldPos.y - EARTH_POSITION.y;
  const cdz = cameraWorldPos.z - EARTH_POSITION.z;
  const camDist = Math.sqrt(cdx*cdx + cdy*cdy + cdz*cdz);
  const h = camDist - R;

  // Rotate camera direction into earth-local frame so the dot product
  // against _cellNormals (which are in unrotated local space) is correct.
  const cosRY = Math.cos(earthGroup.rotation.y);
  const sinRY = Math.sin(earthGroup.rotation.y);
  const cnx = (cdx * cosRY - cdz * sinRY) / camDist;
  const cny = cdy / camDist;
  const cnz = (cdx * sinRY + cdz * cosRY) / camDist;

  const combined = new Int32Array(baseLon * baseLat);
  const depthBins = new Array(maxD + 1).fill(0);

  for (let i = 0; i < baseLon; i++) {
    for (let j = 0; j < baseLat; j++) {
      const idx = i * baseLat + j;
      const bd = bumpDepths[idx];
      if (bd === 0) { depthBins[0]++; continue; }

      const n3 = idx * 3;
      const cosAngle = _cellNormals[n3]*cnx + _cellNormals[n3+1]*cny + _cellNormals[n3+2]*cnz;

      // Cell is below the horizon when the camera ray is tangent to the
      // sphere at a closer point: cosAngle ≤ R/(R+h).
      if ((R + h) * cosAngle <= R) { depthBins[0]++; continue; }

      // Straight-line distance from camera to this cell centre.
      const dist = Math.sqrt(R*R + (R+h)*(R+h) - 2*R*(R+h)*cosAngle);

      // Foreshortening: a cell viewed at a grazing angle (near the limb)
      // appears narrower.  cosBeta = |dot(viewRay, cellNormal)| gives the
      // projected-width fraction — 1 when facing the camera, 0 at the limb.
      //   viewRay = (cellPos − cameraPos) / dist
      //   dot(viewRay, cellNormal) = ((R+h)*cosAngle − R) / dist
      const cosBeta = ((R + h) * cosAngle - R) / dist;
      const foreshorten = Math.abs(cosBeta);

      // Apparent angular width — physical width × foreshortening / distance.
      const angFromCam = cellWidthM * foreshorten / dist;
      const cellPx = angFromCam * pixelsPerRadian;
      const triTarget = (cellPx * cellPx) / (2 * TARGET_PX_PER_TRI);
      const subdivTarget = Math.max(1, Math.min(maxSubdiv, Math.ceil(Math.sqrt(triTarget))));
      const distDepth = Math.max(0, Math.min(maxD, Math.ceil(Math.log2(Math.max(1, subdivTarget)))));

      const d = Math.min(bd, distDepth);
      combined[idx] = d;
      depthBins[d]++;
    }
  }
  return combined;
}

function publishEarthLODState(geometryParams = null) {
  const activeLOD = EARTH_TEXTURE_LOD_LEVELS[activeGeometryLODIndex] ?? null;
  const pendingLOD = EARTH_TEXTURE_LOD_LEVELS[pendingGeometryLODIndex] ?? null;
  const previousState = window.__UNBOUND_EARTH_LOD ?? {};
  const tileCounts = EARTH_TEXTURE_LOD_LEVELS.reduce((counts, lod) => {
    counts[lod.id] = 0;
    return counts;
  }, {});
  let visibleTiles = 0;
  let frustumTiles = 0;
  let horizonTiles = 0;
  for (const tile of earthTiles) {
    if (tile.activeLODIndex >= 0) tileCounts[EARTH_TEXTURE_LOD_LEVELS[tile.activeLODIndex].id] += 1;
    if (tile.inFrustum) frustumTiles += 1;
    if (tile.inHorizon) horizonTiles += 1;
    if (tile.visible) visibleTiles += 1;
  }
  const depthStats = activeDepths
    ? { min: Infinity, max: -Infinity, sum: 0, count: activeDepths.length }
    : null;
  if (depthStats) {
    for (let i = 0; i < activeDepths.length; i++) {
      const v = activeDepths[i];
      if (v < depthStats.min) depthStats.min = v;
      if (v > depthStats.max) depthStats.max = v;
      depthStats.sum += v;
    }
    depthStats.avg = depthStats.sum / depthStats.count;
  }

  window.__UNBOUND_EARTH_LOD = {
    geometryActive: activeLOD?.id ?? null,
    geometryPending: pendingLOD?.id ?? null,
    cameraAltitude: previousState.cameraAltitude ?? null,
    quality: {
      maxErrorPixels: MAX_GEOMETRIC_ERROR_PIXELS,
      elevationRangesLoaded: elevationRanges !== null,
      dynamicDepths: depthStats,
    },
    thresholds: EARTH_TEXTURE_LOD_LEVELS.map((lod) => ({
      id: lod.id,
      minTileDistance: lod.minTileDistance,
      minCameraAltitude: lod.minCameraAltitude,
      tileSize: lod.tileSize,
      bumpDetailScale: lod.bumpDetailScale,
    })),
    tiles: {
      total: earthTiles.length,
      visible: visibleTiles,
      inFrustum: frustumTiles,
      inHorizon: horizonTiles,
      activeByLOD: tileCounts,
    },
    geometry: geometryParams ?? previousState.geometry ?? null,
  };
}

function requestAdaptiveGeometryLOD(lodIndex, depths, customOpts) {
  if (earthDisposed) return;
  if (!depths && !customOpts && lodIndex === activeGeometryLODIndex) return;
  if (!depths && !customOpts && lodIndex === pendingGeometryLODIndex) return;

  const lod = EARTH_TEXTURE_LOD_LEVELS[lodIndex];
  const id = ++geometryRequestId;
  pendingGeometryLODIndex = lodIndex;
  if (depths) {
    dynamicDepthRequestId = id;
    pendingDynamicDepths = depths;
  }
  publishEarthLODState();

  const opts = customOpts || getAdaptiveBumpParamsForLOD(lod);
  if (depths) opts.depths = depths;
  opts.smooth = isBumpSmoothingEnabled();

  geometryWorker.postMessage({
    id,
    url: lod.bumpSource,
    radius: EARTH_R,
    opts,
  });
}

function configureTileTexture(texture) {
  configureColorTexture(texture);
  if (maxAniso > 1) texture.anisotropy = maxAniso;
  texture.needsUpdate = true;
  renderer.initTexture(texture);
}

function tileTextureURL(lod, kind, tile) {
  return `/assets/earth-tiles/${lod.id}/${kind}/tile-r${tile.row}-c${tile.col}.jpg`;
}

function applyTileTextures(tile, lodIndex, colorTexture, nightTexture) {
  disposeTileTextures(tile);
  tile.colorTexture = colorTexture;
  tile.nightTexture = nightTexture;
  tile.activeLODIndex = lodIndex;
  tile.pendingLODIndex = -1;
  applyTileRenderMode(tile);
}

function unloadTileTextures(tile) {
  tile.requestToken += 1;
  tile.pendingLODIndex = -1;
  tile.targetLODIndex = 0;
  disposeTileTextures(tile);
  tile.activeLODIndex = -1;
  applyTileRenderMode(tile);
}

function requestTileLOD(tile, lodIndex, onComplete) {
  if (earthDisposed) { onComplete?.(); return; }
  tile.targetLODIndex = lodIndex;

  if (lodIndex === tile.activeLODIndex || lodIndex === tile.pendingLODIndex) { onComplete?.(); return; }
  const token = ++tile.requestToken;
  tile.pendingLODIndex = lodIndex;

  tileLoadQueue.push({ tile, lodIndex, token, onComplete });
  drainTileLoadQueue();
}

const _earthCameraWorld = new THREE.Vector3();
const _earthTileWorld = new THREE.Vector3();
const _earthTileNormal = new THREE.Vector3();
const _earthTileToCamera = new THREE.Vector3();
const _earthViewProjection = new THREE.Matrix4();
const _earthFrustum = new THREE.Frustum();
const _earthTileSphere = new THREE.Sphere();

export function updateEarthTextureLOD(camera) {
  if (earthDisposed) return;

  camera.getWorldPosition(_earthCameraWorld);
  const cameraAltitude = Math.max(0, _earthCameraWorld.distanceTo(EARTH_POSITION) - EARTH_R);
  lastCameraAltitude = cameraAltitude;

  // Distance LOD: continuously rebuild in background whenever active
  // geometry doesn't match what the camera position demands.
  if (distanceLODEnabled && bumpDepths && pendingGeometryLODIndex < 0) {
    const lodIndex = EARTH_TEXTURE_LOD_LEVELS.length - 1;
    const combinedDepths = computePerCellCombinedDepths(_earthCameraWorld);
    if (combinedDepths) {
      let changed = !activeDepths || activeDepths.length !== combinedDepths.length;
      if (!changed) {
        for (let i = 0; i < combinedDepths.length; i++) {
          if (combinedDepths[i] !== activeDepths[i]) { changed = true; break; }
        }
      }
      if (changed) {
        requestAdaptiveGeometryLOD(lodIndex, combinedDepths);
      }
    }
  }

  const state = window.__UNBOUND_EARTH_LOD ?? {};
  state.cameraAltitude = cameraAltitude;
  window.__UNBOUND_EARTH_LOD = state;

  earthGroup.updateMatrixWorld();
  camera.updateMatrixWorld();
  _earthViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _earthFrustum.setFromProjectionMatrix(_earthViewProjection);

  for (const tile of earthTiles) {
    _earthTileWorld.copy(tile.localCenter).applyMatrix4(earthGroup.matrixWorld);
    _earthTileNormal.copy(_earthTileWorld).sub(EARTH_POSITION).normalize();
    _earthTileToCamera.copy(_earthCameraWorld).sub(_earthTileWorld);

    tile.distance = _earthTileToCamera.length();
    tile.inHorizon = _earthTileNormal.dot(_earthTileToCamera) > -EARTH_R * 0.25;
    _earthTileSphere.center.copy(_earthTileWorld);
    _earthTileSphere.radius = tile.localBoundingRadius;
    tile.inFrustum = _earthFrustum.intersectsSphere(_earthTileSphere);
    tile.visible = tile.inHorizon && tile.inFrustum;
    tile.material.visible = tile.visible;

    if (!tile.visible) continue;

    if (activeGeometryLODIndex >= 0) {
      const lodIndex = textureLODEnabled
        ? resolveTileLODIndex(tile.distance)
        : EARTH_TEXTURE_LOD_LEVELS.length - 1;
      requestTileLOD(tile, lodIndex);
    }
  }

  if (!_loggedFirstFrame && activeGeometryLODIndex >= 0) {
    _loggedFirstFrame = true;
  }

  publishEarthLODState();
}

// ── Night lights + day/night blending ────────
function applyEarthSurfaceShader(shader) {
  shader.uniforms.uSunDir = sunDirUniform;
  shader.uniforms.uAerialEnabled = atmosphereUniforms.uAerialEnabled;
  shader.uniforms.uAerialPlanetCenter = atmosphereUniforms.uPlanetCenter;
  shader.uniforms.uAerialAtmoR = atmosphereUniforms.uAtmosphereRadius;
  shader.uniforms.uAerialGroundRadius = atmosphereUniforms.uGroundRadius;
  shader.uniforms.uAerialRayleighBeta = atmosphereUniforms.uRayleighBeta;
  shader.uniforms.uAerialMieBeta = atmosphereUniforms.uMieBeta;
  shader.uniforms.uAerialOzoneBeta = atmosphereUniforms.uOzoneBeta;
  shader.uniforms.uAerialRayleighScaleH = atmosphereUniforms.uRayleighScaleHeight;
  shader.uniforms.uAerialMieScaleH = atmosphereUniforms.uMieScaleHeight;
  shader.uniforms.uAerialOzoneCenter = atmosphereUniforms.uOzoneCenter;
  shader.uniforms.uAerialOzoneWidth = atmosphereUniforms.uOzoneWidth;
  shader.uniforms.uAerialAirglowColor = atmosphereUniforms.uAirglowColor;
  shader.uniforms.uAerialAirglowIntensity = atmosphereUniforms.uAirglowIntensity;
  shader.uniforms.uAerialTwilightLift = atmosphereUniforms.uTwilightLift;
  shader.uniforms.uEarthShadowsEnabled = earthShadowsEnabledUniform;

  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    'varying vec3 vSmoothWorldNormal;\nvarying vec3 vSurfaceWorldPos;\nvoid main() {',
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <beginnormal_vertex>',
    '#include <beginnormal_vertex>\nvSmoothWorldNormal = normalize(mat3(modelMatrix) * normalize(position));',
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <worldpos_vertex>',
    '#include <worldpos_vertex>\nvSurfaceWorldPos = worldPosition.xyz;',
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    'void main() {',
    `uniform vec3 uSunDir;
    uniform float uAerialEnabled;
    uniform vec3 uAerialPlanetCenter;
    uniform float uAerialAtmoR;
    uniform float uAerialGroundRadius;
    uniform vec3 uAerialRayleighBeta;
    uniform vec3 uAerialMieBeta;
    uniform vec3 uAerialOzoneBeta;
    uniform float uAerialRayleighScaleH;
    uniform float uAerialMieScaleH;
    uniform float uAerialOzoneCenter;
    uniform float uAerialOzoneWidth;
    uniform vec3 uAerialAirglowColor;
    uniform float uAerialAirglowIntensity;
    uniform float uAerialTwilightLift;
    uniform float uEarthShadowsEnabled;
    varying vec3 vSmoothWorldNormal;
    varying vec3 vSurfaceWorldPos;

    vec2 _apRaySphere(vec3 origin, vec3 dir, float radius) {
      vec3 oc = origin - uAerialPlanetCenter;
      float b = dot(oc, dir);
      float c = dot(oc, oc) - radius * radius;
      float h = b * b - c;
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }

    float _apDensityRayleigh(float height) {
      return exp(-max(height, 0.0) / uAerialRayleighScaleH);
    }

    float _apDensityMie(float height) {
      return exp(-max(height, 0.0) / uAerialMieScaleH);
    }

    float _apDensityOzone(float height) {
      float dist = abs(height - uAerialOzoneCenter) / uAerialOzoneWidth;
      return max(0.0, 1.0 - dist);
    }

    vec3 _apExtinction(vec3 opticalDepth) {
      return exp(-(
        uAerialRayleighBeta * opticalDepth.x +
        uAerialMieBeta * opticalDepth.y +
        uAerialOzoneBeta * opticalDepth.z
      ));
    }

    vec3 _apSunDepth(vec3 samplePos) {
      vec2 groundHit = _apRaySphere(samplePos, uSunDir, uAerialGroundRadius);
      if (groundHit.x > 0.0) return vec3(-1.0);

      vec2 atmoHit = _apRaySphere(samplePos, uSunDir, uAerialAtmoR);
      float sunDistance = atmoHit.y;
      if (sunDistance <= 0.0) return vec3(0.0);

      vec3 opticalDepth = vec3(0.0);
      float stepSize = sunDistance / 6.0;
      for (int _k = 0; _k < 6; _k++) {
        float t = (float(_k) + 0.5) * stepSize;
        vec3 pos = samplePos + uSunDir * t;
        float height = length(pos - uAerialPlanetCenter) - uAerialGroundRadius;
        opticalDepth += vec3(
          _apDensityRayleigh(height),
          _apDensityMie(height),
          _apDensityOzone(height)
        ) * stepSize;
      }
      return opticalDepth;
    }

    void main() {`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    `#include <emissivemap_fragment>
    float _earthSunDot = dot(vSmoothWorldNormal, uSunDir);
    float _earthDayFactor = smoothstep(-0.08, 0.05, _earthSunDot);
    float _earthShadowedDayFactor = mix(1.0, _earthDayFactor, uEarthShadowsEnabled);
    float _nightBlend = (1.0 - _earthDayFactor) * uEarthShadowsEnabled;
    totalEmissiveRadiance *= _nightBlend * ${(SOLAR_ILLUMINANCE_LUX * 0.12).toFixed(1)};`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_phong_fragment>',
    `#include <lights_phong_fragment>
    float _earthNoShadowFill = 1.0 - uEarthShadowsEnabled;
    reflectedLight.directDiffuse *= _earthShadowedDayFactor;
    reflectedLight.directSpecular *= _earthShadowedDayFactor;
    reflectedLight.indirectDiffuse *= _earthShadowedDayFactor;
    reflectedLight.indirectDiffuse += diffuseColor.rgb * (300.0 + 2200.0 * _earthNoShadowFill);`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <tonemapping_fragment>',
    `{
      if (uAerialEnabled > 0.5) {
        float _apCameraAlt = length(cameraPosition - uAerialPlanetCenter);
        float _apCameraOutside = step(uAerialAtmoR, _apCameraAlt);
        vec3 _apDir = normalize(vSurfaceWorldPos - cameraPosition);
        float _apTSurf = length(vSurfaceWorldPos - cameraPosition);
        vec2 _apAtmoHit = _apRaySphere(cameraPosition, _apDir, uAerialAtmoR);
        if (_apAtmoHit.y > 0.0) {
          float _apT0 = max(_apAtmoHit.x, 0.0);
          float _apT1 = min(_apAtmoHit.y, _apTSurf);
          float _apSeg = _apT1 - _apT0;
          if (_apSeg > 0.0) {
            vec3 _apDepth = vec3(0.0);
            vec3 _apRayleighAccum = vec3(0.0);
            vec3 _apMieAccum = vec3(0.0);
            float _apStep = _apSeg / 14.0;
            for (int _j = 0; _j < 14; _j++) {
              vec3 _apPos = cameraPosition + _apDir * (_apT0 + (float(_j) + 0.5) * _apStep);
              float _apH = length(_apPos - uAerialPlanetCenter) - uAerialGroundRadius;
              if (_apH < 0.0) continue;

              vec3 _apLocalDensity = vec3(
                _apDensityRayleigh(_apH),
                _apDensityMie(_apH),
                _apDensityOzone(_apH)
              );
              _apDepth += _apLocalDensity * _apStep;

              vec3 _apSunDepthAccum = _apSunDepth(_apPos);
              if (_apSunDepthAccum.x < 0.0) continue;

              vec3 _apSampleDir = normalize(_apPos - uAerialPlanetCenter);
              float _apSunWeight = smoothstep(-0.05, 0.15, dot(_apSampleDir, uSunDir));

              vec3 _apTransmittance = _apExtinction(_apDepth + _apSunDepthAccum);
              _apRayleighAccum += _apLocalDensity.x * _apTransmittance * _apStep * _apSunWeight;
              _apMieAccum += _apLocalDensity.y * _apTransmittance * _apStep * _apSunWeight;
            }

            float _apMu = dot(uSunDir, -_apDir);
            float _apMu2 = _apMu * _apMu;
            float _apPhaseR = 0.05968310365 * (1.0 + _apMu2);
            float _apG = 0.82;
            float _apG2 = _apG * _apG;
            float _apMieDenom = pow(max(1.0 + _apG2 - 2.0 * _apG * _apMu, 0.001), 1.5);
            float _apPhaseM = (3.0 / (8.0 * 3.141592653589793)) * ((1.0 - _apG2) * (1.0 + _apMu2)) / ((2.0 + _apG2) * _apMieDenom);
            vec3 _apScatter = (
              _apPhaseR * uAerialRayleighBeta * _apRayleighAccum +
              _apPhaseM * uAerialMieBeta * _apMieAccum
            ) * ${SOLAR_ILLUMINANCE_LUX.toFixed(1)};

            vec3 _apShellNormal = normalize(vSurfaceWorldPos - uAerialPlanetCenter);
            float _apViewZenith = clamp(dot(_apShellNormal, -_apDir), 0.0, 1.0);
            float _apHorizonBoost = 0.42 + 2.45 * pow(1.0 - _apViewZenith, 2.05);
            float _apShellSun = dot(_apShellNormal, uSunDir);
            float _apDayWeight = mix(1.0, smoothstep(-0.18, 0.18, _apShellSun), uEarthShadowsEnabled);
            float _apOutsideBoost = mix(1.15, 2.05, _apCameraOutside);
            float _apNightWeight = smoothstep(0.08, 0.72, -_apShellSun) * uEarthShadowsEnabled;
            float _apTerminatorWeight = (1.0 - smoothstep(0.08, 0.62, abs(_apShellSun + 0.03))) * uEarthShadowsEnabled;
            float _apViewAirMass = pow(1.0 - _apViewZenith, 1.4);
            vec3 _apDayScatter = _apScatter * _apHorizonBoost * _apDayWeight * 1.35;
            vec3 _apNightAirglow = uAerialAirglowColor
              * (uAerialAirglowIntensity * 95.0 * _apNightWeight * (0.22 + 1.15 * _apViewAirMass));
            vec3 _apTwilightTint = mix(vec3(0.22, 0.36, 0.78), uAerialAirglowColor, 0.52)
              * (uAerialTwilightLift * 9.0 * _apTerminatorWeight * (0.18 + 1.1 * _apViewAirMass));
            gl_FragColor.rgb += (_apDayScatter + _apNightAirglow + _apTwilightTint) * _apOutsideBoost;
          }
        }
      }
    }
    #include <tonemapping_fragment>`,
  );
}

// ── Public API ───────────────────────────────
export function setEarthTextureLightingMode(texturesOn) {
  earthRenderMode = texturesOn ? 'textures' : 'lighting';
  earthTexturesEnabled = earthRenderMode === 'textures';
  if (earthHeatmapUVActive) {
    const attrUv = earthSurface.geometry.getAttribute('uv');
    const attrGlobal = earthSurface.geometry.getAttribute('_globalUV');
    if (attrUv && attrGlobal) {
      earthSurface.geometry.setAttribute('uv', attrGlobal);
      earthSurface.geometry.setAttribute('_globalUV', attrUv);
    }
    earthHeatmapUVActive = false;
  }
  for (const tile of earthTiles) applyTileRenderMode(tile);
}

// Shared normalization ceiling for both heatmap modes so colors are
// directly comparable.  Uses the pixel-aware cap (not the safety ceiling)
// so the full blue→red range maps to actually reachable values.
function getHeatmapNormMax() {
  return 1 << PIXEL_MAX_DEPTH;
}

// Renders the current actual depths to the heatmap (not theoretical targets)
function rebuildHeatmapFromActiveDepths() {
  const depths = heatmapLODMode === 'distance' && activeDepths ? activeDepths : bumpDepths;
  if (!depths) return;
  subdivTargets = depths;
  const targets = new Float32Array(depths.length);
  for (let i = 0; i < depths.length; i++) {
    targets[i] = depths[i] > 0 ? (1 << depths[i]) : 0;
  }
  requestHeatmapBuild('bump', targets, getHeatmapNormMax());
}

function rebuildHeatmapForMode() {
  if (heatmapLODMode === 'bump') {
    const targets = computeBumpSubdivTargets();
    if (!targets) return;
    subdivTargets = targets;
    requestHeatmapBuild('bump', subdivTargets, getHeatmapNormMax());
  } else {
    rebuildHeatmapFromActiveDepths();
  }
}

export function setEarthLODHeatmapMode(mode) {
  const enabled = mode === 'bump' || mode === 'distance';
  earthRenderMode = enabled ? 'heatmap' : 'textures';
  earthTexturesEnabled = earthRenderMode === 'textures';
  if (enabled) heatmapLODMode = mode;

  if (enabled) {
    rebuildHeatmapForMode();
  }

  // Swap UV attribute: global UVs for heatmap, tile-local for textures
  if (enabled !== earthHeatmapUVActive) {
    const attrUv = earthSurface.geometry.getAttribute('uv');
    const attrGlobal = earthSurface.geometry.getAttribute('_globalUV');
    if (attrUv && attrGlobal) {
      earthSurface.geometry.setAttribute('uv', attrGlobal);
      earthSurface.geometry.setAttribute('_globalUV', attrUv);
    }
    earthHeatmapUVActive = enabled;
  }

  for (const tile of earthTiles) {
    applyTileRenderMode(tile);
  }
}

export function setDistanceLODEnabled(enabled) {
  distanceLODEnabled = enabled;
  activeDepths = null;
  if (!enabled) {
    const lodIndex = EARTH_TEXTURE_LOD_LEVELS.length - 1;
    const lod = EARTH_TEXTURE_LOD_LEVELS[lodIndex];
    const opts = getAdaptiveBumpParamsForLOD(lod);
    opts.threshold = 1 / 255;
    requestAdaptiveGeometryLOD(lodIndex, null, opts);
  }
  for (const tile of earthTiles) applyTileRenderMode(tile);
}

function isBumpSmoothingEnabled() {
  try { return localStorage.getItem('unbound.bumpSmoothing') !== '0'; } catch { return true; }
}

export function setTextureLODEnabled(enabled) {
  if (textureLODEnabled === enabled) return;
  textureLODEnabled = enabled;
  // Reload all visible tiles at the correct LOD for the new setting
  for (const tile of earthTiles) {
    if (!tile.visible) continue;
    const lodIndex = textureLODEnabled
      ? resolveTileLODIndex(tile.distance)
      : EARTH_TEXTURE_LOD_LEVELS.length - 1;
    requestTileLOD(tile, lodIndex);
  }
}

export function setEarthShadowsEnabled(enabled) {
  earthShadowsEnabledUniform.value = enabled ? 1 : 0;
  earthSurface.receiveShadow = enabled;
  for (const material of earthSurfaceMaterials) {
    material.needsUpdate = true;
  }
}

export function preloadAllTileTexturesAsync(onProgress) {
  const maxLOD = EARTH_TEXTURE_LOD_LEVELS.length - 1;
  const total = earthTiles.length;
  let remaining = total;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  function onTileDone() {
    remaining--;
    onProgress?.(total - remaining, total);
    if (remaining <= 0) resolve();
  }
  for (const tile of earthTiles) {
    requestTileLOD(tile, maxLOD, onTileDone);
  }
  return promise;
}

export function disposeEarthRuntime() {
  earthDisposed = true;
  geometryRequestId += 1;
  dynamicDepthRequestId += 1;
  geometryWorker.terminate();
  heatmapWorker.terminate();
  heatmapRequestId += 1;
  tileLoadQueue.length = 0;
  elevationRanges = null;
  bumpDepths = null;
  activeDepths = null;
  pendingDynamicDepths = null;
  subdivTargets = null;
  _cellNormals = null;
  for (const tile of earthTiles) {
    tile.requestToken += 1;
    tile.material.map = null;
    tile.material.emissiveMap = null;
    disposeTileTextures(tile);
  }
  earthPreviewTex.dispose();
  if (earthCellHeatmapTex) {
    earthCellHeatmapTex.dispose();
    earthCellHeatmapTex = null;
  }
}

// Tile textures are loaded on-demand by updateEarthTextureLOD at the
// correct LOD for their distance — no placeholder preload.

// Kick off the initial bump-geometry build immediately so the worker
// can start downloading the bump image in parallel with the tile textures.
// Called from main.js after setEarthLODMode finalizes the mode.

export function preloadInitialBumpGeometry() {
  const lodIndex = EARTH_TEXTURE_LOD_LEVELS.length - 1;
  const lod = EARTH_TEXTURE_LOD_LEVELS[lodIndex];
  const opts = getAdaptiveBumpParamsForLOD(lod);
  opts.threshold = 1 / 255;
  if (distanceLODEnabled) {
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const combinedDepths = computePerCellCombinedDepths(camPos);
    if (combinedDepths) {
      requestAdaptiveGeometryLOD(lodIndex, combinedDepths, opts);
      return;
    }
  }
  requestAdaptiveGeometryLOD(lodIndex, null, opts);
}

export function queryBumpHeight(lat, lon) {
  return new Promise((resolve) => {
    const id = ++_sampleRequestId;
    _sampleResolvers.set(id, (h) => resolve(h * BUMP_DISPLACEMENT_SCALE));
    geometryWorker.postMessage({ id, url: null, radius: EARTH_R, opts: { sample: true, lat, lon, smooth: isBumpSmoothingEnabled() } });
  });
}
