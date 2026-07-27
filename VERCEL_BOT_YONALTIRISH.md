# Telegram botni Vercel'da 24/7 (BEPUL, kartasiz) ishlatish

## Nima uchun bu ishlaydi?

Eski usul (`scripts/telegram-bot.js` + GitHub Actions) har necha daqiqada
"uyg'onib" Telegram'ni so'rab turardi (polling) — shu sabab ba'zan
kechikkan/to'xtab qolgan.

Yangi usul ikkita Vercel serverless funksiyasidan iborat:

1. **`api/telegram-webhook.js`** — Telegram har bir yangi xabarni
   TO'G'RIDAN-TO'G'RI shu manzilga yuboradi (webhook). Cron yo'q, polling
   yo'q — funksiya doim tayyor turadi, hech qachon "uxlamaydi".
2. **`api/notify-cron.js`** — kam qolgan tovar, muddati o'tgan qarz va
   kunlik hisobot haqidagi xabarlarni har kuni bir marta (soat 09:00,
   Toshkent vaqti) avtomatik yuboradi. Buni Vercel'ning o'z ichki
   **Cron Jobs** xizmati ishga tushiradi (`vercel.json` ichida
   sozlangan) — Hobby (bepul) rejada kuniga 1 marta cron **bepul**,
   karta shart emas.

`scripts/telegram-bot.js` va `scripts/telegram-notify.js` fayllari endi
ishlatilmaydi (ular GitHub Actions uchun yozilgan eski versiya) — ularni
o'chirib tashlashingiz ham mumkin, xalaqit bermaydi, shunchaki keraksiz.

## 1-qadam: Firebase xizmat hisobi (service account) kaliti olish

1. https://console.firebase.google.com/project/dokon-ce38b/settings/serviceaccounts/adminsdk sahifasiga o'ting.
2. **"Generate new private key"** tugmasini bosing — bitta `.json` fayl
   yuklab olinadi. Buni hech kimga bermang, xavfsiz saqlang.

## 2-qadam: Loyihani GitHub'ga joylash

Agar hali GitHub repo'ga yuklanmagan bo'lsa — shu papkani (`fixed_project`)
yangi GitHub repo qilib yuklang (GitHub Desktop yoki `git` orqali).

## 3-qadam: Vercel'ga ulash

1. https://vercel.com ga kirib, GitHub hisobingiz bilan ro'yxatdan o'ting
   (agar hali yo'q bo'lsa) — **karta so'ralmaydi**.
2. **"Add New..." -> "Project"** -> repo'ingizni tanlang -> **"Import"**.
3. **"Environment Variables"** bo'limiga quyidagilarni qo'shing (Deploy
   tugmasini bosishdan OLDIN):

   | Nomi | Qiymati |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | 1-qadamda yuklab olgan `.json` faylning **butun mazmuni**, bitta qatorga joylab (faylni matn muharririda oching, hammasini nusxa oling, shu yerga joylang) |
   | `TELEGRAM_WEBHOOK_SECRET` | O'zingiz o'ylab topgan, kamida 20-30 belgidan iborat tasodifiy matn (masalan parol generatoridan) |
   | `CRON_SECRET` | Yana bir tasodifiy matn (yuqoridagidan farqli bo'lsin) |

4. **"Deploy"** tugmasini bosing. Bir necha daqiqada tayyor bo'ladi va
   sizga manzil beriladi, masalan: `https://sizning-loyiha.vercel.app`

## 4-qadam: Telegram'ga "shu manzilga xabar yubor" deb aytish

Brauzerda (bir marta) quyidagi manzilga o'ting — o'z qiymatlaringizni
qo'yib (BOT_TOKEN — botingiz tokeni, TELEGRAM_WEBHOOK_SECRET — 3-qadamda
kiritgan matn, VERCEL-MANZIL — o'zingizning `.vercel.app` manzilingiz):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<VERCEL-MANZIL>/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Javobda `"ok":true` chiqsa — tayyor, bot ishga tushdi.

Tekshirish uchun:
```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

## 5-qadam: Eskisini GitHub'dan o'chirish (JUDA MUHIM!)

Webhook va eski "polling" bir vaqtda ishlay olmaydi — ikkalasi ishlasa,
bot ikki marta javob berishi yoki chalkashib ketishi mumkin. Shuning
uchun GitHub repo'ingizda:

- `.github/workflows/` papkasidagi bot polling ishlatuvchi workflow
  faylini (odatda `telegram-bot.yml`, `scripts/telegram-bot.js` ni
  chaqiradigan) **o'chirib tashlang**.
- Agar `telegram-notify.yml` workflow ham bo'lsa, uni ham o'chiring —
  endi bu vazifani Vercel Cron (`api/notify-cron.js`) bajaradi.

## Bildirishnoma vaqtini o'zgartirish

`vercel.json` faylidagi shu qatorni toping:

```json
"schedule": "0 4 * * *"
```

Bu UTC vaqtida "har kuni 04:00" degani — Toshkent vaqti bilan 09:00 ga
teng (Toshkent UTC+5). Boshqa vaqtga o'zgartirish uchun UTC bo'yicha
hisoblang (masalan Toshkent 12:00 kerak bo'lsa — `"0 7 * * *"` yozing).

**Eslatma:** Vercel Hobby (bepul) rejada cron **kuniga faqat 1 marta**
ishga tushishi mumkin — bu cheklov shu tarifning o'zida bor. Agar kunига
bir necha marta kerak bo'lsa, Vercel'ning pullik (Pro) rejasi kerak
bo'ladi. Lekin bitta kunlik hisobot/ogohlantirish uchun 1 marta odatda
yetarli.

O'zgartirgach, GitHub'ga push qilsangiz, Vercel avtomatik qayta deploy
qiladi.

## Xatoliklarni ko'rish (loglar)

Vercel Dashboard -> loyihangiz -> **"Deployments"** -> oxirgi deploy ->
**"Functions"** bo'limidan `telegram-webhook` yoki `notify-cron`
funksiyasining loglarini ko'rishingiz mumkin.

## Xulosa: nima uchun bu bepul va 24/7?

- Vercel Hobby reja — funksiya chaqiruvlari va cron uchun katta bepul
  limit beradi, karta so'ralmaydi.
- Webhook usulida funksiya faqat xabar kelganda ishlaydi (server doim
  "yonib" turishi shart emas) — shuning uchun ham bepul, ham tezkor.
- GitHub Actions'ga umuman bog'liqlik yo'q — repo'da hech narsa "uxlab
  qolmaydi".
