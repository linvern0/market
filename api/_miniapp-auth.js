// api/_miniapp-auth.js
// ----------------------------------------------------------------------------
// Telegram Mini App'dan (WebApp) kelgan "initData"ni tekshirish uchun umumiy
// yordamchi funksiyalar. Bu fayl to'g'ridan-to'g'ri API endpoint emas — uni
// boshqa api/*.js fayllar "require" qiladi.
//
// Telegram hujjatiga ko'ra initData haqiqiyligini quyidagicha tekshirish
// kerak: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ----------------------------------------------------------------------------

const crypto = require('crypto');

// initData satrini tekshiradi va ichidagi "user" obyektini qaytaradi.
// Agar noto'g'ri/soxta bo'lsa -> null qaytaradi.
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    // auth_date 24 soatdan eski bo'lsa - rad etamiz (eski/o'g'irlangan link ishlatilmasin)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || (Date.now() / 1000 - authDate) > 60 * 60 * 24) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    return user; // { id, first_name, username, ... }
  } catch (e) {
    return null;
  }
}

module.exports = { verifyInitData };
