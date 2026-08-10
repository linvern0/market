# V4'da nima o'zgardi

Bu safar navbatdagi ikkita band bajarildi: **`report.html`** va
**`api/notify-cron.js`**. (`debt.html` tekshirildi — u allaqachon har bir
qarzdor/tashkilot uchun `where()` bilan cheklangan so'rov ishlatadi, hech
qanday muammo topilmadi, TEGILMAGAN.)

## 1) report.html — savdo tarixi

Muammo: `onSnapshot(collection(db,'sales'), ...)` — do'kon tarixidagi
**BARCHA** savdolarni, filtrsiz, real vaqtda kuzatib turardi. Sahifa har
ochilganda (yoki ulanish tiklanganda) shuncha hujjat qayta o'qilardi —
`index.html`da avval tuzatilgan MUAMMONING AYNAN O'ZI.

Yechim — `index.html`dagi bilan bir xil naqsh:
- Real-vaqt tinglovchi endi faqat so'nggi **120 kunni** kuzatadi
  (`where('date','>=', cutoff)`). Bugun/Kecha/Bu hafta/Bu oy filtrlari
  shu bilan to'liq ishlaydi — o'zgarish sezilmaydi.
- "Hammasi" tugmasi yoki 120 kundan eski sana tanlansa (custom oraliq),
  bir martalik `getDocs()` bilan to'liq tarix yuklanadi va xotiradagi
  ro'yxatga qo'shiladi (`ensureFullSalesLoaded()`).
- CSV eksport ham xuddi shunday — eksport qilinayotgan davr eski bo'lsa,
  avval to'liq tarix yuklanadi, keyin eksport qilinadi (hech qanday
  ma'lumot qirqilib qolmaydi).

`products`, `debts`, `debtors` — bu sahifada ham `index.html`dagidek
TEGILMAGAN qoldi (ular tabiiy ravishda cheklangan hajmda: faqat aktiv
tovar/qarz soni bilan o'sadi, sotuv tarixi kabi cheksiz o'smaydi).

## 2) api/notify-cron.js — kunlik bildirishnoma

Bu fayl kuniga FAQAT 1 marta ishga tushadi (Vercel Cron), lekin 3 ta
kolleksiyani KERAKSIZ TO'LIQ o'qirdi:

- **`sales`** — kunlik hisobot uchun FAQAT bugungi savdolar kerak edi,
  lekin BUTUN tarix o'qilardi. TUZATILDI: endi
  `where('date','>=', bugun 00:00).where('date','<=', bugun 23:59)`
  bilan faqat bugungi hujjatlar so'raladi.
- **`customers`** — "yangi mijozlar (bugun / so'nggi 7 kun)" statistikasi
  uchun BUTUN mijozlar bazasi o'qilardi. TUZATILDI: endi
  `where('createdAt','>=', 7 kun oldin)` bilan faqat kerakli oynadagi
  yozuvlar so'raladi.
- **`debts`** (muddati o'tgan qarzlar bo'limi) — to'langan qarzlar ham
  o'qib, keyin xotirada `!d.paid` bilan filtrlanardi. TUZATILDI: endi
  `where('paid','==', false)` bilan to'g'ridan-to'g'ri Firestore
  darajasida filtrlanadi.

Bularning barchasi do'kon qancha katta/eski bo'lsa, shuncha ko'p
tejaydi — chunki avvalgi versiya har kuni BUTUN tarixni qayta o'qirdi,
endi esa faqat kerakli qismini.

## MUHIM: simple.html haqida topilma (sizning qaroringiz kerak)

`simple.html` (678 KB) ham `index.html`dagi ESKI (tuzatilmagan)
naqshning aynan o'zini ishlatadi — `sales`/`restocks`/`expenses`
kolleksiyalarini har doim to'liq, cheklanmagan o'qiydi/tinglaydi.

Lekin men tekshirdim — bu fayl:
- `vercel.json`da yo'q,
- `sw.js` (Service Worker) keshida yo'q — faqat `index.html` ilova
  "qobig'i" sifatida keshlangan,
- boshqa hech qanday `.html` yoki `api/*.js` faylidan unga havola yo'q.

Ya'ni bu — ehtimol eski, ARXIV nusxa, hech kim unga havola orqali
kirmaydi (faqat to'g'ridan-to'g'ri URL manzilini bilib, qo'lda ochsa
kirish mumkin). Shuning uchun uni ULKAN faylni qayta yozib xato
xavfini oshirish o'rniga, TEGMASDAN qoldirdim.

**Savol sizga**: bu faylni siz haliyam ishlatasizmi (masalan zaxira
sifatida, yoki boshqa domendan alohida)? Agar YO'Q bo'lsa — eng yaxshi
yechim uni loyihadan butunlay O'CHIRISH (Firestore xarajatiga ta'sir
qilmasa ham, keraksiz murakkablik va kelajakda adashtirib yuborish
xavfini kamaytiradi). Agar HA, ishlatilsa — xabar bering, shu safargi
`report.html`dagi bilan bir xil tuzatishni unga ham qo'llab, alohida
zip qilib beraman.

## Fayllar

- `_firebase.js`, `telegram-webhook.js`, `miniapp-data.js`,
  `miniapp-action.js` — V3'dan (o'zgarmagan, o'sha holatda qoladi).
- `report.html` — YANGI (shu safar tuzatildi).
- `api/notify-cron.js` — YANGI (shu safar tuzatildi).
- `simple.html` — TEGILMAGAN (yuqoridagi savolga javobingizga bog'liq).

## Preview'da sinash kerak bo'lgan narsalar (v4)

1. `report.html`: Bugun/Kecha/Bu hafta/Bu oy filtrlari to'g'ri
   ishlashi.
2. `report.html`: "Hammasi" tugmasi bosilganda ESKI (120 kundan
   oldingi) savdolar ham ko'rinishi (bir zumlik yuklanish bo'lishi
   mumkin — bu normal).
3. `report.html`: eski davr uchun CSV eksport qilinganda hammasi
   to'liq chiqishi.
4. Ertalab cron ishlaganda (yoki qo'lda Vercel'dan "Run" qilib)
   bildirishnomalar avvalgidek to'g'ri kelishi (kam qolgan tovar,
   muddati o'tgan qarz, kunlik hisobot, yangi mijozlar soni).
