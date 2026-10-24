export class VoiceRecognizer {
  constructor(progress = () => {}) { this.progress = progress; this.sequence = 0; this.generation = 0; this.jobs = new Map(); this.chain = Promise.resolve(); }
  async load() {
    if (!this.ready) {
      this.worker = new Worker('/shared/voice-worker.js', { type: 'module' });
      this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { this.readyResolve(); this.progress('Речевой модуль готов'); }
        else if (data.type === 'progress') this.progress(data.message || (data.file ? `Загрузка модуля: ${String(data.file).split('/').at(-1)}${Number.isFinite(data.progress) ? ' · ' + Math.round(data.progress) + '%' : ''}` : 'Подготовка речевого модуля…'));
        else if (data.type === 'result') { this.jobs.get(data.id)?.resolve(data.result); this.jobs.delete(data.id); }
        else if (data.type === 'error') { const error = new Error(data.message + (data.diagnostic ? ' Детали сбоя: ' + data.diagnostic : '')); if (data.id) { this.jobs.get(data.id)?.reject(error); this.jobs.delete(data.id); } else { this.readyReject(error); this.worker?.terminate(); this.ready = null; } }
      };
      this.worker.onerror = () => { const error = new Error('Речевой модуль не запустился. Можно вписать текст или повторить загрузку.'); this.readyReject(error); for (const job of this.jobs.values()) job.reject(error); this.jobs.clear(); this.worker?.terminate(); this.ready = null; };
      this.worker.postMessage({ type: 'load' });
    }
    return this.ready;
  }
  transcribe(audio) {
    const generation = this.generation;
    const next = this.chain.catch(() => {}).then(async () => { if (generation !== this.generation) throw new Error('Распознавание остановлено'); await this.load(); if (generation !== this.generation) throw new Error('Распознавание остановлено'); const id = ++this.sequence; return new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject }); this.worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]); }); });
    this.chain = next; return next;
  }
  dispose() { this.generation++; this.worker?.terminate(); this.readyReject?.(new Error('Распознавание остановлено')); for (const job of this.jobs.values()) job.reject(new Error('Распознавание остановлено')); this.jobs.clear(); this.ready = null; }
}
export function splitVoiceResult(result, offset = 0) {
  const chunks = result.chunks?.length ? result.chunks : [{ text: result.text, timestamp: [0, null] }];
  return chunks.flatMap(chunk => {
    const text = (chunk.text || '').trim();
    if (!text || /^\[(?:музыка|тишина|аплодисменты)\]$/i.test(text)) return [];
    const phrases = text.match(/[^.!?\n]+[.!?]?/g) || [text];
    return phrases.flatMap(phrase => { const parts = []; for (let i = 0; i < phrase.length; i += 1000) parts.push({ text: phrase.slice(i, i + 1000).trim(), start: offset + (chunk.timestamp?.[0] || 0), end: chunk.timestamp?.[1] == null ? null : offset + chunk.timestamp[1], role: 'unknown', topics: [] }); return parts.filter(p => p.text); });
  });
}
export function prepareVoiceAudio(audio) {
  if(!audio?.length)return null;
  let energy=0,peak=0;for(const sample of audio){energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
  const rms=Math.sqrt(energy/audio.length);
  if(rms<0.00015)return null;
  const gain=Math.min(12,0.08/rms,0.95/Math.max(peak,0.000001));
  return gain>1?Float32Array.from(audio,sample=>sample*gain):audio;
}
export async function decodeVoiceFile(file, maximumSeconds) {
  if (!file.size || file.size > 30 * 1024 * 1024) throw new Error('Выберите аудиофайл размером до 30 МБ.');
  const url = URL.createObjectURL(file), audio = new Audio();
  try {
    const duration = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Не удалось прочитать длительность аудио. Попробуйте WAV, MP3 или M4A.')), 12000); audio.onloadedmetadata = () => { clearTimeout(timer); resolve(audio.duration); }; audio.onerror = () => { clearTimeout(timer); reject(new Error('Браузер не прочитал формат. Попробуйте WAV, MP3 или M4A.')); }; audio.preload = 'metadata'; audio.src = url; });
    if (!Number.isFinite(duration) || duration <= 0 || duration > maximumSeconds) throw new Error(`Для загрузки выберите файл длительностью до ${maximumSeconds / 60} минут. Длинный приём можно записать по частям.`);
    const context = new AudioContext({ sampleRate: 16000 });
    try { const buffer = await context.decodeAudioData(await file.arrayBuffer()); const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000), source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start(); const decoded = await offline.startRendering(); return { audio: decoded.getChannelData(0).slice(), duration: buffer.duration }; } finally { await context.close(); }
  } finally { URL.revokeObjectURL(url); audio.removeAttribute('src'); audio.load(); }
}
let pendingMicrophoneRequest = null;
const hiddenPage = () => typeof document !== 'undefined' && document.hidden;
const requireVisiblePage = () => { if (hiddenPage()) throw new Error('Окно записи скрыто. Выведите эту вкладку Safari на экран и снова нажмите «Начать запись». Запись не началась.'); };
export async function startVoiceCapture({ onChunk, onState, onEnded = () => {}, onSetup = () => {}, onLevel = () => {}, deviceId = '', maximumSeconds = 3600, inputStream = null, signal = null, setupTimeoutMs = 30000 }) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioWorkletNode) throw new Error('В этом окне запись недоступна. Откройте сайт в Safari/Chrome или загрузите аудиофайл.');
  // Safari defers getUserMedia for an occluded page, even after a trusted click.
  // Do not queue an invisible permission prompt or consume its timeout off-screen.
  if (!inputStream && pendingMicrophoneRequest) throw new Error('Safari ещё ожидает ответ на предыдущий запрос микрофона. Вернитесь в это окно и ответьте на запрос браузера, затем повторите запись.');
  let stream, context, contextClosing, recorder, node, source, timer, hiddenListener, visibilityWaitListener, abortListener, setupCancel; const blobs = []; let elapsed = 0, paused = false, stopping = false, disposed = false, levelReceived = false, heardSound = false, startAt = 0, pausedAt = 0, pausedTotal = 0;
  const seconds = () => Math.min(maximumSeconds, Math.floor(((paused ? pausedAt : performance.now()) - startAt - pausedTotal) / 1000));
  const closeContext = () => contextClosing ||= context && context.state !== 'closed' ? context.close() : Promise.resolve();
  const cleanup = async () => { disposed = true; clearInterval(timer); if(hiddenListener)document.removeEventListener('visibilitychange',hiddenListener);if(visibilityWaitListener)document.removeEventListener('visibilitychange',visibilityWaitListener);if(abortListener)signal?.removeEventListener('abort',abortListener); node?.disconnect(); source?.disconnect(); stream?.getTracks().forEach(t => t.stop()); await closeContext(); };
  const checkAborted = () => { if (signal?.aborted) throw new DOMException('Запись отменена', 'AbortError'); };
  const waitForSetup = (promise, message, phase) => {
    let timeout, visibilityHandler, remaining = setupTimeoutMs, visibleSince = null;
    return new Promise((resolve, reject) => {
      const schedule = () => {
        clearTimeout(timeout);
        if (visibleSince !== null) remaining -= performance.now() - visibleSince;
        visibleSince = null;
        if (hiddenPage()) { onSetup('visibility'); return; }
        if (phase) onSetup(phase);
        visibleSince = performance.now();
        timeout = setTimeout(() => reject(new Error(message)), Math.max(0, remaining));
      };
      schedule();
      visibilityHandler = schedule;
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', schedule);
      setupCancel = () => reject(new DOMException('Запись отменена', 'AbortError'));
      Promise.resolve(promise).then(resolve, reject);
    }).finally(() => { clearTimeout(timeout); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityHandler); setupCancel = null; });
  };
  try {
    checkAborted();
    // Resume in the original click gesture, before permission/model/worklet awaits.
    // Safari may otherwise leave a suspended context waiting indefinitely.
    context = new AudioContext();
    const resumed = context.resume(); resumed.catch(() => {});
    abortListener = () => { setupCancel?.(); stream?.getTracks().forEach(t=>t.stop());void closeContext().catch(()=>{}); };signal?.addEventListener('abort',abortListener,{once:true});
    if (hiddenPage()) {
      const visible = new Promise(resolve => { visibilityWaitListener = () => { if (!hiddenPage()) resolve(); }; document.addEventListener('visibilitychange', visibilityWaitListener); });
      await waitForSetup(visible, 'Не удалось дождаться видимой вкладки. Откройте окно записи и повторите.', 'permission');
      document.removeEventListener('visibilitychange', visibilityWaitListener); visibilityWaitListener = null; checkAborted();
    }
    const request = Promise.resolve(inputStream || navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, ...(deviceId?{deviceId:{exact:deviceId}}:{}) }, video: false }));
    if (!inputStream) { pendingMicrophoneRequest = request; void request.finally(() => { if (pendingMicrophoneRequest === request) pendingMicrophoneRequest = null; }).catch(() => {}); }
    const media = request.then(value => { if(disposed || signal?.aborted){value.getTracks().forEach(t=>t.stop());throw new DOMException('Запись отменена','AbortError');}return value; });
    stream = await waitForSetup(media, 'Браузер не завершил запрос микрофона за 30 секунд активного окна. Ответьте на запрос Safari; если его нет, проверьте разрешение микрофона для этого сайта.', 'permission');
    checkAborted(); requireVisiblePage();
    await waitForSetup(context.audioWorklet.addModule('/shared/voice-audio-worklet.js'), 'Не загрузился обработчик записи. Проверьте сеть и повторите.', 'processor');checkAborted();
    await waitForSetup(resumed, 'Браузер не включил аудио. Нажмите «Начать запись» ещё раз или откройте сайт в обычном браузере.', 'audio');checkAborted(); requireVisiblePage();
    node = new AudioWorkletNode(context, 'voice-pcm', { processorOptions: { maximumSeconds } }); source = context.createMediaStreamSource(stream); source.connect(node); node.connect(context.destination);
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 });
    recorder.ondataavailable = e => { if (e.data.size) blobs.push(e.data); }; recorder.start(1000); startAt = performance.now();
    const capture = {
      deviceLabel: stream.getAudioTracks()[0]?.label || 'Микрофон устройства',
      get paused() { return paused; }, get seconds() { return seconds(); },
      pause() { if (paused || stopping) return; pausedAt = performance.now(); paused = true; node.port.postMessage('pause'); if(recorder.state==='recording')recorder.pause(); onState('paused', seconds()); },
      resume() { if (!paused || stopping) return; pausedTotal += performance.now() - pausedAt; paused = false; node.port.postMessage('resume'); if(recorder.state==='paused')recorder.resume(); onState('recording', seconds()); },
      async stop() { if (stopping) return null; elapsed = seconds(); stopping = true; clearInterval(timer); node.port.postMessage('pause'); node.port.postMessage('flush'); if(recorder.state!=='inactive'){const done = new Promise(resolve => { recorder.onstop = resolve; }); recorder.stop(); await done;} await new Promise(resolve => setTimeout(resolve, 80)); await cleanup(); return { blob: new Blob(blobs, { type: recorder.mimeType || 'audio/webm' }), duration: elapsed, hasSound:levelReceived?heardSound:null }; },
    };
    const ended = reason => { if(stopping)return;void capture.stop().then(result=>onEnded(result,reason)).catch(()=>onEnded(null,'error')); };
    node.port.onmessage = ({data}) => { if(data.type==='limit')ended('limit');else if(data.type==='level'){levelReceived=true;heardSound ||= data.value>=0.00015;onLevel(data.value);}else if(data.audio)onChunk(data.audio,data.offset); };
    recorder.onerror = () => ended('error'); stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>ended('ended')));
    hiddenListener = () => { if(document.hidden&&!paused){capture.pause();onState('hidden',seconds());} }; document.addEventListener('visibilitychange',hiddenListener);
    timer = setInterval(() => { elapsed = seconds(); onState(paused ? 'paused' : 'recording', elapsed); if (elapsed >= maximumSeconds) ended('limit'); }, 1000);
    return capture;
  } catch (error) { await cleanup(); if (error.name === 'NotAllowedError') throw new Error('Микрофон не разрешён. Разрешите его в настройках сайта или загрузите аудиофайл.'); if (error.name === 'NotFoundError') throw new Error('Микрофон не найден. Можно загрузить запись или вписать текст.'); if(error.name==='OverconstrainedError')throw new Error('Выбранный микрофон недоступен. Выберите другой или «По умолчанию».'); if(error.name==='NotReadableError')throw new Error('Микрофон занят или недоступен системе. Закройте другую запись и повторите; можно загрузить аудиофайл.'); throw error; }
}
