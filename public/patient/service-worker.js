const CACHE = 'sechenovka-patient-shell-v14';
const FILES = ['/shared/interface.css', '/shared/voice-layout.css', '/shared/recommendations.js', '/shared/voice-flow.js', '/shared/voice-view.js', '/shared/voice-ui.js', '/shared/voice-model.js', '/shared/voice-capture.js', '/shared/voice-worker.js', '/shared/voice-model-loader.js', '/shared/voice-audio-worklet.js', '/shared/voice.css', '/patient/', '/patient/index.html', '/patient/patient.css', '/patient/patient.js', '/patient/manifest.webmanifest', '/shared/viewport.js', '/shared/viewport.css', '/shared/client.js', '/shared/telegram.js', '/shared/clinical.js', '/shared/evidence.js', '/shared/support-ui.js', '/shared/support.css', '/fonts/golos-text-cyrillic.woff2', '/fonts/golos-text-latin.woff2', '/icons/mark.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/assets/welcome.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('sechenovka-patient-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // The API and patient data are deliberately never stored in CacheStorage.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); } return response; }).catch(() => caches.match(event.request)));
});
