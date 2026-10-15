// Do'kon Boshqaruvi — Service Worker
// Vazifasi: ilova "qobig'i"ni (HTML/JS/CSS/ikonkalar) keshlab, internet
// yo'qolganda ham ilova DARHOL ochilishini ta'minlash. E'TIBOR: Firestore
// ma'lumotlari (mahsulotlar, savdolar va h.k.) bu yerda KESHLANMAYDI — ular
// allaqachon ilova ichida `persistentLocalCache` orqali offline saqlanadi.
// Bu service worker faqat statik fayllarga tegishli.

const CACHE_VERSION = 'dokon-shell-v8';
const RUNTIME_CACHE = 'dokon-runtime-v8';
const MAX_RUNTIME_ENTRIES = 80;

const SHELL_FILES = [
  './', './index.html', './manifest.json',
  './icon-72.png', './icon-96.png', './icon-128.png', './icon-144.png',
  './icon-152.png', './icon-192.png', './icon-384.png', './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== RUNTIME_CACHE).map((k) => caches.delete(k))))
      .then(() => (self.registration.navigationPreload ? self.registration.navigationPreload.enable() : null))
      .then(() => self.clients.claim())
  );
});

// TUZATILDI: avval gstatic.com/firebasejs (Firebase JS modullari) va Google
// Fonts ham "bypass" qilinardi — natijada internet yo'qda index.html keshdan
// ochilsa ham, Firebase modullari yuklanmay, ilova ISHLAMAY qolardi.
// Endi faqat HAQIQIY ma'lumot trafigi (Firestore/Auth API, /api/) keshlanmaydi.
function isBypassRequest(url) {
  const h = url.hostname;
  return (
    h === 'firestore.googleapis.com' ||
    h.endsWith('firebaseio.com') ||
    h === 'identitytoolkit.googleapis.com' ||
    h === 'securetoken.googleapis.com' ||
    h === 'firebaseinstallations.googleapis.com' ||
    h === 'api.telegram.org' ||
    (h === self.location.hostname && url.pathname.startsWith('/api/'))
  );
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol) || isBypassRequest(url)) return;

  // O'z domenimiz: TEZLASHTIRISH — "stale-while-revalidate". Ilova keshdan
  // DARHOL ochiladi (1.3 MB sahifani tarmoqdan kutmasdan), yangi versiya fonda
  // yuklanib keyingi ochilishda ishlaydi. Keshda yo'q bo'lsa — tarmoq.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const preload = event.preloadResponse ? await event.preloadResponse.catch(() => null) : null;
      const network = (preload ? Promise.resolve(preload) : fetch(req))
        .then((res) => { if (res && res.status === 200) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
    return;
  }

  // Tashqi statik kutubxonalar (CDN, Firebase modullari, shriftlar):
  // keshdan tez, fonda yangilanadi.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone)).then(() => trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
