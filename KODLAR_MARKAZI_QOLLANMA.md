# Kodlar markazi v2 — qo'llanma

Admin menyusi → **🏷 Kodlar** (telefonda: Yana → Kodlar).

## Nima o'zgardi (qisqacha)
| | Avval | Hozir |
|---|---|---|
| Bir martada kod soni | 1–500 | 1 – 99 999 999 |
| Kodlar saqlanishi | har bir kod bazada alohida kalit (hujjat 1 MiB bilan to'lib qolardi) | **partiya** (~100 bayt) — kodlar hisoblanadi, soni amalda cheksiz |
| Xato himoyasi | yo'q | har bir kodda 2 belgili nazorat (99.9% xatoni darhol ushlaydi) |
| Yorliq rasmi | PNG | **vektor SVG** (har qanday printerda o'tkir), 1 modul tinch zona |
| Termo printer | o'lcham taxminiy | modul **butun nuqtaga** moslanadi (203/300/600 dpi) |
| Katta chop etish | bitta katta ish | **qismlarga** bo'linadi, to'xtab qolsa "Qismdan boshlash" |
| O'lchamlar | 40×30, 58×40, A4 3×8 | 30×20, 40×30, 50×30, 58×40, 70×50, **o'zingiz kiritgan**, A4 (3×8, 3×7, 5×13) |
| Qayta chop etish | 300 tagacha ro'yxatdan belgilash | partiya + **raqam oralig'i**, "faqat sotilmaganlar" |
| Eksport | yo'q | **CSV** (boshqa yorliq dasturlari uchun) |

## 1. Kod formati
`MB-K7QD-0000123-TB`
- `K7QD` — partiya (hamma tovarlar bo'yicha noyob)
- `0000123` — tartib raqami (1 partiyada 9 999 999 tagacha; undan ko'p so'ralsa avtomatik bir nechta partiya)
- `TB` — nazorat belgisi (noto'g'ri o'qilgan/yozilgan/soxta kod mos kelmaydi)

Eski `MC-XXXX-XXXX` kodlari va zavod GS1 DataMatrix kodlari avvalgidek ishlaydi.

## 2. Yangi partiya yaratish
1. Tovarni tanlang, sonni yozing (yoki tezkor tugmalar: 10 … 100 000, "Kodlanmaganlar sonini qo'yish").
2. Kod turi (DataMatrix tavsiya), yorliq o'lchami, printer DPI sini tanlang.
3. **Oldindan ko'rish** va "o'qilish sifati" ni tekshiring (A'lo / Yaxshi / Chegarada / Juda mayda).
4. Tovar omborda allaqachon hisobda bo'lsa — "Omborga ham kirim qilish"ni YOQMANG (faqat kod biriktiriladi).
   Yangi kelgan tovar bo'lsa — yoqing (qoldiq ham oshadi).
5. "Yaratish va chop etish".

> Himoya: partiya kodi bilan sotish uchun tovar qoldig'i 0 dan katta bo'lishi kerak.
> Ya'ni 100 000 ta kod yaratilsa ham, omborda bo'lmagan tovar sotilmaydi.

## 3. Chop etish
- Chop etish oynasida **masshtab 100% / haqiqiy o'lcham**, chekkalar **yo'q** bo'lsin.
- Katta ish qismlarga bo'linadi (termo: 300 yorliq, A4: 8 varaq). Panelda "Chop etish → keyingi qism".
- A4 varaq qisman ishlatilgan bo'lsa — "Ishlatilgan kataklar" ga sonini yozing. Siljisa — "Siljitish" (mm).
- Sozlamalar (tur, o'lcham, DPI, ko'rsatiladigan maydonlar) eslab qolinadi.

## 4. Qayta chop etish / CSV
"Tanlangan tovar partiyalari" → partiyani tanlang → oraliq (dan–gacha) → "Faqat sotilmaganlar" → chop etish yoki CSV.
Kod o'zgarmaydi — yo'qolgan yorliqni aynan o'sha kod bilan qayta chiqarasiz.

## 5. Kodni tekshirish
Skanerlang (📷) yoki yozing: omborda / sotilgan / tizimda yo'q / **kod buzilgan (nazorat belgisi mos emas)**.

## 6. Skanerlash (kamera, USB, Bluetooth)
- Skaner CapsLock, **rus klaviatura tartibi**, tire o'rniga bo'sh joy/pastki chiziq kabi xatolarni avtomatik to'g'rilaydi (MB-/MC- kodlar uchun).
- USB skaner oxirida Enter o'rniga **Tab** yuborsa ham ishlaydi.
- Sotuvda har bir kod faqat bitta marta sotiladi; savatdan olib tashlansa, kod qaytadi.

## 7. Offline ishlash
DataMatrix/QR/skaner kutubxonalari endi CORS rejimida yuklanadi va service worker ularni keshlaydi
(`dokon-shell-v4`). Kodlar sahifasi ochilganda DataMatrix kutubxonasi oldindan yuklanadi —
bir marta internet bilan ochgach, keyin internetsiz ham yaratish/chop etish ishlaydi.
Kutubxona umuman yuklanmasa, tizim avtomatik QR ga o'tadi.

## Cheklovlar
- Sotilgan kodlar avvalgidek `soldCodes` da saqlanadi (har bir sotuv ~30 bayt) — bu faqat haqiqiy sotuvlar soniga bog'liq.
- Partiya boshqa qurilmada yaratilgan bo'lsa, bu qurilmaga sinxronlangunicha kod "tizimda topilmadi" deydi.

---

# v3 yangiliklari

## 1. Termo printerga to'g'ridan-to'g'ri chop etish
Kodlar markazi → **Chop etish usuli**:
- **Brauzer orqali** — avvalgidek (oddiy printer, A4 varaq, termo printer drayveri).
- **⚡ TSPL** — TSC, Xprinter, Gprinter, Godex va ko'pchilik "xitoy" termo printerlari.
- **⚡ ZPL** — Zebra va mos printerlar.

Bunda brauzerning chop etish oynasi ochilmaydi, yorliqlar qismlarga (300 ta) bo'linmaydi — istalgan miqdor
bitta ish sifatida yuboriladi; **⏸ To'xtatish / ▶ Davom ettirish** bor. Yorliq printer nuqtalarida (203/300/600 dpi)
chiziladi, kod moduli **butun nuqtaga** moslanadi.

**Ulash:** "🔌 USB printer ulash" (Chrome/Edge, Android'da ham) yoki "🔌 Serial / COM ulash" (kompyuterda).
Bir marta ruxsat berilgach printer keyingi safar avtomatik topiladi (USB).

**Birinchi marta:** "🧪 Test yorliq"ni chop eting. Ramka to'liq ko'rinsa — o'lcham to'g'ri.
Hamma yorliq qora chiqsa — "Ranglar teskari chiqsa" belgisini yoqing. Yorliqlar orasi (gap) printer lentasiga
mos bo'lsin (2 mm / 3 mm / uzluksiz).

**Eslatma:** Windows'da printer drayveri USB'ni egallab olgan bo'lsa, USB ulash ishlamasligi mumkin — shunda
Serial usulini yoki "Brauzer orqali" usulini ishlating. A4 varaqlar faqat brauzer orqali chop etiladi.

## 2. Yorliqda yangi maydonlar
- **Joylashuv:** kod chapda / kod tepada.
- **Chop sanasi**, **tartib raqami (№)**, **qo'shimcha matn** (masalan do'kon nomi, telefon).
- **Har bir koddan nusxa soni** (1–10): masalan qopqoq va quti uchun 2 tadan yorliq.

## 3. Kod yozuvlari hajmi nazorati
Zavod kodlari (GS1) va sotilgan kodlar mahsulot hujjatida saqlanadi. Firestore hujjatiga **40 000 indeks yozuvi** va
**1 MiB** chegarasi bor (taxminan 18–25 ming kod). Tovar tanlanganda **"Kod yozuvlari hajmi"** ko'rsatiladi:
- 60% dan — ogohlantirish, 85% dan — qizil ogohlantirish (sotuvda ham xabar chiqadi),
- 100% da yangi zavod kodini ro'yxatga olish to'xtatiladi (ombor/sotuv yozuvi buzilib qolmasligi uchun).

**Partiya (MB-) kodlari** bu chegaraga faqat sotilganda ta'sir qiladi (har bir sotuv ~30 bayt), yaratilganda esa umuman
hujjatni to'ldirmaydi. Shuning uchun yangi tovarlar uchun partiya kodlari tavsiya etiladi.

**Indeksni o'chirish (ixtiyoriy, hajmni oshiradi):** `firestore.indexes.json` ga `soldCodes` va `serialCodes`
maydonlari uchun indeks istisnosi qo'shilgan. Qo'llash: `firebase deploy --only firestore:indexes`.
Bu indeks chegarasini (40 000) olib tashlaydi; 1 MiB chegarasi qoladi.

---

# v6 yangilanish (xavfsizlik / tezlik / mobil UX)
Batafsil: `UPGRADE_V6.md`. Service worker keshi: `dokon-shell-v5`.
