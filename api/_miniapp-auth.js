// api/_miniapp-auth.js
// ----------------------------------------------------------------------------
// Telegram Mini App yuboradigan `initData` satrini bot tokeni yordamida
// raqamli tekshiradi (Telegram rasmiy hujjatidagi algoritm bo'yicha).
// Agar imzo noto'g'ri bo'lsa yoki ma'lumot muddati juda eski bo'lsa (>24soat),
// null qaytaradi - shunda so'rov chaqiruvchi tomonidan rad etiladi.
// ----------------------------------------------------------------------------

const crypto = require('crypto');

const MAX_AGE_SECONDS = 24 * 60 * 60; // 24 soat

function verifyInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
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

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate) return null;
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > MAX_AGE_SECONDS) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || !user.id) return null;

    return user;
  } catch (e) {
    console.error('verifyInitData xatolik:', e);
    return null;
  }
}

module.exports = { verifyInitData };
