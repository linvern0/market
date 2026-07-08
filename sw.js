// Do'kon Boshqaruvi — Service Worker
// MAQSAD: faqat ilova "qobig'i"ni (HTML/CSS/JS/rasmlar) keshlash, shunda
// ilova birinchi marta ochilgandan keyin internetsiz ham DARHOL yuklanadi.
// Firestore ma'lumotlari (mahsulotlar, savdolar va h.k.) bu yerda umuman
// ushlanmaydi — ular Firestore'ning o'z persistentLocalCache mexanizmi
// orqali (market.html ichida sozlangan) alohida boshqariladi.

const CACHE_VERSION = 'dokon-shell-v1';
const SHELL_FILES = [
  './market.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // MUHIM: Firebase/Firestore va boshqa tashqi domenlarga (masalan
  // gstatic.com'dagi Firebase SDK) tegilmaymiz — ularni to'g'ridan-to'g'ri
  // tarmoqqa yuboramiz. Faqat GET so'rovlari va o'z saytimizdagi (same-
  // origin) fayllarni keshlaymiz.
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Stale-while-revalidate: avval keshdan DARHOL beramiz (tez!), fonda esa
  // tarmoqdan yangi versiyani olib, keshni yangilaymiz — shunda keyingi
  // ochilishda eng so'nggi versiya tayyor bo'ladi.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached); // internet yo'q — keshdagisi bilan qolamiz

      return cached || networkFetch;
    })
  );
});
