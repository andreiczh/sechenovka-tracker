import { pipeline, env } from '/voice-assets/transformers.min.js';
import { loadVoiceModel } from '/shared/voice-model-loader.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/voice-assets/';
env.backends.onnx.wasm.wasmPaths = '/voice-assets/';
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let model;
self.onmessage = async ({ data }) => {
  try {
    model ||= loadVoiceModel(() => pipeline('automatic-speech-recognition', 'whisper-base', { dtype: 'q8', device: 'wasm', local_files_only: true, progress_callback: progress => self.postMessage({ type: 'progress', status: progress.status, file: progress.file, progress: progress.progress }) }), { onRetry: () => self.postMessage({ type:'progress',message:'Соединение прервалось. Повторяем загрузку речевого модуля один раз…' }) });
    const transcribe = await model;
    if (data.type === 'load') { self.postMessage({ type: 'ready' }); return; }
    const result = await transcribe(data.audio, { language: 'russian', task: 'transcribe', return_timestamps: true, chunk_length_s: 25, stride_length_s: 4 });
    self.postMessage({ type: 'result', id: data.id, result });
  } catch (error) {
    model = null;
    const detail = String(error?.message || error?.name || 'unknown').replace(/https?:\/\/\S+/g, '[источник модуля]').slice(0, 220);
    self.postMessage({ type: 'error', id: data.id, message: data.type === 'load' ? 'Не загрузился речевой модуль. Повторите попытку или откройте сайт в обычном браузере.' : 'Не удалось распознать запись. Можно сохранить аудио и дополнить текст.', diagnostic: detail });
  }
};
