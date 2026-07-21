# Telegram Mini App — o'rnatish

Bu safar qo'shilgan yangi fayllar:
- `miniapp.html` — Mini App interfeysi (admin uchun panel, qarzdor/mijoz uchun `debt.html`dagi kabi tashkilot ko'rinishi)
- `api/miniapp-data.js` — ma'lumot beruvchi API
- `api/miniapp-action.js` — admin uchun yozish amallari (to'lov qo'shish, narx yangilash)
- `api/_miniapp-auth.js` — Telegram initData'ni xavfsiz tekshirish
- `api/telegram-webhook.js` — botga "📱 Mini-ilovani ochish" tugmasi va `/ilova` buyrug'i qo'shildi

**Yangi environment variable shart emas** — mavjud `FIREBASE_SERVICE_ACCOUNT` va `TELEGRAM_WEBHOOK_SECRET` yetarli.

## O'rnatish qadamlari

1. Ushbu fayllarni GitHub repo'ingizga qo'shing (eski fayllar ustidan yozadi) va push qiling — Vercel avtomatik qayta deploy qiladi.

2. Deploy tugagach botga `/start` (yoki `/ilova`) yozing — endi "📱 Mini-ilovani ochish" tugmasi chiqadi. Uni bosganda:
   - **Admin** bo'lsangiz — to'liq boshqaruv paneli (bugungi statistika, faol qarzlar, to'lov qo'shish, ombor holati, narx yangilash) ochiladi.
   - **Qarzdor/mijoz** bo'lsangiz — o'z qarzingiz (agar tashkilot hisobi bo'lsa — `debt.html`dagi kabi xodimlar bo'yicha taqsimlangan holda) ko'rinadi.

3. (Ixtiyoriy, tavsiya etiladi) — botning doimiy **Menu Button**ini ham Mini App'ga bog'lash uchun, brauzerda (BOT_TOKEN'ni almashtirib) quyidagi so'rovni yuboring:
```
https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton?menu_button={"type":"web_app","text":"Ilova","web_app":{"url":"https://SIZNING-DOMEN.vercel.app/miniapp.html"}}
```
Shundan keyin har bir foydalanuvchida yozish maydoni yonida doimiy "Ilova" tugmasi chiqadi (har safar `/ilova` yozish shart emas).

## Xavfsizlik haqida
`miniapp-data.js` va `miniapp-action.js` ochiq (public) manzillar, lekin ular faqat Telegram bot orqali yuborilgan, bot tokeni bilan raqamli imzolangan (`initData`) so'rovlarnigina qabul qiladi — soxta so'rovlar avtomatik rad etiladi. Yozish amallari (`miniapp-action.js`) qo'shimcha ravishda faqat admin ro'yxatidagi `chatId`lardan kelgan so'rovlarga ruxsat beradi.
