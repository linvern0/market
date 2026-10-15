# Upgrade v7 — algoritmlar va hisob-kitob xatolari

## Sotuv (`api/miniapp-action.js` → `sell`)
1. **Ortiqcha sotish (race):** zaxira tekshiruvi va yechish alohida edi. Endi bitta Firestore tranzaksiyasida (`reserveStock`). Test: zaxira 5, parallel 3 ta sotuv (2 tadan) → 2 tasi o'tdi, 1 tasi rad etildi.
2. **Takroriy qatorlar:** bir tovar ikki qatorda yuborilsa omborda borinidan ko'p sotilardi. Endi qatorlar birlashtiladi (`normalizeItems`); qty butun son, 1..1 000 000; maksimum 100 qator.
3. **Yo'qolgan tovar:** "qarzdor topilmadi" va kredit limiti tekshiruvi zaxira yechilgandan KEYIN edi, ombor tiklanmasdi. Endi tekshiruvlar oldin; yozishda xato bo'lsa zaxira va qarz yozuvi qaytariladi.
4. **Sotuv ID:** hujjat ID si va `id` maydoni turlicha edi. Endi bir xil.
5. **Qarzdor nomi:** `trim()` qilinadi (bo'sh joy sabab takroriy qarzdor yaratilmaydi). `dueDate` formati tekshiriladi.
6. Pul summalari 2 xonagacha yaxlitlanadi (`round2`).

## Sotuvni qaytarish (`revert_sale`) — to'liq qayta yozildi
- Bitta tranzaksiya: ikki marta bosilsa ombor 2 marta to'lmaydi.
- Nasiya sotuv qaytarilsa, unga bog'liq qarz yozuvi o'chadi (qarzda to'lov bo'lsa 409 `debt_has_payments`). Yangi qarzlarga `receiptId` yoziladi.
- Naqd sotuvda mijozning coini, jami xaridi va xaridlar soni qaytariladi (manfiyga tushmaydi).

## Buyurtma / coin / to'lov
- `create_order`: dublikat qatorlar, 5 tadan ortiq kutilayotgan buyurtma cheklovi (429), ball balansi tozalanadi.
- `create_coin_order`: kutilayotgan buyurtmalar coini hisobga olinadi (balansdan ko'p buyurtma yig'ib bo'lmaydi).
- Buyurtma tasdiqlashda (`telegram-webhook.js`) balldan to'langan qism yetarli ekani tekshiriladi (balans manfiy bo'lmaydi).
- `pay_debt`: 0.4 so'mlik "nol to'lov" yozilmaydi; `Infinity`/turi noto'g'ri qiymatlar rad etiladi.

## Cron (`notify-cron.js`)
- Sana do'kon vaqt zonasida (`settings.timezone`, standart Asia/Tashkent), avval UTC edi.
- Manfiy zaxira ham "tugagan" hisoblanadi; to'langan (qoldiq ≤ 0.5) qarzlar "muddati o'tgan" ro'yxatiga kirmaydi.

## Umumiy
- `uid()` (server + brauzer): kripto-tasodifiy; bir millisekundda ID to'qnashuvi endi amalda yo'q.
- `fmt()` / `fmt_()`: `NaN` va `-0` ko'rsatilmaydi.
- `isThisWeek`: hafta dushanbadan boshlanadi (avval yakshanba).
- `download()`: object URL bo'shatiladi, Firefox/iOS'da ishlaydi.

## Sinalgan va sinalmagan
Sinalgan: barcha `api/*.js` va inline skriptlar sintaksisi; `normalizeItems`, `reserveStock`, `round2` soxta bazada.
Sinalmagan: haqiqiy Firebase/Telegram bilan `sell` va `revert_sale` to'liq oqimi. Avval test do'konda sinab ko'ring.
