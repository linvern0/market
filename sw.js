// Do'kon Boshqaruvi — Service Worker
// Vazifasi: ilova "qobig'i"ni (HTML/JS/CSS/ikonkalar) keshlab, internet
// yo'qolganda ham ilova DARHOL ochilishini ta'minlash. E'TIBOR: Firestore
// ma'lumotlari (mahsulotlar, savdolar va h.k.) bu yerda KESHLANMAYDI — ular
// allaqachon ilova ichida `persistentLocalCache` orqali offline saqlanadi.
// Bu service worker faqat statik fayllarga tegishli.

const CACHE_VERSION = 'dokon-shell-v1';
const RUNTIME_CACHE = 'dokon-runtime-v1';

// Ilova qobig'i uchun asosiy fayllar. Fayl nomi boshqacha bo'lsa
// (masalan index.html o'rniga boshqa nom), shu ro'yxatni moslashtiring.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-72.png',
  './icon-96.png',
  './icon-128.png',
  './icon-144.png',
  './icon-152.png',
  './icon-192.png',
  './icon-384.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Har bir faylni alohida qo'shamiz — agar biror ikonka hali mavjud
      // bo'lmasa (masalan hali yuklanmagan bo'lsa), shu bitta fayl xatosi
      // BUTUN o'rnatishni buzib qo'ymasin.
      Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Firebase/Firestore/Google API so'rovlarini HECH QACHON keshlamaymiz —
// ular doim tarmoqdan (yoki Firestore'ning o'z offline keshidan) borishi
// kerak, aks holda eski/yolg'on ma'lumot ko'rsatilib qolishi mumkin.
function isBypassRequest(url) {
  return (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('gstatic.com') && url.pathname.includes('firebase')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (isBypassRequest(url)) return; // tarmoqqa to'g'ridan-to'g'ri o'tkazamiz

  // Ilova qobig'i (o'zimizning domenimiz): cache-first, keyin tarmoqdan
  // yangilab, keshni fon rejimida yangilaymiz (stale-while-revalidate).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const clone = networkRes.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
            }
            return networkRes;
          })
          .catch(() => cached); // internet yo'q bo'lsa, keshdagisi bilan qolamiz
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Tashqi statik kutubxonalar (xlsx/jspdf/jsbarcode/qrcode CDN): keshdan
  // tez ber, fonda yangilab tur — internetsiz holatda ham eksport/chop
  // etish funksiyalari ishlashda davom etsin.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Ilova yangi versiyasi tayyor bo'lganda, sahifa "SKIP_WAITING" xabarini
// yuborsa, darhol faollashtiramiz (foydalanuvchi tugma bosganda yangilanish
// uchun ishlatilishi mumkin).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
