// The embedding model used by the extension. Weights are fetched from Hugging Face
// at build time (npm run fetch-model) and bundled, so nothing is downloaded at runtime.
export const MODEL = {
  id: 'Xenova/all-MiniLM-L6-v2',
  // fp16 (onnx/model_fp16.onnx, 45 MB) runs on WebGPU and on the WASM fallback.
  // q8 is half the size but about 5x slower to index, because WebGPU cannot run it.
  dtype: 'fp16',
  pooling: 'mean',
  queryPrefix: '',
  // Calibrated on bench/model-pick. Scores differ between models, so this is per model.
  defaultThreshold: 0.35,
} as const;
