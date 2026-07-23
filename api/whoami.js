// api/whoami.js
// ----------------------------------------------------------------------------
// YANGI: to'liq boshqaruv paneli (index.html) Telegram Mini App ichida
// ochilganda, admin/sotuvchi HAR SAFAR qo'lda PIN kiritishi shart emas —
// bu endpoint Telegram'ning o'zi (initData) orqali "bu kim" ekanini
// xavfsiz tekshiradi (bot tokeni bilan raqamli imzolangan, soxta bo'lishi
// mumkin emas) va agar u ro'yxatdagi admin yoki sotuvchi bo'lsa, index.html
// PIN so'ramasdan to'g'ridan-to'g'ri kirishi uchun uning rolini qaytaradi.
//
// MUHIM (xavfsizlik): bu ODDIY brauzerda ishlamaydi — faqat Telegram
// ilovasi ichida, bot orqali ochilgan haqiqiy so'rovlar uchun (initData
// imzosi bot tokeni bilan tekshiriladi). Oddiy brauzerdan ochilganda
// initData bo'lmaydi, shuning uchun index.html odatdagidek PIN so'raydi.
// ----------------------------------------------------------------------------

const { getDb } = require('./_firebase');
const { verifyInitData } = require('./_miniapp-auth');

function usernameKey(u) { return String(u || '').replace(/^@/, '').trim().toLowerCase(); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(200).json({ role: 'guest' }); return; }
  try {
    const { initData } = req.body || {};
    const db = getDb();
    const settingsRef = db.collection('dokon').doc('settings');
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) { res.status(200).json({ role: 'guest' }); return; }
    const settings = settingsSnap.data();
    const token = (settings.telegramBotToken || '').trim();

    const user = verifyInitData(initData, token);
    if (!user) { res.status(200).json({ role: 'guest' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    const isAdmin = admins.some((a) => String(a.chatId || '').trim() === chatId);
    if (isAdmin) { res.status(200).json({ role: 'admin' }); return; }

    const sellers = Array.isArray(settings.sellers) ? settings.sellers : [];
    let seller = sellers.find((s) => String(s.telegramChatId || '').trim() === chatId);
    if (!seller && user.username) {
      // Hali chatId bog'lanmagan, lekin admin uni username orqali oldindan
      // kiritgan bo'lsa - shu birinchi kirishda avtomatik bog'laymiz.
      const uKey = usernameKey(user.username);
      const idx = sellers.findIndex((s) => !s.telegramChatId && usernameKey(s.telegramUsername) === uKey && uKey);
      if (idx !== -1) {
        sellers[idx] = { ...sellers[idx], telegramChatId: chatId };
        await settingsRef.set({ sellers }, { merge: true }).catch(() => {});
        seller = sellers[idx];
      }
    }
    if (seller) { res.status(200).json({ role: 'seller', sellerId: seller.id, sellerName: seller.name || 'Sotuvchi' }); return; }

    res.status(200).json({ role: 'guest' });
  } catch (e) {
    console.error('whoami xatolik:', e);
    res.status(200).json({ role: 'guest' });
  }
};
