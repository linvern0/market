# index.html: real-vaqtli tinglovchilarni "oynali" qilish (Firestore usage'ni kamaytirish)

Bu o'zgarish avvalgi `OZGARISHLAR_VA_KEYINGI_QADAMLAR.md` faylida
tavsiflangan, lekin SINOVSIZ joylashtirilishi xavfli deb qoldirilgan
qismni amalga oshiradi: `index.html`dagi `sales`, `restocks`, `expenses`
uchun **cheklanmagan** real-vaqtli tinglovchilar (`onSnapshot`) endi
faqat **so'nggi 120 kunni** o'qiydi, eski ma'lumot esa faqat haqiqatda
kerak bo'lganda (bir marta) alohida so'rov bilan yuklanadi.

**Faqat `index.html` o'zgardi.** Boshqa hech qanday faylga tegilmadi.

## Nima o'zgardi — mexanizm

Fayl boshida (`startListeners()`dan oldin) yangi blok qo'shildi:

- `HISTORY_WINDOW_DAYS = 120` — real-vaqtli oyna uzunligi (kerak bo'lsa
  shu bitta raqamni o'zgartirish kifoya).
- `historyWindowCutoffISO()` — oyna boshlanish sanasi.
- `_extraHistoryState` / `mergedHistory(name)` / `ensureHistoryLoaded(name, fromISO)`
  — oynadan eski yozuvlarni on-demand yuklab, keshlab beradigan umumiy
  mexanizm (`sales`, `restocks`, `expenses` uchun alohida-alohida).
- `ensureEarliestSaleYear()` — Tarix sahifasidagi "Yil" filtri uchun,
  BUTUN tarixni yuklamasdan, do'konning eng birinchi savdo yilini bitta
  yengil so'rov bilan aniqlaydi.

`sales`/`restocks`/`expenses` uchun `onSnapshot` endi
`where('date','>=', cutoff)` bilan chaqiriladi. Ilova ochilishidagi
dastlabki tezkor `getDocs` (bu ham ilgari BUTUN to'plamni o'qirdi) ham
xuddi shu oyna bilan cheklandi.

## Funksionallik SAQLANDI — quyidagilar aniq tekshirildi va tuzatildi

Kod bo'ylab `DB.sales`/`DB.restocks`/`DB.expenses`ga bevosita murojaat
qiladigan HAR BIR joy ko'rib chiqildi. Kundalik/tahliliy funksiyalar
(dashboard grafiklar, AI tahlilchi, savdo taqqoslash va h.k.) hammasi
≤60 kunlik oralig'da ishlaydi — 120 kunlik oyna ichida, o'zgarishsiz
qoldi. Quyidagi joylar esa ANIQ eski/butun tarixga muhtoj edi va
on-demand yuklashga ulandi:

- **Tarix (Savdo) sahifasi**: sana/yil filtri, CSV/Excel/PDF eksport,
  chop etish, eski chekni qayta chop etish va eski savdoni qaytarish
  (`adminRevertGroup`, `revertSaleGroup`, `printGroupReceipt`).
- **Kirim-Chiqim (Stock history)**: erkin sana filtri va "Barchasi",
  CSV/Excel eksport (bu ikkalasi har doim BUTUN tarixni eksport qiladi).
- **Xarajatlar sahifasi**: "Barchasi" filtri, eski xarajatni
  tahrirlash/o'chirish.
- **Bosh sahifa (Dashboard) va Foyda sahifasi**: ikkalasida ham
  "Hammasi" (butun vaqt) tanlovi bor — bu ENG XAVFLI joy edi, chunki
  agar unutilib qolsa, "Hammasi" tanlanganda savdo/foyda summasi
  JIM (hech qanday xato ko'rsatmasdan) noto'g'ri — faqat so'nggi 120
  kunlik — chiqib turardi. `renderDashboard`, `exportDashboardPDF`,
  `renderProfit`, `exportProfitPDF` (shu jumladan foyda sahifasidagi
  "sof foyda" xarajatlar bloki) — barchasi endi "Hammasi" tanlanganda
  avval to'liq tarixni yuklaydi.
- **To'liq zaxira nusxa (`exportFullBackup`)**: eng muhimi — bu endi
  backup olishdan OLDIN sales/restocks/expenses'ning to'liq tarixini
  majburiy on-demand yuklaydi. Aks holda zaxira nusxa jim ravishda
  faqat so'nggi 120 kunni saqlagan bo'lardi.

## Sinovsiz qoldirilgan narsa yo'q, LEKIN

- Bu o'zgarish sizning HAQIQIY Firebase bazangiz ustida ishga
  tushirilmagan/sinalmagan (men faqat kodni ko'rdim). `node --check`
  bilan barcha JS sintaksisi (shu jumladan `api/*.js` fayllari ham)
  xatosiz ekani tasdiqlandi — lekin bu mantiqiy xatolarni kafolatlamaydi.
- Firestore composite index kerak bo'lishi mumkin: `where('date','>=',...)`
  so'rovlari odatda avtomatik indekslanadi, lekin agar konsolda
  "index kerak" degan xatolik chiqsa, Firebase konsoli o'zi to'g'ridan
  havola berib, bir bosishda indeks yaratishni taklif qiladi.
- **Tavsiya**: bu faylni alohida branch/staging’da joylashtiring va
  quyidagilarni qo'lda sinab ko'ring:
  1. Yangi savdo/kirim/xarajat qo'shish — real-vaqtda ko'rinishi kerak.
  2. Tarix sahifasida 120 kundan eski sana yoki yil tanlash — bir oz
     kutish (yuklanish) bilan eski ma'lumot chiqishi kerak.
  3. Dashboard/Foyda sahifasida "Hammasi"ni tanlash — to'liq (butun
     davr) summalar chiqishi kerak, faqat so'nggi 120 kun emas.
  4. "Zaxira nusxa yuklab olish" — yuklab olingan JSON faylni ochib,
     `cloud.sales.length` (va h.k.) sonini avvalgi (eski) zaxira
     nusxadagi son bilan taqqoslang.
  5. 120 kundan eski bitta savdoni Tarix orqali qaytarish (revert) va
     chekni qayta chop etish.

## Deploy

Faqat `index.html` ni eski fayl ustidan almashtiring. Yangi environment
variable yoki Firestore qoidalarini o'zgartirish shart emas.
