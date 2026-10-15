# Upgrade v6 — o'zgarishlar ro'yxati

## Xavfsizlik / xatolar
- `telegram-webhook.js`, `notify-cron.js`: maxfiy tokenlar endi timing-hujumga chidamli (`timingSafeEqual`) taqqoslanadi.
- Barcha API: xato javoblarida ichki xato matni (`String(e)`) chiqmaydi, `server_error` + HTTP 500 qaytadi (avval 200 edi).
- `whoami`, `miniapp-data`, `miniapp-action`: `initData`/`action` turi va hajmi tekshiriladi (400 bad_request).
- `vercel.json`: `nosniff`, `Referrer-Policy`, `Permissions-Policy` (kamera/USB/serial faqat o'z saytiga), `/api/*` uchun `no-store`.
- **SW bug (offline):** Firebase JS modullari va shriftlar avval keshlanmasdi — internetsiz ilova ochilmasdi. Tuzatildi.

## Tezlik
- Service worker: `stale-while-revalidate` (1.3 MB sahifa keshdan darhol ochiladi), navigation preload, kesh hajmi cheklangan.
- `modulepreload` (Firebase), CDN `preconnect`, statik rasmlarga `loading="lazy"`.
- `index.html` HTML `must-revalidate` — har doim yangilanish tekshiriladi.

## Mobil UX
- iOS'da input fokusida avtomatik zoom yo'q (16px), 44px teginish maydoni, safe-area, `touch-action`, `focus-visible`, `prefers-reduced-motion`, bosib chiqarishda ranglar saqlanadi.

## Hali qilinmagan (katta ish, ruxsatsiz tegmadim)
1. **Eng muhim:** `dokon/settings` (bot tokeni, sotuvchi PIN'lari ochiq matnda) brauzerdan o'qiladi. Firebase Authentication + Firestore Rules + PIN'larni hash qilish kerak.
2. `index.html` 22 540 qator — modullarga bo'lish va minifikatsiya (build bosqichi).
3. PIN kiritishda urinishlar limiti (brute-force) serverda yo'q.
4. `TELEGRAM_WEBHOOK_SECRET` va `CRON_SECRET` Vercel'da o'rnatilmagan bo'lsa tekshiruv o'chiq — ikkalasini o'rnating.
