const CACHE = 'sechenovka-vop-v12';
const PREFIX = 'sechenovka-vop-';
const FILES = ['/shared/interface.css', '/shared/voice-layout.css', '/shared/recommendations.js', '/shared/voice-flow.js', '/shared/voice-view.js', '/shared/voice-ui.js', '/shared/voice-model.js', '/shared/voice-capture.js', '/shared/voice-worker.js', '/shared/voice-model-loader.js', '/shared/voice-audio-worklet.js', '/shared/voice.css', '/', '/index.html', '/shared/viewport.js', '/shared/vop-support.js', '/shared/support-ui.js', '/shared/evidence.js', '/shared/client.js', '/shared/telegram.js', '/shared/support.css', '/shared/viewport.css', '/styles.css', '/app.js', '/config.js', '/clinical-data.js', '/vendor/qrcode.js', '/manifest.webmanifest', '/fonts/golos-text-cyrillic.woff2', '/fonts/golos-text-latin.woff2', '/icons/mark.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') return cache.match('/index.html');
      throw error;
    }
  })());
});
