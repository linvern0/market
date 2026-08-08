# Qarz boshqaruvi + Xavfsizlik/rollar — kengaytirish (yakuniy holat)

Siz tanlagan 3 ta yo'nalish: **💳 Qarz boshqaruvi**, **🤖 Telegram bot**,
**🔐 Xavfsizlik/rollar**. Bu bosqichda **`index.html` (asosiy admin panel)**
ham to'liq yangilandi — server, bot va endi admin panelning HAMMASI bir xil
mantiq bilan ishlaydi.

## ✅ YANGI (shu bosqichda qo'shildi): `index.html`

### 1. Qarz limiti — endi ikkala oynada ham to'liq ishlaydi
- `modal-debt` (Qarzga sotish) — ilgari qo'shilgan edi, endi `forceOverLimit`
  bayrog'i to'g'ri tekshiriladi (ilgari limitdan oshganda tasdiqlash oynasi
  IKKI MARTA chiqib ketardi — tuzatildi).
- `modal-cash-loan` (Kassadan naqd pul qarzga berish) — `doCashLoan()`ga
  `doDebtSell()` bilan AYNAN bir xil limit tekshiruvi va ogohlantirish/
  tasdiqlash oqimi qo'shildi. Limitdan oshsa, admin ataylab tasdiqlamasa
  (`forceOverLimit`), amal bajarilmaydi.
- Ikkala oynada ham `openXModal()` funksiyalari endi `dueDate`/`creditLimit`
  maydonlarini va ogohlantirish blokini har safar to'g'ri tozalaydi.

### 2. Muddat ko'rsatkichlari (`renderDebts`)
- Har bir faol (to'lanmagan) qarz yozuvida, agar `dueDate` belgilangan
  bo'lsa, holat belgisi (⏳/⏰) yonida qo'shimcha 🔴 muddat o'tgan / 🟠 muddat
  bugun / 🟡 muddat N kundan so'ng belgisi ko'rsatiladi.

### 3. 🗓 Muddat kalendari (yangi panel)
- Qarzlar sahifasida yangi "🗓 Muddat kalendari" tugmasi — muddati
  belgilangan barcha faol qarzlarni muddat bo'yicha o'sish tartibida
  ko'rsatadigan modal oyna. Har bir yozuv yonida tezkor "✅ To'landi"
  tugmasi bilan (bot bilan bir xil UX).

### 4. Sozlamalar — qarz limiti va eslatma jadvali
- Sozlamalar sahifasiga 💳 "Standart qarz limiti" va 🔔 "Qarz eslatma
  jadvali" (`debtReminderOffsets`, masalan `-3,-1,0,3,7`) uchun kiritish
  maydonlari va saqlash tugmalari qo'shildi. Ilgari bu qiymatlar faqat
  DB holatida/serverda mavjud edi, admin panelidan kiritib bo'lmasdi.

### 5. 🔐 Admin huquqlari (checkboxlar)
- Sozlamalar > Telegram > adminlar ro'yxatida, `admin` (owner emas)
  rolidagi har bir shaxs yonida yangi "🔐 Huquqlar" tugmasi — 8 ta huquqni
  (`api/_permissions.js`dagi `PERMISSION_KEYS` bilan AYNAN mos) yoqish/
  o'chirish uchun checkboxli modal oyna. Owner har doim hammasiga ruxsatli
  bo'lgani uchun bu tugma faqat `admin` rol uchun ko'rinadi.

### 6. 📜 Amallar jurnali (yangi, alohida panel)
- Sozlamalar sahifasida yangi karta: "📜 Amallar jurnali (bot + panel)" —
  Firestore `actionLogs` to'plamini (server `api/_audit.js` orqali
  yoziladigan, Telegram bot + Mini App + admin panelning HAMMASIDAN kelgan
  yozuvlar) real vaqtda ko'rsatadi. Manba bo'yicha filtrlash mumkin (🤖 bot /
  📱 Mini App / 💻 panel). **Diqqat**: bu ESKI, faqat index.html'dan
  bajarilgan ba'zi amallarni ko'rsatuvchi `auditLog` panelidan ("📜 Amallar
  tarixi (audit)") butunlay ALOHIDA — ular ARALASHTIRILMAGAN, ikkalasi ham
  saqlanib qoldi.

## ✅ Ilgari tayyor bo'lgan qism (server, `api/`) — o'zgarishsiz
Qarang: qarz limiti (`api/miniapp-action.js`), ko'p bosqichli eslatma
jadvali (`api/notify-cron.js`), batafsil admin huquqlari
(`api/_permissions.js`), amallar jurnali (`api/_audit.js`), Telegram bot
buyruqlari (`api/telegram-webhook.js`: `/muddatlar`, `/admin_huquq`,
`hasPermission()` asosidagi tekshiruv). Bularning barchasi ilgari
tayyorlangan va bu bosqichda TEGILMAGAN — faqat index.html ularga mos
UI bilan ulandi.

## Tekshiruv
- `index.html`dagi asosiy `<script type="module">` bloki `node --check`
  orqali sintaksis xatosiz ekanligi tasdiqlandi.
- Barcha yangi `<div>` teglar mos yopilgan (ochilish/yopilish soni teng).
- Yangi funksiya/nom to'qnashuvi yo'q (har bir yangi funksiya nomi bitta
  marta e'lon qilingan).

## Nima o'zgardi (fayllar)
- **Faqat `index.html` o'zgardi** — boshqa hech qanday fayl (shu jumladan
  `api/*.js`) bu bosqichda tegilmagan, avvalgi funksionallik saqlanib qoldi.

## Keyingi ixtiyoriy qadamlar (agar kerak bo'lsa)
- "Ovozli/rasmli buyurtma" — hali ishlanmagan (avvalgi holatdagidek).
- `actionLogs` panelida qo'shimcha filtrlar (masalan sana oralig'i,
  amal turi bo'yicha) — hozircha faqat manba (source) bo'yicha filtr bor.
- Amallar jurnali/muddat kalendari uchun CSV eksport — so'ralsa qo'shish
  mumkin.


## ✅ YANGI (shu bosqichda qo'shildi): Telegram bot (`api/telegram-webhook.js`)
- `api/_permissions.js` va `api/_audit.js` ulandi.
- Eski ikki darajali `OWNER_ONLY_COMMANDS` tekshiruvi olib tashlandi,
  o'rniga `COMMAND_PERMISSIONS` xaritasi + `hasPermission()` orqali
  BATAFSIL tekshiruv: `/tolov`, `/qarz_qoshish` → `manageDebts`;
  `/tovar_narx` → `manageProducts`; `/broadcast` → `broadcast`;
  `/admin_qoshish`, `/admin_ochirish`, `/admin_rol`, `/admin_huquq` →
  `manageAdmins`. Owner har doim hammasiga ruxsatli, oddiy admin faqat
  unga berilgan huquqlar doirasida (owner buni faqat Firestore konsolidan
  yoki botning yangi `/admin_huquq` buyrug'i orqali sozlay oladi — hali
  index.html'dan emas).
- Yangi **`/muddatlar`** buyrug'i — muddati belgilangan (`dueDate`) faol
  qarzlarni muddat bo'yicha o'sish tartibida, 🔴 o'tgan / 🟠 bugun / 🟡
  kutilayotgan belgilari bilan ko'rsatadi, har biri yonida tezkor "✅
  to'landi" tugmasi bilan. Tugmali menyuga (`/menu`) va yordam matniga
  (`/yordam`) ham qo'shildi.
- Yangi **`/admin_huquq <chatId/@username/tel> <huquq> <yes|off>`**
  buyrug'i — bitta adminning bitta huquqini bot orqali yoqish/o'chirish
  (index.html oynasi tayyor bo'lmaguncha, huquqlarni sozlashning yagona
  yo'li — Firestore konsolidan tashqari).
- Muhim amallar endi `actionLogs` jurnaliga avtomatik yoziladi: `/tolov`,
  `/qarz_qoshish`, `/tovar_narx`, `/broadcast`, `/admin_qoshish`,
  `/admin_ochirish`, `/admin_rol`, `/admin_huquq`, va tezkor "✅ to'landi"
  (`pay_full`) tugmasi. Tezkor to'lov tugmasi endi `manageDebts` huquqini
  ham talab qiladi (ruxsatsiz admin bosolmaydi).
- Sintaksis tekshiruvidan o'tdi (`node -c` — xatosiz), eski funksionallik
  (barcha avvalgi buyruqlar, /qarzlar, /statistika va h.k.) saqlanib qoldi.

## ✅ Tayyor bo'lgan qism (server, `api/`)

### 1. Qarz limiti (`💳 Qarz boshqaruvi`)
- Har bir qarzdorda `creditLimit` (so'mda) — 0/bo'sh = cheklovsiz.
- Sozlamalarda `defaultCreditLimit` — limit belgilanmagan qarzdorlar uchun
  umumiy standart.
- `sell` (qarzga sotish) va `cash_loan` (naqd pul qarzga berish)
  amallarida endi: joriy to'lanmagan qarz + yangi summa limitdan oshsa,
  amal **409 xatolik** (`credit_limit_exceeded`) bilan rad etiladi — faqat
  `forceOverLimit:true` yuborilsa (ya'ni admin ataylab tasdiqlasa) baribir
  bajariladi. Fayl: `api/miniapp-action.js`.

### 2. Ko'p bosqichli avto-eslatma jadvali (`💳 Qarz boshqaruvi`)
- Ilgari `dueDate` (muddat) belgilangan qarz uchun FAQAT bitta eslatma
  yuborilardi (muddat kunida/o'tganida). Endi `debtReminderOffsets`
  sozlamasi orqali butun jadval belgilanadi — masalan `[-3,-1,0,3,7]`
  (muddatdan 3 va 1 kun OLDIN, muddat kunida, 3 va 7 kun O'TGACH). Har bir
  bosqich faqat bir marta yuboriladi (`debt.remindersSent` massivida
  saqlanadi). Standart (sozlanmagan bo'lsa): `[0, 3, 7]`.
  Fayl: `api/notify-cron.js`.

### 3. Batafsil admin huquqlari (`🔐 Xavfsizlik/rollar`)
- Yangi fayl `api/_permissions.js` — 8 ta alohida huquq:
  `manageProducts, manageDebts, manageCustomers, manageStaff,
  deleteRecords, broadcast, manageSettings, manageAdmins`.
- `owner` — har doim hammasiga ruxsatli. `admin` — standart holatda faqat
  kundalik amallar (tovar/qarz/mijoz), o'chirish/xodim/admin/sozlama/
  broadcast — o'chirilgan holda, owner buni o'zgartira oladi.
- `api/miniapp-action.js`dagi deyarli BARCHA amal (tovar qo'shish/
  o'chirish, qarz, mijoz, xodim, admin, sozlama) endi shu huquqni
  tekshiradi — ruxsat yo'q bo'lsa `403 no_permission` qaytaradi.
- Yangi amal: `update_admin_permissions` — bitta adminning rolini/
  huquqlarini o'zgartirish uchun (o'chirib qayta qo'shmasdan).

### 4. Amallar jurnali — audit log (`🔐 Xavfsizlik/rollar`)
- Yangi fayl `api/_audit.js` — `actionLogs` to'plamiga yozadi (kim,
  qachon, qaysi amal, tafsilot).
- `api/miniapp-action.js`dagi muhim amallar (o'chirish, to'lov, qarz
  yozish, sozlama o'zgartirish, admin/xodim boshqarish, coin tuzatish)
  endi shu jurnalga avtomatik yoziladi.
- ✅ Endi index.html'da ham ko'rsatiladi — "📜 Amallar jurnali (bot + panel)"
  paneli (Sozlamalar sahifasi), real vaqtda, manba bo'yicha filtrlash bilan.

## Yakuniy fayllar holati
- **Yangi**: `api/_permissions.js`, `api/_audit.js` (avvalgi bosqichda).
- **O'zgardi**: `api/miniapp-action.js`, `api/miniapp-data.js`,
  `api/notify-cron.js`, `api/telegram-webhook.js` (avvalgi bosqichda) va
  endi **`index.html`** (bu bosqichda — yuqoridagi 6 bo'limga qarang).
- **Tegilmagan**: `miniapp.html`, boshqa barcha fayllar.

✅ **Barcha 3 ta yo'nalish (💳 Qarz boshqaruvi, 🤖 Telegram bot, 🔐 Xavfsizlik/
rollar) bo'yicha rejalashtirilgan ish — server, bot va admin panel (index.html)
darajasida — TO'LIQ yakunlandi.**
