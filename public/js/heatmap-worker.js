// Off-thread heatmap texture builder.
//
// Receives subdivision targets (or distance params to compute them),
// renders HSL→RGB pixel data in chunks, and streams column batches
// back to the main thread so partial results can be displayed immediately.
//
// Cancellation: setting a new request ID via a new message causes
// the in-progress build to abort between chunks.

let currentId = -1;

self.onmessage = (e) => {
  currentId = e.data.id;
  buildHeatmap(e.data);
};

const COLS_PER_CHUNK = 48;

async function buildHeatmap(params) {
  const { id, mode, baseLon, baseLat } = params;

  const source = params.subdivTargets;
  let normMax = params.normMax ?? 0;
  if (!normMax) {
    for (let i = 0; i < source.length; i++) {
      if (source[i] > normMax) normMax = source[i];
    }
  }

  if (normMax < 1) normMax = 1;
  const sourceLen = source.length;
  const width = baseLon;
  const height = baseLat;

  for (let ciStart = 0; ciStart < baseLon; ciStart += COLS_PER_CHUNK) {
    if (ciStart > 0) {
      await new Promise(r => setTimeout(r, 0));
      if (currentId !== id) return;
    }

    const ciEnd = Math.min(ciStart + COLS_PER_CHUNK, baseLon);
    const chunkCols = ciEnd - ciStart;
    const pixels = new Uint8ClampedArray(chunkCols * height * 4);

    for (let ci = ciStart; ci < ciEnd; ci++) {
      for (let cj = 0; cj < baseLat; cj++) {
        const idx = ci * baseLat + cj;
        const t = idx < sourceLen ? Math.min(1, source[idx] / normMax) : 0;
        // Multi-stop piecewise gradient so the spectrum is perceptually ordered
        const stops = [
          { t: 0.00, r: 0.10, g: 0.10, b: 0.31 },  // dark navy
          { t: 0.15, r: 0.13, g: 0.33, b: 0.80 },  // blue
          { t: 0.30, r: 0.13, g: 0.67, b: 0.67 },  // cyan
          { t: 0.45, r: 0.27, g: 0.67, b: 0.13 },  // green
          { t: 0.65, r: 0.80, g: 0.80, b: 0.13 },  // yellow
          { t: 0.85, r: 0.80, g: 0.27, b: 0.13 },  // red
          { t: 1.00, r: 1.00, g: 1.00, b: 1.00 },  // white
        ];
        let lo = stops[0], hi = stops[stops.length - 1];
        for (let s = 1; s < stops.length; s++) {
          if (t <= stops[s].t) { lo = stops[s - 1]; hi = stops[s]; break; }
        }
        const f = (t - lo.t) / (hi.t - lo.t);
        const r = lo.r + (hi.r - lo.r) * f;
        const g = lo.g + (hi.g - lo.g) * f;
        const b = lo.b + (hi.b - lo.b) * f;
        const px = ci - ciStart;
        const py = baseLat - 1 - cj;
        const pidx = (py * chunkCols + px) * 4;
        pixels[pidx]     = Math.round(r * 255);
        pixels[pidx + 1] = Math.round(g * 255);
        pixels[pidx + 2] = Math.round(b * 255);
        pixels[pidx + 3] = 255;
      }
    }

    self.postMessage(
      { id, phase: 'chunk', startCol: ciStart, endCol: ciEnd, pixels, width, height },
      [pixels.buffer],
    );
  }

  if (currentId !== id) return;
  self.postMessage({ id, phase: 'done' });
}
