// Off-thread adaptive Earth geometry builder — per-cell streaming version.
//
// Caches the bump map across rebuilds. Builds geometry cell-by-cell and keeps
// cached cell meshes in a compact local-space representation so incremental
// rebuilds do not hold full world-space Float32 geometry for every cell.
//
// Protocol:
//   phase 0 — depths & elevation ranges (small, sent first)
//   phase 1 — progress: one per ~1000 cells processed
//   phase 2 — final: assembled positions, uvs, indices, groups, normals, globalUVs
//
let cachedBumpData = null;
let cachedBumpWidth = 0;
let cachedBumpHeight = 0;
let cachedUrl = null;
let cachedSmoothedBumpData = null;

// Per-cell geometry cache for incremental rebuilds
let cachedAllCells = [];
let cachedSmoothedDepths = null;
let cachedOpts = null;
let cachedBumpUrl = null;
let currentRequestId = 0;

// Worker-side LOD depth computation — moved here from main thread
let workerBumpDepths = null;
let workerActiveDepths = null;
let workerCellNormals = null;
let workerConfig = null;
let workerLastRebuildTime = 0;
let workerPendingCamera = null;
let workerCameraProcessTimer = null;
let _assembleExtraFields = null;
let workerCurrentLodIndex = -1;
const REBUILD_COOLDOWN_MS = 150;

const BUMP_CACHE = 'earth-bump-v1';
const CELL_COORD_SCALE = 32767;
const UV_COORD_SCALE = 32767;

async function fetchCached(url) {
  try {
    const cache = await caches.open(BUMP_CACHE);
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      cache.put(url, res.clone());
    }
    return res;
  } catch {
    return fetch(url);
  }
}

// Light separable box blur — just enough to suppress sampling noise in the
// source bump map.  Real cell-boundary smoothing happens via normal smoothing
// and the depth threshold, not by blurring elevation data.
const BUMP_BLUR_RADIUS = 3;

function smoothBumpData(data, w, h) {
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(data.length);
  const R = BUMP_BLUR_RADIUS;

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    let sum = 0, count = 0;
    for (let x = 0; x < R && x < w; x++) {
      sum += data[rowStart + x] / 255;
      count++;
    }
    for (let x = 0; x < w; x++) {
      const addX = x + R;
      if (addX < w) { sum += data[rowStart + addX] / 255; count++; }
      const remX = x - R - 1;
      if (remX >= 0) { sum -= data[rowStart + remX] / 255; count--; }
      tmp[rowStart + x] = sum / Math.max(1, count);
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let y = 0; y < R && y < h; y++) {
      sum += tmp[y * w + x];
      count++;
    }
    for (let y = 0; y < h; y++) {
      const addY = y + R;
      if (addY < h) { sum += tmp[addY * w + x]; count++; }
      const remY = y - R - 1;
      if (remY >= 0) { sum -= tmp[remY * w + x]; count--; }
      out[y * w + x] = Math.round(Math.max(0, Math.min(1, sum / Math.max(1, count))) * 255);
    }
  }
  return out;
}

// ── Worker-side LOD helpers ──────────────────────────────────────────

function computeBumpDepthsInWorker(ranges, baseLon, baseLat, pixelMaxDepth) {
  const depths = new Uint8Array(baseLon * baseLat);
  for (let i = 0; i < depths.length; i++) {
    const range = ranges[i];
    if (range <= 1) {
      depths[i] = 0;
    } else {
      depths[i] = Math.min(pixelMaxDepth, Math.ceil(Math.log2(range)) + 1);
    }
  }
  return depths;
}

function ensureWorkerCellNormals(baseLon, baseLat) {
  if (workerCellNormals && workerCellNormals.length === baseLon * baseLat * 3) return;
  workerCellNormals = new Float32Array(baseLon * baseLat * 3);
  for (let i = 0; i < baseLon; i++) {
    const phi = ((i + 0.5) / baseLon) * 2 * Math.PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    for (let j = 0; j < baseLat; j++) {
      const theta = ((j + 0.5) / baseLat) * Math.PI;
      const sinTheta = Math.sin(theta);
      const idx = (i * baseLat + j) * 3;
      workerCellNormals[idx] = -cosPhi * sinTheta;
      workerCellNormals[idx + 1] = Math.cos(theta);
      workerCellNormals[idx + 2] = sinPhi * sinTheta;
    }
  }
}

function computeWorkerCombinedDepths(cam) {
  if (!workerBumpDepths || !workerCellNormals || !workerConfig) return null;

  const { earthR, earthPosX, earthPosY, earthPosZ, pixelMaxDepth, lodAggression } = workerConfig;
  const { camX, camY, camZ, earthRotY, lodDistanceMode } = cam;
  const baseLon = workerConfig.baseLon;
  const baseLat = workerConfig.baseLat;
  const size = baseLon * baseLat;
  const combined = new Uint8Array(size);

  const cosRY = Math.cos(earthRotY);
  const sinRY = Math.sin(earthRotY);

  if (lodDistanceMode) {
    const maxDist = earthR * Math.PI;
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const idx = i * baseLat + j;
        const bd = workerBumpDepths[idx];
        if (bd === 0) continue;
        const n3 = idx * 3;
        const clx = workerCellNormals[n3] * earthR;
        const cly = workerCellNormals[n3 + 1] * earthR;
        const clz = workerCellNormals[n3 + 2] * earthR;
        const cwx = clx * cosRY + clz * sinRY + earthPosX;
        const cwy = cly + earthPosY;
        const cwz = -clx * sinRY + clz * cosRY + earthPosZ;
        const dx = cwx - camX;
        const dy = cwy - camY;
        const dz = cwz - camZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > maxDist) continue;
        const t = dist / maxDist;
        const distDepth = Math.max(0, Math.round(pixelMaxDepth * (1 - Math.pow(t, 1 / lodAggression))));
        combined[idx] = Math.min(bd, distDepth);
      }
    }
  } else {
    const camToCenter = Math.sqrt(
      (camX - earthPosX) ** 2 + (camY - earthPosY) ** 2 + (camZ - earthPosZ) ** 2,
    );
    const h = camToCenter - earthR;
    const camDirWX = (camX - earthPosX) / camToCenter;
    const camDirWY = (camY - earthPosY) / camToCenter;
    const camDirWZ = (camZ - earthPosZ) / camToCenter;
    const camDirLX = camDirWX * cosRY - camDirWZ * sinRY;
    const camDirLY = camDirWY;
    const camDirLZ = camDirWX * sinRY + camDirWZ * cosRY;
    const cosThetaMax = earthR / (earthR + h);
    const cosThetaRange = 1 - cosThetaMax;

    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const idx = i * baseLat + j;
        const bd = workerBumpDepths[idx];
        if (bd === 0) continue;
        const n3 = idx * 3;
        const cosTheta = workerCellNormals[n3] * camDirLX
                       + workerCellNormals[n3 + 1] * camDirLY
                       + workerCellNormals[n3 + 2] * camDirLZ;
        if (cosTheta < cosThetaMax) continue;
        const t = (1 - cosTheta) / cosThetaRange;
        const distDepth = Math.max(0, Math.round(pixelMaxDepth * (1 - Math.pow(t, 1 / lodAggression))));
        combined[idx] = Math.min(bd, distDepth);
      }
    }
  }

  return combined;
}

function maybeProcessCamera() {
  if (workerCameraProcessTimer !== null) return;
  const now = performance.now();
  const elapsed = now - workerLastRebuildTime;
  if (elapsed >= REBUILD_COOLDOWN_MS) {
    doProcessCamera();
  } else {
    workerCameraProcessTimer = setTimeout(() => {
      workerCameraProcessTimer = null;
      doProcessCamera();
    }, REBUILD_COOLDOWN_MS - elapsed);
  }
}

function doProcessCamera() {
  if (!workerPendingCamera) return;
  if (!workerBumpDepths || !cachedOpts || cachedAllCells.length === 0) return;
  if (!workerConfig || !workerConfig.distanceLODEnabled) return;

  const cam = workerPendingCamera;
  workerPendingCamera = null;

  const combined = computeWorkerCombinedDepths(cam);
  if (!combined) return;

  const dirtyCells = [];
  if (workerActiveDepths && workerActiveDepths.length === combined.length) {
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== workerActiveDepths[i]) dirtyCells.push(i);
    }
    if (dirtyCells.length === 0) return;
  } else {
    for (let i = 0; i < combined.length; i++) dirtyCells.push(i);
  }

  workerLastRebuildTime = performance.now();
  workerActiveDepths = new Uint8Array(combined);

  const id = ++currentRequestId;
  const bumpData = cachedOpts.smooth ? cachedSmoothedBumpData : cachedBumpData;
  const opts = { ...cachedOpts, depths: combined };

  _assembleExtraFields = {
    cameraTriggered: true,
    activeDepths: new Uint8Array(combined),
    lodIndex: workerCurrentLodIndex,
  };

  if (cachedSmoothedDepths) {
    rebuildIncremental(id, workerConfig.earthR, bumpData, cachedBumpWidth, cachedBumpHeight, opts, dirtyCells);
  } else {
    buildAdaptiveStreaming(id, workerConfig.earthR, bumpData, cachedBumpWidth, cachedBumpHeight, opts);
  }

  _assembleExtraFields = null;
}

// ── Message handler ─────────────────────────────────────────────────

self.onmessage = async (e) => {
  if (e.data.type === 'cameraUpdate') {
    workerPendingCamera = e.data;
    maybeProcessCamera();
    return;
  }
  if (e.data.type === 'configUpdate') {
    if (!workerConfig) workerConfig = {};
    Object.assign(workerConfig, e.data.config);
    if (e.data.resetActiveDepths) workerActiveDepths = null;
    return;
  }

  const { id, url, radius, opts, lodIndex } = e.data;
  if (lodIndex !== undefined) workerCurrentLodIndex = lodIndex;
  try {
    if (url && url !== cachedUrl) {
      const res = await fetchCached(url);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const channel = new Uint8Array(canvas.width * canvas.height);
      for (let i = 0; i < channel.length; i++) {
        channel[i] = imgData.data[i * 4];
      }
      cachedBumpData = channel;
      cachedBumpWidth = canvas.width;
      cachedBumpHeight = canvas.height;
      cachedUrl = url;
      // Bump data changed — invalidate cell cache
      cachedAllCells = [];
      cachedSmoothedDepths = null;
      cachedSmoothedBumpData = null;
      cachedOpts = null;
      cachedBumpUrl = null;
    }
    currentRequestId = id;
    if (!cachedBumpData) {
      self.postMessage({ id, phase: -1, error: 'No bump data loaded' });
      return;
    }

    let bumpData;
    if (opts.smooth) {
      if (!cachedSmoothedBumpData) {
        cachedSmoothedBumpData = smoothBumpData(cachedBumpData, cachedBumpWidth, cachedBumpHeight);
      }
      bumpData = cachedSmoothedBumpData;
    } else {
      bumpData = cachedBumpData;
    }

    if (opts.uniform) {
      buildUniformStreaming(id, radius, bumpData, cachedBumpWidth, cachedBumpHeight, opts);
    } else if (opts.sample) {
      const { lat, lon } = opts;
      const u = (lon + 180) / 360;
      const v = (90 - lat) / 180;
      const px = Math.min(cachedBumpWidth - 1, Math.max(0, Math.floor(u * cachedBumpWidth)));
      const py = Math.min(cachedBumpHeight - 1, Math.max(0, Math.floor(v * cachedBumpHeight)));
      const h = bumpData[py * cachedBumpWidth + px] / 255;
      self.postMessage({ id, phase: 3, height: h });
      return;
    } else if (e.data.incremental && cachedAllCells.length > 0
               && cachedBumpUrl === url
               && optsMatchForIncremental(opts)) {
      rebuildIncremental(id, radius, bumpData, cachedBumpWidth, cachedBumpHeight, opts, e.data.dirtyCells);
    } else {
      buildAdaptiveStreaming(id, radius, bumpData, cachedBumpWidth, cachedBumpHeight, opts);
    }
  } catch (err) {
    self.postMessage({ id, phase: -1, error: err.message });
  }
};

// ── Uniform (non-adaptive) path — rarely used, kept for completeness ──
function buildUniformStreaming(id, radius, bumpData, bw, bh, opts) {
  const { segsLon, segsLat, displacementScale: dispScale, tileRows, tileCols } = opts;

  function sampleBump(u, v) {
    const uu = ((u % 1) + 1) % 1;
    const vv = v < 0 ? 0 : v > 1 ? 1 : v;
    const px = Math.min(bw - 1, Math.floor(uu * bw));
    const py = Math.min(bh - 1, Math.floor(vv * bh));
    return bumpData[py * bw + px] / 255;
  }

  const positions = [];
  const uvs = [];

  function addVertex(u, v) {
    const phi = u * 2 * Math.PI;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    let x = -radius * Math.cos(phi) * sinTheta;
    let y = radius * Math.cos(theta);
    let z = radius * Math.sin(phi) * sinTheta;
    const h = sampleBump(u, v);
    const disp = h * dispScale;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-6) { const f = disp / len; x += x * f; y += y * f; z += z * f; }
    const vidx = positions.length / 3;
    positions.push(x, y, z);
    uvs.push(u, v);
    return vidx;
  }

  const indicesByMaterial = Array.from({ length: tileRows * tileCols }, () => []);
  function materialIndexForUV(u, v) {
    const col = Math.min(tileCols - 1, Math.max(0, Math.floor(u * tileCols)));
    const row = Math.min(tileRows - 1, Math.max(0, Math.floor(v * tileRows)));
    return row * tileCols + col;
  }

  const w = segsLon + 1;
  for (let j = 0; j <= segsLat; j++)
    for (let i = 0; i <= segsLon; i++)
      addVertex(i / segsLon, j / segsLat);

  for (let j = 0; j < segsLat; j++) {
    for (let i = 0; i < segsLon; i++) {
      const TL = j * w + i, TR = j * w + (i + 1);
      const BL = (j + 1) * w + i, BR = (j + 1) * w + (i + 1);
      const mi = materialIndexForUV((i + 0.5) / segsLon, (j + 0.5) / segsLat);
      indicesByMaterial[mi].push(TR, TL, BR, TL, BL, BR);
    }
  }

  const flatIndices = [];
  const groupDefs = [];
  for (let mi = 0; mi < indicesByMaterial.length; mi++) {
    const grp = indicesByMaterial[mi];
    if (grp.length === 0) continue;
    const start = flatIndices.length;
    for (const idx of grp) flatIndices.push(idx);
    groupDefs.push(start, grp.length, mi);
  }

  sendRow(id, {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(flatIndices),
    groupRuns: new Int32Array(groupDefs),
    cellTriCounts: new Uint32Array(segsLon * segsLat),
  });
  self.postMessage({ id, phase: 2, totalVertices: positions.length / 3 });
}

function buildCellFrame(u0, u1, v0, v1, radius) {
  const centerU = (u0 + u1) * 0.5;
  const centerV = (v0 + v1) * 0.5;
  const phi = centerU * 2 * Math.PI;
  const theta = centerV * Math.PI;
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  const originX = -radius * cosPhi * sinTheta;
  const originY = radius * cosTheta;
  const originZ = radius * sinPhi * sinTheta;

  const axisXx = sinPhi;
  const axisXy = 0;
  const axisXz = cosPhi;

  const axisYx = -cosPhi * sinTheta;
  const axisYy = cosTheta;
  const axisYz = sinPhi * sinTheta;

  const axisZx = axisYy * axisXz - axisYz * axisXy;
  const axisZy = axisYz * axisXx - axisYx * axisXz;
  const axisZz = axisYx * axisXy - axisYy * axisXx;

  return {
    originX, originY, originZ,
    axisXx, axisXy, axisXz,
    axisYx, axisYy, axisYz,
    axisZx, axisZy, axisZz,
  };
}

function compactCellGeometry(positions, uvs, indices, matIdx, u0, u1, v0, v1, radius) {
  const frame = buildCellFrame(u0, u1, v0, v1, radius);
  const vertCount = positions.length / 3;
  const local = new Float32Array(positions.length);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertCount; i++) {
    const p3 = i * 3;
    const dx = positions[p3] - frame.originX;
    const dy = positions[p3 + 1] - frame.originY;
    const dz = positions[p3 + 2] - frame.originZ;

    const lx = dx * frame.axisXx + dy * frame.axisXy + dz * frame.axisXz;
    const ly = dx * frame.axisYx + dy * frame.axisYy + dz * frame.axisYz;
    const lz = dx * frame.axisZx + dy * frame.axisZy + dz * frame.axisZz;

    local[p3] = lx;
    local[p3 + 1] = ly;
    local[p3 + 2] = lz;

    if (lx < minX) minX = lx;
    if (ly < minY) minY = ly;
    if (lz < minZ) minZ = lz;
    if (lx > maxX) maxX = lx;
    if (ly > maxY) maxY = ly;
    if (lz > maxZ) maxZ = lz;
  }

  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const midZ = (minZ + maxZ) * 0.5;
  const scaleX = (maxX - minX) * 0.5;
  const scaleY = (maxY - minY) * 0.5;
  const scaleZ = (maxZ - minZ) * 0.5;

  const origin = new Float32Array([
    frame.originX + frame.axisXx * midX + frame.axisYx * midY + frame.axisZx * midZ,
    frame.originY + frame.axisXy * midX + frame.axisYy * midY + frame.axisZy * midZ,
    frame.originZ + frame.axisXz * midX + frame.axisYz * midY + frame.axisZz * midZ,
  ]);

  const basis = new Float32Array([
    frame.axisXx, frame.axisXy, frame.axisXz,
    frame.axisYx, frame.axisYy, frame.axisYz,
    frame.axisZx, frame.axisZy, frame.axisZz,
  ]);
  const scale = new Float32Array([scaleX, scaleY, scaleZ]);
  const posQ = new Int16Array(positions.length);
  const uvQ = new Int16Array(uvs.length);

  for (let i = 0; i < vertCount; i++) {
    const p3 = i * 3;
    const qx = scaleX > 1e-9 ? (local[p3] - midX) / scaleX : 0;
    const qy = scaleY > 1e-9 ? (local[p3 + 1] - midY) / scaleY : 0;
    const qz = scaleZ > 1e-9 ? (local[p3 + 2] - midZ) / scaleZ : 0;

    posQ[p3] = Math.max(-CELL_COORD_SCALE, Math.min(CELL_COORD_SCALE, Math.round(qx * CELL_COORD_SCALE)));
    posQ[p3 + 1] = Math.max(-CELL_COORD_SCALE, Math.min(CELL_COORD_SCALE, Math.round(qy * CELL_COORD_SCALE)));
    posQ[p3 + 2] = Math.max(-CELL_COORD_SCALE, Math.min(CELL_COORD_SCALE, Math.round(qz * CELL_COORD_SCALE)));

    const u2 = i * 2;
    uvQ[u2] = Math.max(0, Math.min(UV_COORD_SCALE, Math.round(uvs[u2] * UV_COORD_SCALE)));
    uvQ[u2 + 1] = Math.max(0, Math.min(UV_COORD_SCALE, Math.round(uvs[u2 + 1] * UV_COORD_SCALE)));
  }

  return {
    positions: posQ,
    uvs: uvQ,
    indices: new Uint16Array(indices),
    groupRuns: new Int32Array([0, indices.length, matIdx]),
    origin,
    basis,
    scale,
  };
}

// ── Assembly: expand compact cells, compute normals, send ───────────
function assembleAndSend(id, allCells, tileRows, tileCols) {
  const logStep = (msg) => {
    console.log(`[worker] ${msg}`);
    self.postMessage({ id, phase: 'progress', step: msg });
  };

  let totalVertices = 0;
  let totalIdx = 0;
  let totalGroups = 0;
  for (let i = 0; i < allCells.length; i++) {
    const cell = allCells[i];
    if (!cell) continue;
    totalVertices += cell.positions.length / 3;
    totalIdx += cell.indices.length;
    totalGroups += cell.groupRuns.length / 3;
  }

  logStep(`assembling ${totalVertices.toLocaleString()} verts from ${allCells.length} compact cells...`);
  const positions = new Float32Array(totalVertices * 3);
  const uvs = new Int16Array(totalVertices * 2);
  const globalUVs = new Int16Array(totalVertices * 2);
  const indices = new Uint32Array(totalIdx);
  const groups = new Int32Array(totalGroups * 3);
  let vOff = 0, iOff = 0, gOff = 0;
  for (let i = 0; i < allCells.length; i++) {
    const cell = allCells[i];
    if (!cell) continue;

    const vertCount = cell.positions.length / 3;
    const basis = cell.basis;
    const origin = cell.origin;
    const scale = cell.scale;
    const matIdx = cell.groupRuns[2];
    const row = Math.floor(matIdx / tileCols);
    const col = matIdx % tileCols;

    for (let v = 0; v < vertCount; v++) {
      const src3 = v * 3;
      const dst3 = (vOff + v) * 3;
      const src2 = v * 2;
      const dst2 = (vOff + v) * 2;

      const lx = cell.positions[src3] * (scale[0] / CELL_COORD_SCALE);
      const ly = cell.positions[src3 + 1] * (scale[1] / CELL_COORD_SCALE);
      const lz = cell.positions[src3 + 2] * (scale[2] / CELL_COORD_SCALE);

      positions[dst3] = origin[0] + basis[0] * lx + basis[3] * ly + basis[6] * lz;
      positions[dst3 + 1] = origin[1] + basis[1] * lx + basis[4] * ly + basis[7] * lz;
      positions[dst3 + 2] = origin[2] + basis[2] * lx + basis[5] * ly + basis[8] * lz;

      const uQ = cell.uvs[src2];
      const vQ = cell.uvs[src2 + 1];
      globalUVs[dst2] = uQ;
      globalUVs[dst2 + 1] = vQ;

      const tileU = uQ * tileCols - col * UV_COORD_SCALE;
      const tileV = vQ * tileRows - row * UV_COORD_SCALE;
      uvs[dst2] = tileU < 0 ? 0 : tileU > UV_COORD_SCALE ? UV_COORD_SCALE : tileU;
      uvs[dst2 + 1] = tileV < 0 ? 0 : tileV > UV_COORD_SCALE ? UV_COORD_SCALE : tileV;
    }

    for (let t = 0; t < cell.indices.length; t++) {
      indices[iOff + t] = cell.indices[t] + vOff;
    }

    groups[gOff] = iOff;
    groups[gOff + 1] = cell.indices.length;
    groups[gOff + 2] = matIdx;
    gOff += 3;

    vOff += vertCount;
    iOff += cell.indices.length;
    if ((i + 1) % 10000 === 0) logStep(`  assemble ${i + 1}/${allCells.length} cells (${((i + 1) / allCells.length * 100).toFixed(0)}%)`);
  }
  logStep(`  assembly done — ${(totalIdx / 3).toLocaleString()} total triangles`);

  logStep(`computing normals (${(indices.length / 3).toLocaleString()} tris)...`);
  let normalsF32 = computeVertexNormals(positions, indices);
  logStep(`  normals done (${(positions.length / 3).toLocaleString()} verts)`);

  logStep(`smoothing normals to reduce cell-boundary seams...`);
  normalsF32 = smoothNormals(normalsF32, indices, positions.length / 3);
  logStep(`  normal smoothing done`);

  logStep(`compacting normals to Int8 (${positions.length.toLocaleString()} components)...`);
  const normI8 = new Int8Array(positions.length);
  for (let i = 0; i < normalsF32.length; i++) {
    const t = normalsF32[i] * 127;
    normI8[i] = (t + 0.5 - (t < 0)) | 0;
  }
  logStep(`  normals compacted`);
  normalsF32 = null;

  const finalVerts = positions.length / 3;
  const finalIdx = indices.length;
  console.log(`[worker] assembly complete — ${finalVerts.toLocaleString()} verts, ${(finalIdx / 3).toLocaleString()} tris`);

  const transfer = [
    positions.buffer,
    uvs.buffer,
    indices.buffer,
    groups.buffer,
    normI8.buffer,
    globalUVs.buffer,
  ];

  const msg = {
    id, phase: 2,
    positions, uvs, indices, groups,
    normals: normI8, globalUVs,
    totalVertices: finalVerts,
  };
  if (_assembleExtraFields) Object.assign(msg, _assembleExtraFields);
  self.postMessage(msg, transfer);
}

// ── Adaptive per-cell streaming path ──────────────────────────────────
function buildAdaptiveStreaming(id, radius, bumpData, bw, bh, opts) {
  const {
    baseSegmentsLon: baseLon, baseSegmentsLat: baseLat,
    maxDepth, displacementScale: dispScale,
    tileRows, tileCols,
  } = opts;

  // Phase 0 — depths + elevation ranges
  const elevationRanges = computeElevationRanges(bumpData, bw, bh, baseLon, baseLat);
  // Pixel-aware depth cap: can't subdivide past the source resolution
  const pixelMaxDepth = Math.ceil(Math.log2(bw / baseLon));
  const effectiveMaxDepth = Math.min(maxDepth, pixelMaxDepth);
  console.log(`[worker] pixelMaxDepth = floor(log2(${bw}/${baseLon})) = ${pixelMaxDepth}, effective = ${effectiveMaxDepth}`);

  // Save bump depths for worker-side camera LOD computation
  const elevationRangesCopy = new Uint8Array(elevationRanges);
  workerBumpDepths = computeBumpDepthsInWorker(elevationRangesCopy, baseLon, baseLat, pixelMaxDepth);
  ensureWorkerCellNormals(baseLon, baseLat);
  if (workerConfig) {
    workerConfig.baseLon = baseLon;
    workerConfig.baseLat = baseLat;
    workerConfig.pixelMaxDepth = pixelMaxDepth;
  }

  const depths = computeDepths(elevationRanges, baseLon, baseLat, effectiveMaxDepth, opts);

  self.postMessage({
    id, phase: 0, elevationRanges,
    cellBaseLon: baseLon, cellBaseLat: baseLat,
  }, [elevationRanges.buffer]);

  function getDepth(i, j) {
    if (j < 0 || j >= baseLat) return 0;
    return depths[((i % baseLon + baseLon) % baseLon) * baseLat + j];
  }

  function sampleBump(u, v) {
    const uu = ((u % 1) + 1) % 1;
    const vv = v < 0 ? 0 : v > 1 ? 1 : v;
    const px = Math.min(bw - 1, Math.floor(uu * bw));
    const py = Math.min(bh - 1, Math.floor(vv * bh));
    return bumpData[py * bw + px] / 255;
  }

  // Phase 1 — build cells
  // Hoist closures: each cell reads/writes through these mutable bindings
  let _positions, _uvs, _indices;

  function addVertex(u, v) {
    const phi = u * 2 * Math.PI;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    let x = -radius * Math.cos(phi) * sinTheta;
    let y = radius * Math.cos(theta);
    let z = radius * Math.sin(phi) * sinTheta;
    const h = sampleBump(u, v);
    const disp = h * dispScale;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-6) {
      const f = disp / len;
      x += x * f;
      y += y * f;
      z += z * f;
    }
    const vidx = _positions.length / 3;
    _positions.push(x, y, z);
    _uvs.push(u, v);
    return vidx;
  }

  function pushTriangle(a, b, c) {
    _indices.push(a, b, c);
  }

  const totalCells = baseLon * baseLat;
  const allCells = new Array(totalCells);

  for (let i = 0; i < baseLon; i++) {
    for (let j = 0; j < baseLat; j++) {
      _positions = [];
      _uvs = [];
      _indices = [];

      // Each cell lies in exactly one tile — precompute material index
      const matIdx = Math.floor((j + 0.5) / baseLat * tileRows) * tileCols
                   + Math.floor((i + 0.5) / baseLon * tileCols);

      const cellIdx = i * baseLat + j;
      const d = depths[cellIdx];
      const n = 1 << d;
      const u0 = i / baseLon, u1 = (i + 1) / baseLon;
      const v0 = j / baseLat, v1 = (j + 1) / baseLat;

      const grid = new Uint16Array((n + 1) * (n + 1));
      for (let yi = 0; yi <= n; yi++) {
        const v = v0 + (v1 - v0) * (yi / n);
        for (let xi = 0; xi <= n; xi++) {
          const u = u0 + (u1 - u0) * (xi / n);
          grid[yi * (n + 1) + xi] = addVertex(u, v);
        }
      }

      const dW = getDepth(i - 1, j);
      const dE = getDepth(i + 1, j);
      const dN = getDepth(i, j - 1);
      const dS = getDepth(i, j + 1);

      for (let yi = 0; yi < n; yi++) {
        for (let xi = 0; xi < n; xi++) {
          const TL = grid[yi * (n + 1) + xi];
          const TR = grid[yi * (n + 1) + (xi + 1)];
          const BL = grid[(yi + 1) * (n + 1) + xi];
          const BR = grid[(yi + 1) * (n + 1) + (xi + 1)];

          const finerW = xi === 0     && dW > d;
          const finerE = xi === n - 1 && dE > d;
          const finerN = yi === 0     && dN > d;
          const finerS = yi === n - 1 && dS > d;
          const uL = u0 + (u1 - u0) * (xi / n);
          const uR = u0 + (u1 - u0) * ((xi + 1) / n);
          const uM = u0 + (u1 - u0) * ((xi + 0.5) / n);
          const vT = v0 + (v1 - v0) * (yi / n);
          const vB = v0 + (v1 - v0) * ((yi + 1) / n);
          const vM = v0 + (v1 - v0) * ((yi + 0.5) / n);

          if (!finerW && !finerE && !finerN && !finerS) {
            pushTriangle(TR, TL, BR);
            pushTriangle(TL, BL, BR);
          } else {
            const midW = finerW ? addVertex(uL, vM) : -1;
            const midE = finerE ? addVertex(uR, vM) : -1;
            const midN = finerN ? addVertex(uM, vT) : -1;
            const midS = finerS ? addVertex(uM, vB) : -1;

            const boundary = [TR];
            if (finerN) boundary.push(midN);
            boundary.push(TL);
            if (finerW) boundary.push(midW);
            boundary.push(BL);
            if (finerS) boundary.push(midS);
            boundary.push(BR);
            if (finerE) boundary.push(midE);

            const centre = addVertex(uM, vM);
            for (let k = 0; k < boundary.length; k++) {
              const next = (k + 1) % boundary.length;
              pushTriangle(centre, boundary[k], boundary[next]);
            }
          }
        }
      }

      const triCount = _indices.length / 3;

      allCells[cellIdx] = compactCellGeometry(
        _positions,
        _uvs,
        _indices,
        matIdx,
        u0,
        u1,
        v0,
        v1,
        radius,
      );

      // Progress every 1000 cells
      const cellNum = cellIdx + 1;
      if (cellNum % 1000 === 0 || cellNum === 1 || cellNum === totalCells) {
        console.log(`[worker] cell ${cellNum}/${totalCells} (${(cellNum / totalCells * 100).toFixed(0)}%) — ${(_positions.length / 3).toLocaleString()} verts, ${triCount.toLocaleString()} tris`);
        self.postMessage({ id, phase: 1, cell: cellIdx, totalCells });
      }
    }
  }

  // Populate cache for future incremental rebuilds
  cachedAllCells = allCells.slice();
  cachedSmoothedDepths = new Uint8Array(depths);
  cachedOpts = {
    baseSegmentsLon: opts.baseSegmentsLon,
    baseSegmentsLat: opts.baseSegmentsLat,
    maxDepth: opts.maxDepth,
    tileRows: opts.tileRows,
    tileCols: opts.tileCols,
    displacementScale: opts.displacementScale,
    smooth: opts.smooth,
  };
  cachedBumpUrl = cachedUrl;

  assembleAndSend(id, allCells, tileRows, tileCols);
}

function optsMatchForIncremental(opts) {
  if (!cachedOpts) return false;
  return (
    opts.baseSegmentsLon === cachedOpts.baseSegmentsLon &&
    opts.baseSegmentsLat === cachedOpts.baseSegmentsLat &&
    opts.maxDepth === cachedOpts.maxDepth &&
    opts.tileRows === cachedOpts.tileRows &&
    opts.tileCols === cachedOpts.tileCols &&
    opts.displacementScale === cachedOpts.displacementScale &&
    opts.smooth === cachedOpts.smooth
  );
}

// ── Incremental rebuild — only rebuilds cells whose depth changed.
// Reuses cached cell data for unchanged cells.
function rebuildIncremental(id, radius, bumpData, bw, bh, opts, dirtyCellIndices) {
  const {
    baseSegmentsLon: baseLon, baseSegmentsLat: baseLat,
    maxDepth, displacementScale: dispScale,
    tileRows, tileCols,
  } = opts;

  if (id !== currentRequestId) return;

  // 1. Compute new smoothed depths
  const newDepths = new Uint8Array(opts.depths);
  // Smooth so neighbours differ by at most 1
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const idx = i * baseLat + j;
        const d = newDepths[idx];
        const east  = newDepths[((i + 1) % baseLon) * baseLat + j];
        const west  = newDepths[((i - 1 + baseLon) % baseLon) * baseLat + j];
        const north = j > 0            ? newDepths[i * baseLat + (j - 1)] : 0;
        const south = j < baseLat - 1  ? newDepths[i * baseLat + (j + 1)] : 0;
        const maxN = Math.max(east, west, north, south);
        if (maxN > d + 1) {
          newDepths[idx] = maxN - 1;
          changed = true;
        }
      }
    }
  }

  // 2. Redetermine dirty cells post-smoothing
  const dirtySet = new Set(dirtyCellIndices);
  if (cachedSmoothedDepths && cachedSmoothedDepths.length === newDepths.length) {
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const idx = i * baseLat + j;
        if (newDepths[idx] !== cachedSmoothedDepths[idx]) {
          dirtySet.add(idx);
          // Neighbour cells may need edge fan adjustments
          if (j > 0) dirtySet.add(idx - 1);
          if (j < baseLat - 1) dirtySet.add(idx + 1);
          dirtySet.add(((i - 1 + baseLon) % baseLon) * baseLat + j);
          dirtySet.add(((i + 1) % baseLon) * baseLat + j);
        }
      }
    }
  }

  console.log(`[worker] incremental rebuild: ${dirtySet.size}/${baseLon * baseLat} cells dirty`);

  // 3. Helper functions
  function getDepth(i, j) {
    if (j < 0 || j >= baseLat) return 0;
    return newDepths[((i % baseLon + baseLon) % baseLon) * baseLat + j];
  }

  function sampleBump(u, v) {
    const uu = ((u % 1) + 1) % 1;
    const vv = v < 0 ? 0 : v > 1 ? 1 : v;
    const px = Math.min(bw - 1, Math.floor(uu * bw));
    const py = Math.min(bh - 1, Math.floor(vv * bh));
    return bumpData[py * bw + px] / 255;
  }

  // Hoist closures — each cell writes through these mutable bindings
  let _positions, _uvs, _indices;

  function addVertex(u, v) {
    const phi = u * 2 * Math.PI;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    let x = -radius * Math.cos(phi) * sinTheta;
    let y = radius * Math.cos(theta);
    let z = radius * Math.sin(phi) * sinTheta;
    const h = sampleBump(u, v);
    const disp = h * dispScale;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-6) { const f = disp / len; x += x * f; y += y * f; z += z * f; }
    const vi = _positions.length / 3;
    _positions.push(x, y, z);
    _uvs.push(u, v);
    return vi;
  }

  function pushTriangle(a, b, c) {
    _indices.push(a, b, c);
  }

  // 4. Rebuild dirty cells
  let rebuiltCount = 0;
  for (const cellIdx of dirtySet) {
    if (id !== currentRequestId) return; // abort on new request

    const i = Math.floor(cellIdx / baseLat);
    const j = cellIdx % baseLat;

    _positions = [];
    _uvs = [];
    _indices = [];

    // Each cell lies in exactly one tile
    const matIdx = Math.floor((j + 0.5) / baseLat * tileRows) * tileCols
                 + Math.floor((i + 0.5) / baseLon * tileCols);

    const d = newDepths[cellIdx];
    const n = 1 << d;
    const u0 = i / baseLon, u1 = (i + 1) / baseLon;
    const v0 = j / baseLat, v1 = (j + 1) / baseLat;

    const grid = new Uint16Array((n + 1) * (n + 1));
    for (let yi = 0; yi <= n; yi++) {
      const v = v0 + (v1 - v0) * (yi / n);
      for (let xi = 0; xi <= n; xi++) {
        const u = u0 + (u1 - u0) * (xi / n);
        grid[yi * (n + 1) + xi] = addVertex(u, v);
      }
    }

    const dW = getDepth(i - 1, j);
    const dE = getDepth(i + 1, j);
    const dN = getDepth(i, j - 1);
    const dS = getDepth(i, j + 1);

    for (let yi = 0; yi < n; yi++) {
      for (let xi = 0; xi < n; xi++) {
        const TL = grid[yi * (n + 1) + xi];
        const TR = grid[yi * (n + 1) + (xi + 1)];
        const BL = grid[(yi + 1) * (n + 1) + xi];
        const BR = grid[(yi + 1) * (n + 1) + (xi + 1)];

        const finerW = xi === 0     && dW > d;
        const finerE = xi === n - 1 && dE > d;
        const finerN = yi === 0     && dN > d;
        const finerS = yi === n - 1 && dS > d;

        if (!finerW && !finerE && !finerN && !finerS) {
          pushTriangle(TR, TL, BR);
          pushTriangle(TL, BL, BR);
        } else {
          const uL = u0 + (u1 - u0) * (xi / n);
          const uR = u0 + (u1 - u0) * ((xi + 1) / n);
          const uM = u0 + (u1 - u0) * ((xi + 0.5) / n);
          const vT = v0 + (v1 - v0) * (yi / n);
          const vB = v0 + (v1 - v0) * ((yi + 1) / n);
          const vM = v0 + (v1 - v0) * ((yi + 0.5) / n);

          const midW = finerW ? addVertex(uL, vM) : -1;
          const midE = finerE ? addVertex(uR, vM) : -1;
          const midN = finerN ? addVertex(uM, vT) : -1;
          const midS = finerS ? addVertex(uM, vB) : -1;

          const boundary = [TR];
          if (finerN) boundary.push(midN);
          boundary.push(TL);
          if (finerW) boundary.push(midW);
          boundary.push(BL);
          if (finerS) boundary.push(midS);
          boundary.push(BR);
          if (finerE) boundary.push(midE);

          const centre = addVertex(uM, vM);
          for (let k = 0; k < boundary.length; k++) {
            const next = (k + 1) % boundary.length;
            pushTriangle(centre, boundary[k], boundary[next]);
          }
        }
      }
    }

    cachedAllCells[cellIdx] = compactCellGeometry(
      _positions,
      _uvs,
      _indices,
      matIdx,
      u0,
      u1,
      v0,
      v1,
      radius,
    );

    rebuiltCount++;
    if (rebuiltCount % 100 === 0 || rebuiltCount === dirtySet.size) {
      self.postMessage({ id, phase: 1, cell: cellIdx, totalCells: baseLon * baseLat });
    }
  }

  // 5. Assemble and send
  cachedSmoothedDepths = newDepths;
  assembleAndSend(id, cachedAllCells, tileRows, tileCols);
}

// ── Helpers ─────────────────────────────────────────────────────────
function sendRow(id, data) {
  const transfer = [data.positions.buffer, data.uvs.buffer, data.indices.buffer, data.groupRuns.buffer, data.cellTriCounts.buffer];
  self.postMessage({ id, phase: 1, row: 0, totalRows: 1, ...data }, transfer);
}

function computeVertexNormals(positions, indices) {
  const vertCount = positions.length / 3;
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[b]     - positions[a];
    const ay = positions[b + 1] - positions[a + 1];
    const az = positions[b + 2] - positions[a + 2];
    const bx = positions[c]     - positions[a];
    const by = positions[c + 1] - positions[a + 1];
    const bz = positions[c + 2] - positions[a + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    normals[a]     += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b]     += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c]     += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }

  for (let i = 0; i < vertCount; i++) {
    const off = i * 3;
    const x = normals[off], y = normals[off + 1], z = normals[off + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-8) {
      const inv = 1 / len;
      normals[off]     = x * inv;
      normals[off + 1] = y * inv;
      normals[off + 2] = z * inv;
    }
  }
  return normals;
}

// Edge-iteration normal smoothing — reduces visible seams at cell boundaries
// without building an adjacency structure.  For each triangle edge, both
// endpoints accumulate each other's normal; after all edges each vertex
// blends toward the average of its neighbours.  Two iterations at low
// strength smooth boundaries while preserving surface detail.
function smoothNormals(normals, indices, vertCount, iterations = 2, strength = 0.25) {
  // Triangle appearances per vertex (degree)
  const deg = new Uint16Array(vertCount);
  for (let i = 0; i < indices.length; i++) {
    deg[indices[i]]++;
  }

  const scratch = new Float32Array(normals.length);

  for (let iter = 0; iter < iterations; iter++) {
    scratch.fill(0);

    // Accumulate neighbour normals by iterating triangle edges
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const a3 = a * 3, b3 = b * 3, c3 = c * 3;

      // Edge a-b
      scratch[a3]   += normals[b3];   scratch[a3+1] += normals[b3+1];   scratch[a3+2] += normals[b3+2];
      scratch[b3]   += normals[a3];   scratch[b3+1] += normals[a3+1];   scratch[b3+2] += normals[a3+2];
      // Edge b-c
      scratch[b3]   += normals[c3];   scratch[b3+1] += normals[c3+1];   scratch[b3+2] += normals[c3+2];
      scratch[c3]   += normals[b3];   scratch[c3+1] += normals[b3+1];   scratch[c3+2] += normals[b3+2];
      // Edge c-a
      scratch[c3]   += normals[a3];   scratch[c3+1] += normals[a3+1];   scratch[c3+2] += normals[a3+2];
      scratch[a3]   += normals[c3];   scratch[a3+1] += normals[c3+1];   scratch[a3+2] += normals[c3+2];
    }

    // Blend each vertex toward its neighbour average, re-normalize
    for (let v = 0; v < vertCount; v++) {
      const v3 = v * 3;
      const d = deg[v] * 2; // each triangle appearance adds 2 neighbour normals
      if (d === 0) { scratch[v3] = normals[v3]; scratch[v3+1] = normals[v3+1]; scratch[v3+2] = normals[v3+2]; continue; }

      const invD = 1 / d;
      let ax = scratch[v3] * invD, ay = scratch[v3+1] * invD, az = scratch[v3+2] * invD;
      const alen = Math.sqrt(ax * ax + ay * ay + az * az);
      if (alen > 1e-8) { ax /= alen; ay /= alen; az /= alen; }

      scratch[v3]     = normals[v3]     + (ax - normals[v3])     * strength;
      scratch[v3+1]   = normals[v3+1]   + (ay - normals[v3+1])   * strength;
      scratch[v3+2]   = normals[v3+2]   + (az - normals[v3+2])   * strength;

      const slen = Math.sqrt(scratch[v3] ** 2 + scratch[v3+1] ** 2 + scratch[v3+2] ** 2);
      if (slen > 1e-8) { scratch[v3] /= slen; scratch[v3+1] /= slen; scratch[v3+2] /= slen; }
    }

    if (iter < iterations - 1) normals.set(scratch);
  }
  return scratch;
}

function computeDepths(elevationRanges, baseLon, baseLat, maxDepth, opts) {
  let depths;
  if (opts.depths) {
    depths = new Uint8Array(opts.depths);
  } else {
    const threshold = opts.threshold ?? 0.05;
    const thresholdByte = Math.max(1, Math.min(255, Math.round(threshold * 255)));
    depths = new Uint8Array(baseLon * baseLat);
    const depthCounts = new Int32Array(maxDepth + 1);
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const rangeByte = elevationRanges[i * baseLat + j];
        let d;
        if (rangeByte <= thresholdByte) {
          d = 0;
        } else {
          d = Math.min(maxDepth, Math.ceil(Math.log2(rangeByte / thresholdByte)) + 1);
        }
        depths[i * baseLat + j] = d;
        depthCounts[d]++;
      }
      if ((i + 1) % 50 === 0) {
        console.log(`[worker] depth compute: ${i + 1}/${baseLon} rows (${((i + 1) / baseLon * 100).toFixed(0)}%) — ${Array.from(depthCounts, (c, d) => `d${d}=${c}`).join(' ')}`);
      }
    }
    console.log(`[worker] depths done: ${baseLon * baseLat} cells — ${Array.from(depthCounts, (c, d) => `d${d}=${c}`).join(' ')}`);
  }
  // ── Smooth depths so neighbours differ by at most 1 ──
  // Prevents expensive fan-triangle boundaries between extreme depth differences
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const idx = i * baseLat + j;
        const d = depths[idx];
        const east  = depths[((i + 1) % baseLon) * baseLat + j];
        const west  = depths[((i - 1 + baseLon) % baseLon) * baseLat + j];
        const north = j > 0            ? depths[i * baseLat + (j - 1)] : 0;
        const south = j < baseLat - 1  ? depths[i * baseLat + (j + 1)] : 0;
        const maxN = Math.max(east, west, north, south);
        if (maxN > d + 1) {
          depths[idx] = maxN - 1;
          changed = true;
        }
      }
    }
  }

  return depths;
}

function computeElevationRanges(bumpData, bw, bh, baseLon, baseLat) {
  const ranges = new Uint8Array(baseLon * baseLat);
  for (let i = 0; i < baseLon; i++) {
    for (let j = 0; j < baseLat; j++) {
      const px0 = Math.floor(i / baseLon * bw);
      const px1 = Math.min(bw - 1, Math.ceil((i + 1) / baseLon * bw));
      const py0 = Math.floor(j / baseLat * bh);
      const py1 = Math.min(bh - 1, Math.ceil((j + 1) / baseLat * bh));
      let mn = 255, mx = 0;
      for (let py = py0; py <= py1; py++) {
        const rowOff = py * bw;
        for (let px = px0; px <= px1; px++) {
          const h = bumpData[rowOff + px];
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
      }
      ranges[i * baseLat + j] = mx - mn;
    }
  }
  return ranges;
}
