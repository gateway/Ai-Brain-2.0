import { runExternalRelationExtractionShadow } from "../relationships/external-ie.js";

const sampleScenes = [
  {
    sceneIndex: 0,
    text: "Steve works at Two-Way and works with Omar on Project Atlas in Chiang Mai."
  },
  {
    sceneIndex: 1,
    text: "Lauren and Steve dated before, but they are not partners now."
  }
];

const result = await runExternalRelationExtractionShadow(sampleScenes);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
