# Telegram Mini App — o'rnatish

## YANGILANISH (ushbu versiyada)

1. **Qarzdorlar endi tugmasiz, avtomatik aniqlanadi.** "Telefon raqamimni yuborish" tugmasi butunlay olib tashlandi. Qarzdor botga `/start` yozganda:
   - Avval **Telegram username** bo'yicha (agar admin uni qarzdor kartochkasida kiritgan bo'lsa),
   - Bo'lmasa **Telegram ID** bo'yicha (agar admin uni kiritgan bo'lsa) avtomatik tanib olinadi.
   - Ikkalasi ham kiritilmagan bo'lsa, botga yozgan kishiga o'zining username/ID'sini ko'rsatadi — buni administratorga berib, Mini-ilova orqali "Qarzdorlar" bo'limida shu ma'lumot bilan ro'yxatga qo'shsangiz bo'ldi.
   - **Muhim:** qarzdor qo'shayotganda kamida bittasini (username yoki Telegram ID) to'ldiring — aks holda avtomatik tanib olinmaydi (Telegram bot API foydalanuvchi ruxsatisiz telefon raqamini bermaydi, shuning uchun username/ID orqali ishlaydi).

2. **Kassadan naqd pul qarzga berish.** "Qarzlar" bo'limida yangi "💵 + Naqd pul qarz" tugmasi — tovar tanlanmaydi, faqat summa kiritiladi va shu odamga qarz sifatida yoziladi (Firestore'dagi bir xil `debts` va yangi `cashLoans` kolleksiyalarida saqlanadi, shuning uchun bir xil Firebase bazasidan foydalanadigan veb-loyihangizda ham ko'rinadi).

3. **To'lov muddati va avtomatik eslatma.** Qarzga sotishda yoki naqd pul qarz berishda ixtiyoriy "muddat" sanasi belgilanishi mumkin. Muddat kelgan/o'tgan kunda `notify-cron.js` orqali qarzdorga (agar botga ulangan bo'lsa) avtomatik eslatma yuboriladi — kuniga bir marta.

4. **Statistika grafigi, Excel eksport, to'liq tarix.** Bosh sahifada oxirgi 7 kunlik savdo grafigi, "Qarzlar" bo'limida CSV/Excel eksport tugmasi, qarzdor tomonida esa "Faol / Tarix" almashtirgichi va to'lovlar tarixi qo'shildi.

5. **Muhim:** `api/_miniapp-auth.js` fayli avvalgi arxivda yo'q edi — bu versiyada qayta tiklandi. Agar repongizda undan boshqacha versiyasi bo'lsa, ikkalasini solishtirib ko'ring.



Fayllar:
- `miniapp.html` — Mini App interfeysi. **Admin** uchun to'liq boshqaruv paneli: Bosh sahifa (statistika), Sotish (naqd/qarzga), Qarzlar (to'lov + eslatma yuborish), Tovarlar (qo'shish/tahrirlash/o'chirish/kirim), Qarzdorlar (qo'shish/tahrirlash, Telegram username va ko'rish huquqi), Sozlamalar (do'kon nomi, valyuta, bildirishnomalar, adminlar). **Qarzdor/mijoz** uchun — o'z qarzi va har bir qarz nima uchun (qaysi tovarlar) kelib chiqqani batafsil ko'rinadi.
- `api/miniapp-data.js` — ma'lumot beruvchi API
- `api/miniapp-action.js` — admin uchun barcha yozish amallari (to'lov, tovar, sotish, qarzdor, sozlama, admin boshqaruvi)
- `api/_miniapp-auth.js` — Telegram initData'ni xavfsiz tekshirish
- `api/telegram-webhook.js` — botga "📱 Mini-ilovani ochish" tugmasi va `/ilova` buyrug'i

**Yangi environment variable shart emas** — mavjud `FIREBASE_SERVICE_ACCOUNT` va `TELEGRAM_WEBHOOK_SECRET` yetarli.

## Qarzdorning ko'rish huquqi (viewScope) — muhim

Har bir qarzdor yozuvida endi **"Ko'rish huquqi"** tanlanadi:
- **Faqat o'zining qarzi (own, standart)** — tashkilotga tegishli bo'lsa ham, shu odam FAQAT o'ziga yozilgan qarzlarni ko'radi.
- **Butun tashkilot qarzi (org)** — bu odam (masalan buxgalter yoki tashkilot rahbari) tashkilotning BARCHA xodimlari bo'yicha taqsimlangan to'liq qarz ro'yxatini ko'radi.

Bitta tashkilotdagi oddiy xodimga faqat o'z ismi va Telegram username'ini kiriting (ko'rish huquqi — "Faqat o'zining"). Butun tashkilot balansini ko'rishi kerak bo'lgan shaxsni esa ALOHIDA qarzdor sifatida kiriting va unga "Butun tashkilot" huquqini bering.

## O'rnatish qadamlari

1. Ushbu fayllarni GitHub repo'ingizga qo'shing (eski fayllar ustidan yozadi) va push qiling — Vercel avtomatik qayta deploy qiladi.

2. Deploy tugagach botga `/start` (yoki `/ilova`) yozing — endi "📱 Mini-ilovani ochish" tugmasi chiqadi.

3. (Ixtiyoriy, tavsiya etiladi) — botning doimiy **Menu Button**ini ham Mini App'ga bog'lash uchun, brauzerda (BOT_TOKEN'ni almashtirib) quyidagi so'rovni yuboring:
```
https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton?menu_button={"type":"web_app","text":"Ilova","web_app":{"url":"https://SIZNING-DOMEN.vercel.app/miniapp.html"}}
```

## Qarzdorlarga yuboriladigan xabarlar

Qarzga sotilganda, eslatma yuborilganda va ro'yxatdan o'tishda qarzdorga yuboriladigan Telegram xabarlarida endi **har bir qarz uchun qaysi tovar, necha dona va qancha narxda sotilgani** ko'rsatiladi (izoh bo'lsa — u ham). Mini ilova ichida ham har bir qarz yozuvi ostida shu tafsilot ko'rinadi.

## Xavfsizlik haqida
`miniapp-data.js` va `miniapp-action.js` ochiq (public) manzillar, lekin ular faqat Telegram bot orqali yuborilgan, bot tokeni bilan raqamli imzolangan (`initData`) so'rovlarnigina qabul qiladi — soxta so'rovlar avtomatik rad etiladi. Yozish amallari (`miniapp-action.js`) qo'shimcha ravishda faqat admin ro'yxatidagi `chatId`lardan kelgan so'rovlarga ruxsat beradi. Bot tokeni xavfsizlik uchun mini ilova orqali o'zgartirilmaydi.
