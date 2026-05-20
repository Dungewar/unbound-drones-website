const HALF_PI = Math.PI * 0.5;
const TWO_PI = Math.PI * 2;

export function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function gradHash(ix, iy, iz) {
  let h = ix * 1619 + iy * 31337 + iz * 6971;
  h = h ^ (h >> 13);
  h = h ^ (h >> 7);
  return h & 15;
}

function grad3(h, fx, fy, fz) {
  const u = h < 8 ? fx : fy;
  const v = h < 4 ? fy : (h === 12 || h === 14 ? fx : fz);
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function rawNoise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

  const n000 = grad3(gradHash(ix, iy, iz), fx, fy, fz);
  const n100 = grad3(gradHash(ix + 1, iy, iz), fx - 1, fy, fz);
  const n010 = grad3(gradHash(ix, iy + 1, iz), fx, fy - 1, fz);
  const n110 = grad3(gradHash(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz);
  const n001 = grad3(gradHash(ix, iy, iz + 1), fx, fy, fz - 1);
  const n101 = grad3(gradHash(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1);
  const n011 = grad3(gradHash(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1);
  const n111 = grad3(gradHash(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1);

  const nx00 = lerp(n000, n100, ux);
  const nx10 = lerp(n010, n110, ux);
  const nx01 = lerp(n001, n101, ux);
  const nx11 = lerp(n011, n111, ux);
  return lerp(lerp(nx00, nx10, uy), lerp(nx01, nx11, uy), uz);
}

function fbmWide(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let value = 0;
  let amplitude = 1.0;
  let frequency = 1.0;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += rawNoise3(x * frequency, y * frequency, z * frequency) * amplitude;
    maxAmp += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return maxAmp > 0 ? value / maxAmp : 0;
}

function sampleGuideField(field, width, height, u, v) {
  const x = ((u % 1) + 1) % 1 * (width - 1);
  const y = clamp01(v) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % width;
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const a = field[y0 * width + x0];
  const b = field[y0 * width + x1];
  const c = field[y1 * width + x0];
  const d = field[y1 * width + x1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function sampleEarthGuide(guide, u, v) {
  if (!guide) {
    return { ocean: 0, land: 0, desert: 0, ice: 0, elevation: 0 };
  }
  const { width, height } = guide;
  return {
    ocean: sampleGuideField(guide.ocean, width, height, u, v),
    land: sampleGuideField(guide.land, width, height, u, v),
    desert: sampleGuideField(guide.desert, width, height, u, v),
    ice: sampleGuideField(guide.ice, width, height, u, v),
    elevation: sampleGuideField(guide.elevation, width, height, u, v),
  };
}

function rotateSampleVector(rx, ry, rz) {
  return {
    x: 0.8660 * rx - 0.2803 * ry + 0.4145 * rz,
    y: 0.4145 * rx + 0.8660 * ry - 0.2803 * rz,
    z: -0.2803 * rx + 0.4145 * ry + 0.8660 * rz,
  };
}

function sampleWeather(lat, lon, x, y, z, terrain, seed, patternScale) {
  const ocean = terrain?.ocean ?? 0;
  const desert = terrain?.desert ?? 0;
  const elevation = terrain?.elevation ?? 0;
  const absLat = Math.abs(lat) / HALF_PI;

  const macroScale = patternScale;
  const mediumScale = patternScale * 1.18;
  const fineScale = patternScale * 1.34;

  const latWarp = fbmWide(
    x * 0.45 * macroScale + 4.7 + seed.x,
    y * 0.45 * macroScale - 1.3 + seed.y,
    z * 0.45 * macroScale + 2.9 + seed.z,
    3,
    2.0,
    0.50,
  );
  const pLat = clamp01(absLat + latWarp * 0.12);

  const itcz = Math.exp(-Math.pow(pLat / 0.20, 2.0));
  const stormTrack = Math.exp(-Math.pow((pLat - 0.55) / 0.20, 2.0));
  const subtropDry = Math.exp(-Math.pow((pLat - 0.32) / 0.13, 2.0));
  const polarBand = Math.exp(-Math.pow((pLat - 0.88) / 0.15, 2.0));

  const W0x = fbmWide(
    x * 0.28 * macroScale + seed.x,
    y * 0.28 * macroScale + seed.y,
    z * 0.28 * macroScale + seed.z,
    3,
    2.2,
    0.60,
  );
  const W0y = fbmWide(
    x * 0.28 * macroScale + 3.7 + seed.y,
    y * 0.28 * macroScale - 1.4 + seed.z,
    z * 0.28 * macroScale + 2.1 + seed.x,
    3,
    2.2,
    0.60,
  );
  const W0z = fbmWide(
    x * 0.28 * macroScale - 2.3 + seed.z,
    y * 0.28 * macroScale + 4.1 + seed.x,
    z * 0.28 * macroScale - 0.8 + seed.y,
    3,
    2.2,
    0.60,
  );

  const warpStr = 1.6 + stormTrack * 0.9 + itcz * 0.5;
  const px = x + W0x * warpStr;
  const py = y + W0y * warpStr * 0.15;
  const pz = z + W0z * warpStr;
  const pyE = py * 2.5;

  const envelope = fbmWide(
    px * 1.8 * macroScale + 1.3 + seed.x,
    pyE * 1.8 * macroScale - 0.7 + seed.y,
    pz * 1.8 * macroScale + 2.1 + seed.z,
    5,
    2.0,
    0.58,
  );
  const texture = fbmWide(
    px * 5.5 * mediumScale + 4.2 + seed.z,
    pyE * 5.5 * mediumScale - 2.1 + seed.x,
    pz * 5.5 * mediumScale + 0.8 + seed.y,
    4,
    2.1,
    0.52,
  );
  const detail = fbmWide(
    px * 14.0 * fineScale + 0.7 + seed.y,
    pyE * 14.0 * fineScale - 1.3 + seed.z,
    pz * 14.0 * fineScale + 2.8 + seed.x,
    3,
    2.0,
    0.48,
  );

  const lowGate = envelope * 0.70 + texture * 0.22 + detail * 0.08;
  const lowShift = (
    + itcz * 0.14
    + stormTrack * 0.14
    - subtropDry * 0.22
    + polarBand * 0.06
    + elevation * 0.02
    - desert * 0.18
    + ocean * 0.01
  );
  const lowAlpha = clamp01(smoothstep(0.00, 0.36, lowGate + lowShift));
  const lowHeight = clamp01(
    (texture * 0.5 + 0.5) * 0.50 +
    (detail * 0.5 + 0.5) * 0.20 +
    lowAlpha * 0.30,
  );

  const midEnv = fbmWide(
    px * 1.8 * macroScale - 3.4 + seed.z,
    pyE * 1.8 * macroScale + 2.1 + seed.x,
    pz * 1.8 * macroScale - 1.7 + seed.y,
    4,
    2.0,
    0.56,
  );
  const midTex = fbmWide(
    px * 5.5 * mediumScale - 1.8 + seed.y,
    pyE * 5.5 * mediumScale + 0.9 + seed.z,
    pz * 5.5 * mediumScale - 3.4 + seed.x,
    3,
    2.1,
    0.50,
  );
  const midGate = midEnv * 0.68 + midTex * 0.24 + detail * 0.08;
  const midShift = + stormTrack * 0.12 + itcz * 0.08 - subtropDry * 0.20 + polarBand * 0.05;
  const midAlpha = clamp01(smoothstep(0.02, 0.38, midGate + midShift));
  const midHeight = clamp01((midTex * 0.5 + 0.5) * 0.55 + 0.15);

  const cirrusBase = fbmWide(
    px * 5.5 * mediumScale + 1.7 + seed.y,
    pyE * 15.5 * fineScale - 0.9 - seed.z,
    pz * 5.5 * mediumScale + 2.5 + seed.x,
    3,
    2.6,
    0.42,
  );
  const cirrusFine = fbmWide(
    px * 14.0 * fineScale - 0.6 + seed.x,
    pyE * 36.0 * fineScale + 1.4 - seed.y,
    pz * 14.0 * fineScale - 2.1 + seed.z,
    3,
    2.6,
    0.38,
  );
  const cirrusGate = cirrusBase * 0.60 + cirrusFine * 0.40;
  const cirrusShift = + stormTrack * 0.06 + itcz * 0.04 - subtropDry * 0.08 + polarBand * 0.04;
  const highAlpha = clamp01(smoothstep(0.07, 0.46, cirrusGate + cirrusShift));
  const highHeight = clamp01((cirrusFine * 0.5 + 0.5) * 0.65 + 0.15);

  return {
    lowAlpha,
    lowHeight,
    midAlpha,
    midHeight,
    highAlpha,
    highHeight,
    character: clamp01(texture * 0.5 + 0.5),
  };
}

function writePackedScalar(bytes, pixelIndex, value) {
  const byte = Math.round(clamp01(value) * 255);
  bytes[pixelIndex + 0] = byte;
  bytes[pixelIndex + 1] = byte;
  bytes[pixelIndex + 2] = byte;
  bytes[pixelIndex + 3] = 255;
}

function stitchColorBytes(bytes, width, height) {
  for (let y = 0; y < height; y++) {
    const left = y * width * 4;
    const right = left + (width - 1) * 4;
    for (let c = 0; c < 4; c++) {
      const value = Math.round((bytes[left + c] + bytes[right + c]) * 0.5);
      bytes[left + c] = value;
      bytes[right + c] = value;
    }
  }
}

function stitchScalarBytes(bytes, width, height) {
  for (let y = 0; y < height; y++) {
    const left = y * width * 4;
    const right = left + (width - 1) * 4;
    const value = Math.round((bytes[left] + bytes[right]) * 0.5);
    bytes[left + 0] = value;
    bytes[left + 1] = value;
    bytes[left + 2] = value;
    bytes[left + 3] = 255;
    bytes[right + 0] = value;
    bytes[right + 1] = value;
    bytes[right + 2] = value;
    bytes[right + 3] = 255;
  }
}

export function generateCloudDeckBytes({
  width,
  height,
  earthGuide,
  cloudSeed,
  patternScale = 1.0,
}) {
  const seed = {
    x: cloudSeed * 1.371,
    y: cloudSeed * 2.117,
    z: cloudSeed * 0.793,
  };

  const lowColor = new Uint8Array(width * height * 4);
  const lowAlpha = new Uint8Array(width * height * 4);
  const lowDepth = new Uint8Array(width * height * 4);
  const midColor = new Uint8Array(width * height * 4);
  const midAlpha = new Uint8Array(width * height * 4);
  const midDepth = new Uint8Array(width * height * 4);
  const cirrusColor = new Uint8Array(width * height * 4);
  const cirrusAlpha = new Uint8Array(width * height * 4);
  const cirrusDepth = new Uint8Array(width * height * 4);

  for (let py = 0; py < height; py++) {
    const v = py / (height - 1);
    const lat = (0.5 - v) * Math.PI;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);

    for (let px = 0; px < width; px++) {
      const u = px / (width - 1);
      const lon = (u - 0.5) * TWO_PI;
      const rx = cosLat * Math.cos(lon);
      const ry = sinLat;
      const rz = cosLat * Math.sin(lon);
      const rotated = rotateSampleVector(rx, ry, rz);
      const terrain = sampleEarthGuide(earthGuide, u, v);
      const sample = sampleWeather(lat, lon, rotated.x, rotated.y, rotated.z, terrain, seed, patternScale);

      const lowAlphaValue = sample.lowAlpha;
      const midAlphaValue = sample.midAlpha;
      const cirrusAlphaValue = sample.highAlpha;
      const blendedHeight = clamp01(sample.lowHeight * 0.7 + sample.midHeight * 0.3);
      const lowDepthValue = clamp01(lowAlphaValue * (0.32 + sample.lowHeight * 0.68));
      const midDepthValue = clamp01(midAlphaValue * (0.28 + sample.midHeight * 0.72));
      const cirrusDepthValue = clamp01(cirrusAlphaValue * (0.16 + sample.highHeight * 0.84));
      const pixelIndex = (py * width + px) * 4;

      const brightness = clamp01(blendedHeight * 0.75 + sample.character * 0.15 + lowAlphaValue * 0.10);
      const lowLight = lerp(242, 255, brightness);
      lowColor[pixelIndex + 0] = Math.round(lowLight);
      lowColor[pixelIndex + 1] = Math.round(Math.min(255, lowLight + 2));
      lowColor[pixelIndex + 2] = Math.round(Math.min(255, lowLight + 5));
      lowColor[pixelIndex + 3] = 255;

      const midBrightness = clamp01(sample.midHeight * 0.75 + sample.character * 0.15 + midAlphaValue * 0.10);
      const midLight = lerp(200, 252, midBrightness);
      midColor[pixelIndex + 0] = Math.round(midLight);
      midColor[pixelIndex + 1] = Math.round(Math.min(255, midLight + 2));
      midColor[pixelIndex + 2] = Math.round(Math.min(255, midLight + 4));
      midColor[pixelIndex + 3] = 255;

      const cirrusLight = lerp(215, 250, clamp01(sample.highHeight * 0.80 + cirrusAlphaValue * 0.20));
      cirrusColor[pixelIndex + 0] = Math.round(cirrusLight);
      cirrusColor[pixelIndex + 1] = Math.round(Math.min(255, cirrusLight + 2));
      cirrusColor[pixelIndex + 2] = Math.round(Math.min(255, cirrusLight + 6));
      cirrusColor[pixelIndex + 3] = 255;

      writePackedScalar(lowAlpha, pixelIndex, lowAlphaValue);
      writePackedScalar(lowDepth, pixelIndex, lowDepthValue);
      writePackedScalar(midAlpha, pixelIndex, midAlphaValue);
      writePackedScalar(midDepth, pixelIndex, midDepthValue);
      writePackedScalar(cirrusAlpha, pixelIndex, cirrusAlphaValue);
      writePackedScalar(cirrusDepth, pixelIndex, cirrusDepthValue);
    }
  }

  stitchColorBytes(lowColor, width, height);
  stitchColorBytes(midColor, width, height);
  stitchColorBytes(cirrusColor, width, height);
  stitchScalarBytes(lowAlpha, width, height);
  stitchScalarBytes(lowDepth, width, height);
  stitchScalarBytes(midAlpha, width, height);
  stitchScalarBytes(midDepth, width, height);
  stitchScalarBytes(cirrusAlpha, width, height);
  stitchScalarBytes(cirrusDepth, width, height);

  return {
    width,
    height,
    lowColor,
    lowAlpha,
    lowDepth,
    midColor,
    midAlpha,
    midDepth,
    cirrusColor,
    cirrusAlpha,
    cirrusDepth,
  };
}
