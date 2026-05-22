// Off-thread adaptive Earth geometry builder — streaming version.
//
// Caches the bump map across rebuilds.  Builds geometry row-by-row and
// streams partial results to the main thread so each row can be rendered
// as it arrives instead of waiting for the full mesh.
//
// Protocol:
//   phase 0 — depths & elevation ranges (small, sent first)
//   phase 1 — one per row: positions, global UVs, indices, groups, tri counts
//   phase 2 — final: total vertex / index counts
//
// The main thread is responsible for tile-local re-indexing and normal
// computation after all rows arrive.

let cachedBumpData = null;
let cachedBumpWidth = 0;
let cachedBumpHeight = 0;
let cachedUrl = null;

const BUMP_CACHE = 'earth-bump-v1';

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

// Separable box blur — smooths sudden elevation peaks while preserving
// the overall terrain shape.  Two-pass O(n) implementation.
function smoothBumpData(data, w, h) {
  const radius = 4;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(data.length);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    let sum = 0, count = 0;
    // Prime the window
    for (let x = 0; x < radius && x < w; x++) {
      sum += data[(rowStart + x) * 4] / 255;
      count++;
    }
    for (let x = 0; x < w; x++) {
      const addX = x + radius;
      if (addX < w) {
        sum += data[(rowStart + addX) * 4] / 255;
        count++;
      }
      const remX = x - radius - 1;
      if (remX >= 0) {
        sum -= data[(rowStart + remX) * 4] / 255;
        count--;
      }
      tmp[rowStart + x] = sum / Math.max(1, count);
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let y = 0; y < radius && y < h; y++) {
      sum += tmp[y * w + x];
      count++;
    }
    for (let y = 0; y < h; y++) {
      const addY = y + radius;
      if (addY < h) {
        sum += tmp[addY * w + x];
        count++;
      }
      const remY = y - radius - 1;
      if (remY >= 0) {
        sum -= tmp[remY * w + x];
        count--;
      }
      const v = Math.round(Math.max(0, Math.min(1, sum / Math.max(1, count))) * 255);
      const idx = (y * w + x) * 4;
      out[idx]     = v;
      out[idx + 1] = v;
      out[idx + 2] = v;
      out[idx + 3] = 255;
    }
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, url, radius, opts } = e.data;
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
      cachedBumpData = imgData.data;
      cachedBumpWidth = canvas.width;
      cachedBumpHeight = canvas.height;
      cachedUrl = url;
    }
    if (!cachedBumpData) {
      self.postMessage({ id, phase: -1, error: 'No bump data loaded' });
      return;
    }

    const bumpData = opts.smooth
      ? smoothBumpData(cachedBumpData, cachedBumpWidth, cachedBumpHeight)
      : cachedBumpData;

    if (opts.uniform) {
      buildUniformStreaming(id, radius, bumpData, cachedBumpWidth, cachedBumpHeight, opts);
    } else if (opts.sample) {
      const { lat, lon } = opts;
      const u = (lon + 180) / 360;
      const v = (90 - lat) / 180;
      const px = Math.min(cachedBumpWidth - 1, Math.max(0, Math.floor(u * cachedBumpWidth)));
      const py = Math.min(cachedBumpHeight - 1, Math.max(0, Math.floor(v * cachedBumpHeight)));
      const h = bumpData[(py * cachedBumpWidth + px) * 4] / 255;
      self.postMessage({ id, phase: 3, height: h });
      return;
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
    return bumpData[(py * bw + px) * 4] / 255;
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
    const idx = positions.length / 3;
    positions.push(x, y, z);
    uvs.push(u, v);
    return idx;
  }

  // No phase 0 needed for uniform — just build and send
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

// ── Adaptive streaming path ─────────────────────────────────────────
function buildAdaptiveStreaming(id, radius, bumpData, bw, bh, opts) {
  const {
    baseSegmentsLon: baseLon, baseSegmentsLat: baseLat,
    maxDepth, displacementScale: dispScale,
    tileRows, tileCols,
  } = opts;

  // Phase 0 — depths + elevation ranges + per-row size estimates
  const elevationRanges = computeElevationRanges(bumpData, bw, bh, baseLon, baseLat);
  // Pixel-aware depth cap: can't subdivide past the source resolution
  const pixelMaxDepth = Math.ceil(Math.log2(bw / baseLon));
  const effectiveMaxDepth = Math.min(maxDepth, pixelMaxDepth);
  console.log(`[worker] pixelMaxDepth = floor(log2(${bw}/${baseLon})) = ${pixelMaxDepth}, effective = ${effectiveMaxDepth}`);
  const depths = computeDepths(elevationRanges, baseLon, baseLat, effectiveMaxDepth, opts);

  self.postMessage({
    id, phase: 0, elevationRanges,
    cellBaseLon: baseLon, cellBaseLat: baseLat,
  }, [elevationRanges.buffer]);

  function getDepth(i, j) {
    if (j < 0 || j >= baseLat) return 0;
    return depths[((i % baseLon + baseLon) % baseLon) * baseLat + j];
  }

  function materialIndexForUV(u, v) {
    const col = Math.min(tileCols - 1, Math.max(0, Math.floor(u * tileCols)));
    const row = Math.min(tileRows - 1, Math.max(0, Math.floor(v * tileRows)));
    return row * tileCols + col;
  }

  function cellIndexForUV(u, v) {
    const ci = Math.min(baseLon - 1, Math.max(0, Math.floor(u * baseLon)));
    const cj = Math.min(baseLat - 1, Math.max(0, Math.floor(v * baseLat)));
    return ci * baseLat + cj;
  }

  function sampleBump(u, v) {
    const uu = ((u % 1) + 1) % 1;
    const vv = v < 0 ? 0 : v > 1 ? 1 : v;
    const px = Math.min(bw - 1, Math.floor(uu * bw));
    const py = Math.min(bh - 1, Math.floor(vv * bh));
    return bumpData[(py * bw + px) * 4] / 255;
  }

  // Phase 1 — build rows, accumulate locally
  const allRows = [];
  let totalVertices = 0;
  for (let i = 0; i < baseLon; i++) {
    const positions = [];
    const uvs = [];
    const indicesByMaterial = Array.from({ length: tileRows * tileCols }, () => []);
    const cellTriCounts = new Uint32Array(baseLat);

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
      const idx = positions.length / 3;
      positions.push(x, y, z);
      uvs.push(u, v);
      return idx;
    }

    function pushTriangle(a, b, c, u, v) {
      indicesByMaterial[materialIndexForUV(u, v)].push(a, b, c);
      cellTriCounts[cellIndexForUV(u, v)] += 1;
    }

    for (let j = 0; j < baseLat; j++) {
      const d = depths[i * baseLat + j];
      const n = 1 << d;
      const u0 = i / baseLon, u1 = (i + 1) / baseLon;
      const v0 = j / baseLat, v1 = (j + 1) / baseLat;

      const grid = new Int32Array((n + 1) * (n + 1));
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
            const uC = (uL + uR) * 0.5;
            const vC = (vT + vB) * 0.5;
            pushTriangle(TR, TL, BR, uC, vC);
            pushTriangle(TL, BL, BR, uC, vC);
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
              pushTriangle(centre, boundary[k], boundary[next], uM, vM);
            }
          }
        }
      }
    }

    // Flatten indices and groups for this row
    const flatIndices = [];
    const groupRuns = [];
    for (let mi = 0; mi < indicesByMaterial.length; mi++) {
      const grp = indicesByMaterial[mi];
      if (grp.length === 0) continue;
      const start = flatIndices.length;
      for (const idx of grp) flatIndices.push(idx);
      groupRuns.push(start, grp.length, mi);
    }

    const rowVerts = positions.length / 3;
    totalVertices += rowVerts;

    allRows[i] = {
      positions: new Float32Array(positions),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(flatIndices),
      groupRuns: new Int32Array(groupRuns),
      cellTriCounts,
    };

    if ((i + 1) % 50 === 0 || i === 0 || i === baseLon - 1) {
      console.log(`[worker] row ${i + 1}/${baseLon} (${((i + 1) / baseLon * 100).toFixed(0)}%) — ${rowVerts.toLocaleString()} verts, ${(flatIndices.length / 3).toLocaleString()} tris`);
    }

    // Lightweight progress update
    self.postMessage({ id, phase: 1, row: i, totalRows: baseLon });
  }

  // Phase 2 — merge rows, reindex to tile-local, compute normals, compact
  const logStep = (msg) => {
    console.log(`[worker] ${msg}`);
    self.postMessage({ id, phase: 'progress', step: msg });
  };
  logStep(`merging ${totalVertices.toLocaleString()} verts from ${allRows.length} rows...`);
  let totalIdx = 0;
  for (let i = 0; i < allRows.length; i++) totalIdx += allRows[i].indices.length;

  const allPos = new Float32Array(totalVertices * 3);
  const allUV = new Float32Array(totalVertices * 2);
  const allIdx = new Uint32Array(totalIdx);
  const allGroups = [];
  let vOff = 0, iOff = 0;
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    if (!r) continue;
    allPos.set(r.positions, vOff * 3);
    allUV.set(r.uvs, vOff * 2);
    for (let t = 0; t < r.indices.length; t++) allIdx[iOff + t] = r.indices[t] + vOff;
    for (let g = 0; g < r.groupRuns.length; g += 3) {
      allGroups.push(r.groupRuns[g] + iOff, r.groupRuns[g + 1], r.groupRuns[g + 2]);
    }
    vOff += r.positions.length / 3;
    iOff += r.indices.length;
    allRows[i] = null; // free row memory as we merge
    if ((i + 1) % 100 === 0) logStep(`  merge ${i + 1}/${allRows.length} rows (${((i + 1) / allRows.length * 100).toFixed(0)}%)`);
  }
  logStep(`  merge done — ${(totalIdx / 3).toLocaleString()} total indices`);

  const groupsI32 = new Int32Array(allGroups);

  logStep(`reindexing ${(allGroups.length / 3).toLocaleString()} groups to tile-local UVs...`);
  const reindexed = reindexToTileLocal(allPos, allUV, allIdx, groupsI32, tileRows, tileCols);
  logStep(`  reindex done — ${(reindexed.positions.length / 3).toLocaleString()} verts after duplication`);

  logStep(`computing normals (${(reindexed.indices.length / 3).toLocaleString()} tris)...`);
  const normalsF32 = computeVertexNormals(reindexed.positions, reindexed.indices);
  logStep(`  normals done`);

  logStep(`compacting normals to Int8 (${reindexed.positions.length.toLocaleString()} components)...`);
  const normI8 = new Int8Array(reindexed.positions.length);
  for (let i = 0; i < normalsF32.length; i++) {
    const t = normalsF32[i] * 127;
    normI8[i] = (t + 0.5 - (t < 0)) | 0;
  }
  logStep(`  normals compacted`);

  const finalVerts = reindexed.positions.length / 3;
  const finalIdx = reindexed.indices.length;
  console.log(`[worker] assembly complete — ${finalVerts.toLocaleString()} verts, ${(finalIdx / 3).toLocaleString()} tris`);

  const transfer = [
    reindexed.positions.buffer,
    reindexed.uvs.buffer,
    reindexed.indices.buffer,
    reindexed.groups.buffer,
    normI8.buffer,
    reindexed.globalUVs.buffer,
  ];

  self.postMessage({
    id, phase: 2,
    positions: reindexed.positions,
    uvs: reindexed.uvs,
    indices: reindexed.indices,
    groups: reindexed.groups,
    normals: normI8,
    globalUVs: reindexed.globalUVs,
    totalVertices: finalVerts,
  }, transfer);
}

// ── Helpers ─────────────────────────────────────────────────────────
function sendRow(id, data) {
  const transfer = [data.positions.buffer, data.uvs.buffer, data.indices.buffer, data.groupRuns.buffer, data.cellTriCounts.buffer];
  self.postMessage({ id, phase: 1, row: 0, totalRows: 1, ...data }, transfer);
}

// ── Assembly helpers (was on main thread) ─────────────────────────
function reindexToTileLocal(positions, uvs, indices, groups, tileRows, tileCols) {
  const vertCount = positions.length / 3;
  const maxVerts = Math.ceil(vertCount * 1.18);
  const tilePos = new Float32Array(maxVerts * 3);
  // Compute Int16 UVs directly — no intermediate Float32 pass
  const tileUV = new Int16Array(maxVerts * 2);
  const globalUVArr = new Int16Array(maxVerts * 2);
  const tileIdx = new Uint32Array(indices.length);
  const tileGroups = new Int32Array(groups.length);

  const vertRemap = new Int32Array(vertCount);
  const vertGen = new Uint16Array(vertCount);
  let gen = 0;
  let vWrite = 0;
  let iWrite = 0;
  let gWrite = 0;

  for (let gi = 0; gi < groups.length; gi += 3) {
    const gStart = groups[gi], gCount = groups[gi + 1], gMat = groups[gi + 2];
    const row = Math.floor(gMat / tileCols);
    const col = gMat % tileCols;
    const outStart = iWrite;
    gen++;
    const gEnd = gStart + gCount;
    for (let j = gStart; j < gEnd; j++) {
      const oldIdx = indices[j];
      if (vertGen[oldIdx] !== gen) {
        vertGen[oldIdx] = gen;
        const newIdx = vWrite;
        vertRemap[oldIdx] = newIdx;
        const p3 = oldIdx * 3;
        const w3 = vWrite * 3;
        const w2 = vWrite * 2;
        tilePos[w3]     = positions[p3];
        tilePos[w3 + 1] = positions[p3 + 1];
        tilePos[w3 + 2] = positions[p3 + 2];
        const u = uvs[oldIdx * 2];
        const v = uvs[oldIdx * 2 + 1];
        tileUV[w2]     = (Math.max(0, Math.min(1, u * tileCols - col)) * 32767 + 0.5) | 0;
        tileUV[w2 + 1] = (Math.max(0, Math.min(1, v * tileRows - row)) * 32767 + 0.5) | 0;
        globalUVArr[w2]     = (u * 32767 + 0.5) | 0;
        globalUVArr[w2 + 1] = (v * 32767 + 0.5) | 0;
        vWrite++;
      }
      tileIdx[iWrite] = vertRemap[oldIdx];
      iWrite++;
    }
    tileGroups[gWrite]     = outStart;
    tileGroups[gWrite + 1] = gCount;
    tileGroups[gWrite + 2] = gMat;
    gWrite += 3;
  }

  return {
    positions: tilePos.slice(0, vWrite * 3),
    uvs: tileUV.slice(0, vWrite * 2),
    globalUVs: globalUVArr.slice(0, vWrite * 2),
    indices: tileIdx.slice(0, iWrite),
    groups: tileGroups.slice(0, gWrite),
  };
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

function computeDepths(elevationRanges, baseLon, baseLat, maxDepth, opts) {
  let depths;
  if (opts.depths) {
    depths = new Int32Array(opts.depths);
  } else {
    const threshold = opts.threshold ?? 0.05;
    depths = new Int32Array(baseLon * baseLat);
    const depthCounts = new Int32Array(maxDepth + 1);
    for (let i = 0; i < baseLon; i++) {
      for (let j = 0; j < baseLat; j++) {
        const range = elevationRanges[i * baseLat + j];
        let d;
        if (range <= threshold) {
          d = 0;
        } else {
          d = Math.min(maxDepth, Math.ceil(Math.log2(range / threshold)) + 1);
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
  const ranges = new Float32Array(baseLon * baseLat);
  for (let i = 0; i < baseLon; i++) {
    for (let j = 0; j < baseLat; j++) {
      const px0 = Math.floor(i / baseLon * bw);
      const px1 = Math.min(bw - 1, Math.ceil((i + 1) / baseLon * bw));
      const py0 = Math.floor(j / baseLat * bh);
      const py1 = Math.min(bh - 1, Math.ceil((j + 1) / baseLat * bh));
      let mn = Infinity, mx = -Infinity;
      for (let py = py0; py <= py1; py++) {
        const rowOff = py * bw;
        for (let px = px0; px <= px1; px++) {
          const h = bumpData[(rowOff + px) * 4] / 255;
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
      }
      ranges[i * baseLat + j] = mx - mn;
    }
  }
  return ranges;
}
