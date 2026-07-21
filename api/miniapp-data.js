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
//
// QARZDOR KO'RISH DOIRASI (viewScope):
//   - Har bir "debtors" hujjatida ixtiyoriy `viewScope` maydoni bo'lishi
//     mumkin: 'org' bo'lsa - shu odam ULANGAN TASHKILOTNING BARCHA
//     qarzlarini (xodimlar bo'yicha taqsimlab) ko'radi (masalan buxgalter/
//     tashkilot vakili). Bo'lmasa (default) - FAQAT O'ZINING shaxsiy
//     qarzlarini ko'radi, hatto tashkilotga tegishli bo'lsa ham.
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

function debtSummary(d) {
  return {
    id: d.id, debtorId: d.debtorId || '', name: d.debtorName || d.org || '?', org: d.org || '',
    total: d.total, remaining: debtRemaining(d), date: d.date, dueDate: d.dueDate || null, note: d.note || '',
    isCashLoan: !!d.isCashLoan, paid: !!d.paid, paidDate: d.paidDate || null,
    payments: Array.isArray(d.payments) ? d.payments : [],
    items: Array.isArray(d.items) ? d.items.map((it) => ({ name: it.productName, qty: it.qty, price: it.price, volume: it.volume || '' })) : [],
  };
}

async function buildAdminPayload(db, settings) {
  const [debtsSnap, productsSnap, salesSnap, debtorsSnap] = await Promise.all([
    db.collection('debts').get(),
    db.collection('products').get(),
    db.collection('sales').get(),
    db.collection('debtors').get(),
  ]);

  const allDebts = debtsSnap.docs.map((d) => d.data());
  const activeDebts = allDebts.filter((d) => !d.paid).sort((a, b) => debtRemaining(b) - debtRemaining(a));
  const totalDebt = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);

  const products = productsSnap.docs.map((d) => d.data());
  const threshold = settings.lowStockThreshold || 5;
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= threshold);
  const outOfStock = products.filter((p) => p.stock === 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const allSales = salesSnap.docs.map((d) => d.data()).filter((s) => !s.reverted);
  const todaySales = allSales.filter((s) => (s.date || '').slice(0, 10) === todayStr);
  const revenue = todaySales.reduce((a, s) => a + (s.total || 0), 0);
  const profit = todaySales.reduce((a, s) => a + ((s.price || 0) - (s.cost || 0)) * (s.qty || 0), 0);

  // Oxirgi 7 kunlik savdo/foyda va yangi qarz dinamikasi — bosh sahifadagi
  // statistika grafigi uchun.
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d0 = new Date();
    d0.setDate(d0.getDate() - i);
    days.push(d0.toISOString().slice(0, 10));
  }
  const last7Days = days.map((dayStr) => {
    const daySales = allSales.filter((s) => (s.date || '').slice(0, 10) === dayStr);
    const dayRevenue = daySales.reduce((a, s) => a + (s.total || 0), 0);
    const dayProfit = daySales.reduce((a, s) => a + ((s.price || 0) - (s.cost || 0)) * (s.qty || 0), 0);
    const dayNewDebt = allDebts.filter((d) => (d.date || '').slice(0, 10) === dayStr).reduce((a, d) => a + (d.total || 0), 0);
    return { date: dayStr, revenue: dayRevenue, profit: dayProfit, newDebt: dayNewDebt };
  });

  const debtors = debtorsSnap.docs.map((d) => {
    const x = d.data();
    return {
      id: x.id, name: x.name || '', org: x.org || '', phone: x.phone || '',
      telegramUsername: x.telegramUsername || '', telegramUserId: x.telegramUserId || '', linked: !!x.telegramChatId,
      viewScope: x.viewScope === 'org' ? 'org' : 'own',
    };
  });

  const admins = (Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : []).map((a) => ({
    name: a.name || '', phone: a.phone || '', username: a.username || '', chatId: a.chatId || '', linked: !!a.chatId,
  }));

  return {
    role: 'admin',
    shopName: settings.shopName || "Do'kon",
    currencySymbol: settings.currencySymbol || "so'm",
    stats: { revenue, profit, salesCount: todaySales.length },
    last7Days,
    debts: activeDebts.map(debtSummary),
    totalDebt,
    stock: {
      low: lowStock.map((p) => ({ id: p.id, name: p.name, stock: p.stock, price: p.price })),
      out: outOfStock.map((p) => ({ id: p.id, name: p.name, price: p.price })),
    },
    products: products
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((p) => ({ id: p.id, name: p.name, price: p.price, cost: p.cost || 0, stock: p.stock || 0, volume: p.volume || '', note: p.note || '' })),
    debtors: debtors.sort((a, b) => (a.org || a.name).localeCompare(b.org || b.name)),
    settings: {
      shopName: settings.shopName || "Do'kon",
      currencySymbol: settings.currencySymbol || "so'm",
      lowStockThreshold: settings.lowStockThreshold || 5,
      overdueDaysGlobal: settings.overdueDaysGlobal || 14,
      telegramNotifyLowStock: !!settings.telegramNotifyLowStock,
      telegramNotifyOverdueDebts: !!settings.telegramNotifyOverdueDebts,
      telegramNotifyDailyReport: !!settings.telegramNotifyDailyReport,
      telegramAdmins: admins,
    },
  };
}

async function buildDebtorPayload(db, settings, chatId) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) return { role: 'guest' };

  const debtorDocs = debtorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const org = debtorDocs.find((d) => d.org)?.org || '';
  // Shu odam ulangan qarzdor yozuvlaridan kamida bittasida "butun tashkilot"
  // ko'rish huquqi (viewScope==='org') belgilangan bo'lsa - u tashkilot
  // vakili/buxgalter hisoblanadi va BARCHA xodimlar qarzini ko'radi.
  // Aks holda (default) - faqat o'ziga tegishli qarzlarni ko'radi.
  const isOrgViewer = !!org && debtorDocs.some((d) => d.org === org && d.viewScope === 'org');

  const allSnap = await db.collection('debts').get();
  const allDebts = allSnap.docs.map((d) => d.data());

  let debts;
  if (isOrgViewer) {
    debts = allDebts.filter((d) => d.org === org);
  } else {
    const myIds = debtorDocs.map((d) => d.id);
    debts = allDebts.filter((d) => myIds.includes(d.debtorId));
  }

  const activeDebts = debts.filter((d) => !d.paid);
  const paidDebts = debts.filter((d) => d.paid);
  const total = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);
  const totalPaidAmount = debts.reduce((a, d) => a + (d.paidAmount || 0), 0);
  const allPayments = debts
    .flatMap((d) => (Array.isArray(d.payments) ? d.payments.map((pmt) => ({ ...pmt, debtId: d.id, debtName: d.debtorName || d.org })) : []))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Tashkilot vakili bo'lsa - har bir xodim bo'yicha yig'indi ham chiqaramiz
  let byPerson = null;
  if (isOrgViewer) {
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
    name: isOrgViewer ? org : (debtorDocs[0]?.name || ''),
    org: org || '',
    isOrg: !!org,
    isOrgViewer,
    total,
    totalPaidAmount,
    byPerson,
    debts: activeDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).map(debtSummary),
    historyDebts: paidDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).map(debtSummary),
    payments: allPayments.slice(0, 50),
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
