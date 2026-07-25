# Sodiqlik ballari — yangi imkoniyatlar

Ushbu yangilanishda "Mijozlar va sodiqlik dasturi" bo'limiga qo'shilgan narsalar:

## 1. Ballarni to'liq nazorat qilish (qo'lda)
Har bir mijoz kartochkasida endi 2 ta yangi tugma bor:
- **🎁 Ball hadya qilish** — mijozga xohlagan miqdorda ball qo'shib beradi (masalan tug'ilgan kun sovg'asi, bonus aksiya). Ixtiyoriy sabab yozish mumkin.
- **✏️ Ballni to'g'irlash** — musbat yoki manfiy son kiritib, ballni to'g'ridan-to'g'ri tuzatish (masalan xato yozilgan ballni tuzatish uchun). Ball manfiyga tushib ketishiga yo'l qo'yilmaydi.

Har ikkala amal ham tarixga yoziladi (mijoz kartochkasida "✏️ Qo'lda kiritilgan ball o'zgarishlari" bo'limida ko'rinadi) va umumiy "Ballar bo'yicha hisobot"da ham jamlanadi. Agar mijoz botga ulangan bo'lsa, unga darhol Telegram xabar boradi.

## 2. Botga ulashda yangi — bir martalik havola
Ilgari mijozni botga ulash uchun faqat Telegram username yoki Telegram ID qo'lda kiritish kerak edi (telefon raqami esa mijoz o'zi yuborganda avtomatik ishlaydi). Endi **"🤖 Botga ulash"** oynasida yana bitta usul qo'shildi:

- **🔗 Bir martalik havola** — tugmani bosish bilan shu mijozga xos noyob havola (va QR kod) yaratiladi: `https://t.me/<bot_username>?start=cl_<token>`.
- Bu havolani istalgan kanal orqali (Telegram, SMS, WhatsApp) mijozga yuborasiz.
- Mijoz havolani ochib botni ishga tushirganda — u AVTOMATIK ravishda shu mijozga bog'lanadi, username/ID/telefon kiritishning hojati yo'q.
- Havola **faqat bir marta** ishlaydi — ishlatilgach avtomatik bekor bo'ladi (qayta ochilsa "eskirgan havola" deb javob beradi). Kerak bo'lsa "🔄 Yangilash" tugmasi orqali eski havolani bekor qilib, yangisini chiqarish mumkin.
- Ishlashi uchun Sozlamalar > Telegram bo'limida bot username kiritilgan bo'lishi shart (chek QR kodi ishlatgan bo'lsangiz, bu allaqachon to'ldirilgan).

## O'zgargan fayllar
- `index.html` — "Mijozlar va sodiqlik dasturi" va "Botga ulash" oynalari, tegishli JS funksiyalar.
- `api/telegram-webhook.js` — yangi `handleCustomerLinkClaim` funksiyasi (`/start cl_<token>` deep-link'ni qayta ishlaydi).

Boshqa hech qanday mavjud funksionallikka tegilmadi.
