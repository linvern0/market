# Yangi: Coinga sotib olish so'rovlari — endi admin panelida ham

## Muammo nima edi
Mijoz mini-ilova katalogidan bir tovarni to'liq **coin** evaziga sotib olish
so'rovini yuborganda, bu so'rov faqat **Telegram bot xabari** ichidagi
✅ Tasdiqlash / ❌ Bekor qilish tugmalari orqali boshqarilardi. Agar admin
o'sha payt Telegramni ochmagan bo'lsa yoki xabar adashib qolsa, so'rov
ko'rinmasdan qolib ketishi mumkin edi.

## Nima qo'shildi
**`index.html`** — "👥 Mijozlar / Coin" oynasida yangi bo'lim:

- **🪙 Kutayotgan coinga sotib olish so'rovlari** — barcha "pending" holatdagi
  so'rovlar ro'yxati (mijoz ismi, tovar, miqdor, kerakli coin, vaqt).
- Har bir so'rov yonida **✅ Tasdiqlash** / **❌ Bekor qilish** tugmalari —
  bosilganda aniq tasdiqlash oynasi chiqadi.
- Nav menyusidagi "👥 Mijozlar / Coin" tugmasida endi kutayotgan so'rovlar
  soni bilan qizil belgi (badge) ko'rinadi — admin oynani ochmasdan ham
  nechta so'rov borligini biladi.
- Mantiq serverdagi (`api/telegram-webhook.js` → `handleCoinOrderDecision`)
  bilan **bir xil**: tasdiqlansa — tovar ombordan yechiladi, mijozning
  coinidan mos summa ayiriladi, bu **naqd savdo hisobiga yozilmaydi**
  (kunlik tushum/foyda hisobotini buzmasligi uchun), mijozga darhol
  Telegram xabar boradi. Bekor qilinsa — coin/ombor o'zgarishsiz qoladi,
  mijozga xabar boradi.
- Real vaqtda ishlaydi: agar so'rov Telegram orqali (yoki boshqa qurilmada
  admin panelidan) allaqachon hal qilingan bo'lsa, tugma bosilganda
  "allaqachon hal qilingan" deb ogohlantiradi — ikki marta yechilib
  ketmaydi.
- Telegram bot orqali boshqarish **hech qanday o'zgarishsiz, xuddi
  ilgarigidek** ishlayveradi — ikkalasi bir xil `coinOrders` to'plamidan
  o'qiydi/yozadi, shuning uchun qaysi biridan tasdiqlasangiz ham farqi yo'q.

## O'zgargan fayllar
- `index.html`:
  - `window.DB` obyektiga `coinOrders: []` qo'shildi.
  - Yangi Firestore `onSnapshot(collection(db,'coinOrders'), ...)` — real
    vaqtda kutayotgan so'rovlarni kuzatadi.
  - "Mijozlar / Coin" oynasiga yangi `#coin-orders-panel` bo'limi.
  - Nav tugmasiga `#nav-more-coinorders-badge` (son ko'rsatkichi).
  - Yangi funksiyalar: `renderCoinOrdersPanel()`, `updateCoinOrdersBadge()`,
    `confirmCoinOrder(id)`, `cancelCoinOrder(id)`.

Boshqa hech qanday mavjud funksionallikka tegilmadi — `api/*.js` fayllari
va Telegram bot xatti-harakati o'zgarishsiz qoldi.
