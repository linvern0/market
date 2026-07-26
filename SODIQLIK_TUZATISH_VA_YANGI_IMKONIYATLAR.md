# Sodiqlik dasturi — asosiy tuzatish va yangi imkoniyatlar

## Nima uchun "hech narsa ishlamayapdi" edi

Ilova (`index.html`) bir xil fayldan ham brauzerda, ham **Telegram ichida**
(admin uchun bot menyusi orqali) ochiladi. Lekin ball bilan bog'liq deyarli
barcha tugmalar — 🎁 Ball hadya qilish, ✏️ Ballni to'g'irlash, + Xarid qayd
etish, va daraja tanlash — brauzerning **`prompt()`** funksiyasiga tayanardi.
Telegram Mini App muhitida `prompt()` ko'pchilik qurilma/versiyalarda
ishlamaydi — tugma bosilganda hech qanday oyna chiqmaydi. Shu sabab bu
amallar Telegram ichida "hech narsa bo'lmayapti"day tuyulardi.

Xuddi shu muammo `miniapp.html` (Telegram mini-ilovaning o'zi) ichida ham bor
edi: "O'chirish" tugmalari native `confirm()`ga tayanardi. Ustiga-ustak,
mijozlarni o'chirishda daraja (tierOverride) maydoni serverga umuman
saqlanmas edi, ro'yxatda esa hech qachon ko'rinmasdi.

## Tuzatilgan xatolar

1. **`index.html`** — barcha `prompt()` chaqiruvlari (ball hadya qilish,
   to'g'irlash, xarid qayd etish, daraja tanlash) yangi `window.prompt2`
   oynasi bilan almashtirildi — bu endi Telegram ichida ham ishonchli ishlaydi.
2. **`miniapp.html`** — barcha `confirm()` chaqiruvlari (tovar, qarzdor,
   mijoz, xodim, admin o'chirish) yangi `confirm2` oynasi bilan almashtirildi.
3. **`miniapp.html` + `api/miniapp-action.js`** — mijozga qo'lda belgilangan
   daraja (tierOverride) endi to'g'ri saqlanadi va ro'yxatda ko'rinadi
   (ilgari faqat `'bronze'|'silver'|'gold'` qabul qilinardi va mijozlar
   ro'yxatiga bu maydon umuman yuborilmasdi).
4. Ikkala interfeys (`index.html` va `miniapp.html`) endi **bir xil**
   daraja sozlamalaridan foydalanadi (`api/_loyalty.js` orqali serverda,
   `DB.loyaltyTiers` orqali brauzerda) — ilgari ikkalasida alohida, bir-
   biriga mos kelmaydigan qattiq yozilgan chegaralar bor edi.

## Yangi imkoniyatlar

- **🏆 Darajalarni sozlash** (Mijozlar oynasi ichida, yangi tugma): admin
  endi Bronza/Kumush/Oltin nomi, emojisi, rangi va necha so'mdan
  boshlanishini o'zi belgilaydi, hamda xohlagancha yangi daraja qo'sha oladi
  (masalan 💎 Platina).
- **Avtomatik Telegram tabrigi**: mijozning darajasi oshganda (xarid orqali
  yoki admin qo'lda belgilaganda — ikkala interfeysda ham), agar botga
  ulangan bo'lsa, unga darhol tabrik xabari boradi.
- **Kengaytirilgan hisobot**: "Ballar bo'yicha hisobot" endi har bir daraja
  bo'yicha nechta mijoz borligi va ular jami qancha xarid qilganini ham
  ko'rsatadi.
- Mijozning o'zi (Telegram mini-ilovada) endi o'z darajasini ham ko'radi.

### Ikkinchi bosqichda qo'shilgan (admin tanlovi bo'yicha)
- **📜 To'liq xarid tarixi** — har bir mijoz uchun alohida oynada, barcha
  xarid/hadya/tuzatish/ballni ishlatish voqealari bitta xronologik
  ro'yxatda (avvalgi 20 taga cheklangan, tarqoq ko'rinish o'rniga).
- **📢 Ommaviy xabarnoma** — botga ulangan barcha mijozlarga bir vaqtda
  xabar yuborish (masalan aksiya haqida).
- **🏅 TOP-10 faol mijozlar** — eng ko'p xarid qilgan mijozlar reytingi,
  hisobot bo'limida.
- **⬇️ Excel / PDF eksport** — mijozlar ro'yxatini bir tugma bilan
  yuklab olish.
- **👑 VIP mijozlar** — mijozni VIP deb belgilash (ixtiyoriy eslatma bilan);
  VIP mijozlar ro'yxat boshida ajratib ko'rsatiladi.
- **Kunlik hisobotda yangi mijozlar** — mavjud "Kunlik hisobot" Telegram
  xabariga endi "bugun/so'nggi 7 kunda nechta yangi mijoz qo'shilgani"
  ham qo'shildi.

## O'zgargan fayllar
- `index.html` — daraja sozlash oynasi, `prompt2` universal kirish oynasi,
  kengaytirilgan hisobot, avtomatik tabrik xabari.
- `miniapp.html` — `confirm2` oynasi, daraja ro'yxati endi umumiy
  sozlamalardan o'qiydi, mijozning o'z darajasi ko'rinadi.
- `api/miniapp-data.js`, `api/miniapp-action.js` — `tierOverride` to'g'ri
  saqlanadi/yuboriladi, daraja o'zgarganda Telegram xabari, `loyaltyTiers`
  mini-ilovaga uzatiladi.
- `api/_loyalty.js` — **yangi** umumiy yordamchi fayl (daraja hisoblash
  mantiqini ikkala API faylida takrorlamaslik uchun).

## Eslatma
`miniapp.html`da xodim/qarzdor/tovar o'chirish tugmalari ham xuddi shu
sababdan (native `confirm()`) buzuq edi — ular ham shu yangilanishda
tuzatildi, garchi bevosita savol sodiqlik dasturi haqida bo'lsa-da.

Ikkinchi bosqichdagi yangi funksiyalar (to'liq tarix, ommaviy xabarnoma,
TOP-10, Excel/PDF eksport, VIP) hozircha faqat to'liq admin panelida
(`index.html`) mavjud — `miniapp.html` (Telegram mini-ilova) hajmi kichik
bo'lishi uchun ataylab asosiy amallar (qo'shish/tahrirlash/o'chirish) bilan
cheklab qo'yildi. Agar bular ham mini-ilovada kerak bo'lsa — alohida
so'rov sifatida qo'shib beraman.

Boshqa hech qanday mavjud funksionallikka tegilmadi.
