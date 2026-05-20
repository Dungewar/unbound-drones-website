import { generateCloudDeckBytes } from './clouds-shared.js';

self.onmessage = (event) => {
  const {
    id,
    width,
    height,
    earthGuide,
    cloudSeed,
    patternScale,
  } = event.data;

  const deckSet = generateCloudDeckBytes({
    width,
    height,
    earthGuide,
    cloudSeed,
    patternScale,
  });

  self.postMessage(
    { id, deckSet },
    [
      deckSet.lowColor.buffer,
      deckSet.lowAlpha.buffer,
      deckSet.lowDepth.buffer,
      deckSet.midColor.buffer,
      deckSet.midAlpha.buffer,
      deckSet.midDepth.buffer,
      deckSet.cirrusColor.buffer,
      deckSet.cirrusAlpha.buffer,
      deckSet.cirrusDepth.buffer,
    ],
  );
};
