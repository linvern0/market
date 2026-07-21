// api/miniapp-data.js
// ----------------------------------------------------------------------------
// Telegram Mini App (miniapp.html) shu endpoint'ga POST so'rov yuborib,
// { initData } beradi. Biz initData'ni tekshirib (soxta bo'lmasligiga
// ishonch hosil qilib), foydalanuvchi kim ekanini (admin / qarzdor / notanish)
// aniqlaymiz va shunga mos ma'lumotlarni Firestore'dan o'qib qaytaramiz.
//
// Xavfsizlik: bot tokeni orqali tekshirilgan initData'siz HECH QANDAY
// ma'lumot qaytarilmaydi - shuning uchun bu API'ni ochiq (public) qilib
// qo'yish xavfsiz, chunki faqat sizning botingiz orqali ochilgan haqiqiy
// Mini App so'rovlarigina qabul qilinadi.
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');
const { verifyInitData } = require('./_miniapp-auth');

let firebaseApp = null;
function getDb() {
  if (!firebaseApp) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var topilmadi.');
    const serviceAccount = JSON.parse(raw);
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }
function phoneKey(phone) { return String(phone || '').replace(/\D/g, '').slice(-9); }

async function buildAdminPayload(db, settings) {
  const [debtsSnap, productsSnap, salesSnap] = await Promise.all([
    db.collection('debts').get(),
    db.collection('products').get(),
    db.collection('sales').get(),
  ]);

  const allDebts = debtsSnap.docs.map((d) => d.data());
  const activeDebts = allDebts.filter((d) => !d.paid).sort((a, b) => debtRemaining(b) - debtRemaining(a));
  const totalDebt = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);

  const products = productsSnap.docs.map((d) => d.data());
  const threshold = settings.lowStockThreshold || 5;
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= threshold);
  const outOfStock = products.filter((p) => p.stock === 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySales = salesSnap.docs.map((d) => d.data()).filter((s) => !s.reverted && (s.date || '').slice(0, 10) === todayStr);
  const revenue = todaySales.reduce((a, s) => a + (s.total || 0), 0);
  const profit = todaySales.reduce((a, s) => a + ((s.price || 0) - (s.cost || 0)) * (s.qty || 0), 0);

  return {
    role: 'admin',
    shopName: settings.shopName || "Do'kon",
    currencySymbol: settings.currencySymbol || "so'm",
    stats: { revenue, profit, salesCount: todaySales.length },
    debts: activeDebts.map((d) => ({
      id: d.id, name: d.debtorName || d.org || '?', org: d.org || '', total: d.total,
      remaining: debtRemaining(d), date: d.date,
    })),
    totalDebt,
    stock: {
      low: lowStock.map((p) => ({ name: p.name, stock: p.stock, price: p.price })),
      out: outOfStock.map((p) => ({ name: p.name })),
    },
  };
}

async function buildDebtorPayload(db, settings, chatId) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) return { role: 'guest' };

  const debtorDocs = debtorsSnap.docs.map((d) => d.data());
  const org = debtorDocs.find((d) => d.org)?.org || '';

  let debts = [];
  if (org) {
    const orgSnap = await db.collection('debts').where('org', '==', org).get();
    debts = orgSnap.docs.map((d) => d.data());
  } else {
    const debtorIds = debtorDocs.map((d) => d.id);
    const allSnap = await db.collection('debts').get();
    debts = allSnap.docs.map((d) => d.data()).filter((d) => debtorIds.includes(d.debtorId));
  }

  const activeDebts = debts.filter((d) => !d.paid);
  const total = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);

  // Tashkilot bo'lsa - har bir xodim bo'yicha yig'indi ham chiqaramiz (debt.html'dagi kabi)
  let byPerson = null;
  if (org) {
    const map = {};
    activeDebts.forEach((d) => {
      const key = d.debtorName || 'Noma\'lum';
      if (!map[key]) map[key] = { name: key, total: 0 };
      map[key].total += debtRemaining(d);
    });
    byPerson = Object.values(map).sort((a, b) => b.total - a.total);
  }

  return {
    role: 'debtor',
    shopName: settings.shopName || "Do'kon",
    currencySymbol: settings.currencySymbol || "so'm",
    name: org ? org : (debtorDocs[0]?.name || ''),
    isOrg: !!org,
    total,
    byPerson,
    debts: activeDebts
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map((d) => ({ id: d.id, name: d.debtorName, remaining: debtRemaining(d), total: d.total, date: d.date, note: d.note || '' })),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(200).json({ ok: true, info: 'Mini App data endpoint is up' }); return; }
  try {
    const { initData } = req.body || {};
    const db = getDb();
    const settingsRef = db.collection('dokon').doc('settings');
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) { res.status(200).json({ role: 'guest' }); return; }
    const settings = settingsSnap.data();
    const token = (settings.telegramBotToken || '').trim();

    const user = verifyInitData(initData, token);
    if (!user) { res.status(401).json({ ok: false, error: 'invalid_init_data' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    const isAdmin = admins.some((a) => String(a.chatId).trim() === chatId);

    let payload;
    if (isAdmin) payload = await buildAdminPayload(db, settings);
    else payload = await buildDebtorPayload(db, settings, chatId);

    res.status(200).json(payload);
  } catch (e) {
    console.error('miniapp-data xatolik:', e);
    res.status(200).json({ ok: false, error: String(e) });
  }
};
