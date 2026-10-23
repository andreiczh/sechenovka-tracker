import { pipeline, env } from '/voice-assets/transformers.min.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/voice-assets/';
env.backends.onnx.wasm.wasmPaths = '/voice-assets/';
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let model;
self.onmessage = async ({ data }) => {
  try {
    model ||= pipeline('automatic-speech-recognition', 'whisper-base', { dtype: 'q8', device: 'wasm', local_files_only: true, progress_callback: progress => self.postMessage({ type: 'progress', status: progress.status, file: progress.file, progress: progress.progress }) });
    const transcribe = await model;
    if (data.type === 'load') { self.postMessage({ type: 'ready' }); return; }
    const result = await transcribe(data.audio, { language: 'russian', task: 'transcribe', return_timestamps: true, chunk_length_s: 25, stride_length_s: 4 });
    self.postMessage({ type: 'result', id: data.id, result });
  } catch { model = null; self.postMessage({ type: 'error', id: data.id, message: 'Не удалось распознать запись на устройстве. Попробуйте ещё раз, загрузите другой файл или впишите текст.' }); }
};
