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
const { getLoyaltyTiers, computeCustomerTier, getCoinSettings, isCoinEnabled } = require('./_loyalty');
const { getSettings } = require('./_firebase');

function getDb() { return require('./_firebase').getDb(); }

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

// ============ YANGI: MINI APP BO'LIMLARINI ADMIN PANELDAN YOQISH/O'CHIRISH ============
// index.html > "🎛 Buyruqlar va Mini App bo'limlarini sozlash" oynasidan
// admin Mini App'dagi (miniapp.html) ayrim bo'limlarni (tab'larni) yoqib/
// o'chirib qo'yishi mumkin — masalan xodimga faqat "Sotish" va "Qarzlar"
// kerak bo'lsa, "Hisobot" va "Sozlama" bo'limlarini yashirishi mumkin.
// 'main' (Bosh) doim ko'rinadi — bu tab bo'sh bo'lib qolmasligi uchun.
function getMiniAppSectionsConfig(settings) {
  const cfg = (settings && settings.miniAppSectionsConfig && typeof settings.miniAppSectionsConfig === 'object') ? settings.miniAppSectionsConfig : {};
  const adminDefaults = { sell: true, debts: true, stock: true, debtors: true, report: true, customers: true, staff: true, settings: true };
  const clientDefaults = { catalog: true };
  return {
    admin: Object.assign({}, adminDefaults, cfg.admin && typeof cfg.admin === 'object' ? cfg.admin : {}),
    client: Object.assign({}, clientDefaults, cfg.client && typeof cfg.client === 'object' ? cfg.client : {}),
  };
}

async function buildAdminPayload(db, settings) {
  const todayStr = new Date().toISOString().slice(0, 10);
  // TEZLASHTIRISH: ilgari BUTUN "debts" va "sales" to'plami (loyihaning
  // butun tarixi — yillar davomida cheksiz o'sadi) har safar Mini App
  // admin panelini ochganda to'liq o'qilardi, bu ma'lumot ko'payishi bilan
  // progressiv sekinlashardi. Endi faqat kerakli qism o'qiladi:
  //  - "debts": to'lanmagan qarzlar SERVER TOMONDA filtrlanadi (paid==false)
  //    — bu ro'yxat vaqt o'tishi bilan cheksiz o'smaydi (to'langan qarzlar
  //    chiqarib tashlanadi), shuning uchun har doim tez.
  //  - Statistika (kunlik grafik + oy/oy solishtiruv) uchun oxirgi ~70
  //    kunlik yozuvlar yetarli (eng uzun holat: oy boshi bilan oldingi
  //    oyni solishtirish, bu 62 kungacha borishi mumkin — 70 kun bilan
  //    xavfsiz zахира qoldirilgan).
  const statsFromDate = (() => { const d0 = new Date(); d0.setDate(d0.getDate() - 70); return d0.toISOString().slice(0, 10); })();

  const [unpaidDebtsSnap, recentDebtsSnap, productsSnap, recentSalesSnap, debtorsSnap, customersSnap] = await Promise.all([
    db.collection('debts').where('paid', '==', false).get(),
    db.collection('debts').where('date', '>=', statsFromDate).get(),
    db.collection('products').get(),
    db.collection('sales').where('date', '>=', statsFromDate).get(),
    db.collection('debtors').get(),
    db.collection('customers').get(),
  ]);

  const activeDebts = unpaidDebtsSnap.docs.map((d) => d.data()).sort((a, b) => debtRemaining(b) - debtRemaining(a));
  const totalDebt = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);
  // Statistikada "shu kun/davrda yozilgan yangi qarz" uchun ishlatiladi —
  // to'langan yoki to'lanmaganidan qat'i nazar, sanaga qarab kesilgan.
  const allDebts = recentDebtsSnap.docs.map((d) => d.data());

  const products = productsSnap.docs.map((d) => d.data());
  const threshold = settings.lowStockThreshold || 5;
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= threshold);
  const outOfStock = products.filter((p) => p.stock === 0);

  // TUZATILDI: ilgari faqat d.data() olinardi va Firestore hujjatining
  // HAQIQIY id'si (d.id) yo'qolardi (hujjat ichidagi "id" maydoni bilan mos
  // kelmasligi mumkin — "sell" amalida ikkalasi alohida tasodifiy qiymat).
  // Endi haqiqiy hujjat id'si saqlanadi — bu "So'nggi savdolar"ni
  // qaytarish (revert_sale) uchun receiptId bilan birga kerak.
  const allSales = recentSalesSnap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((s) => !s.reverted);
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

  // ============ YANGI: Hisobot (kun/hafta/oy) — mini-ilovaning "Hisobot"
  // bo'limi uchun. Har bir davr uchun daromad/foyda/savdolar soni, oldingi
  // davrga nisbatan foiz o'zgarishi, eng ko'p sotilgan tovarlar va so'nggi
  // savdolar ro'yxati hisoblanadi (bot'dagi /statistika bilan bir xil
  // mantiq — shu bilan ikkala interfeys ham izchil ma'lumot beradi).
  function periodBounds(period) {
    const now = new Date();
    if (period === 'today') return { from: todayStr, prevFrom: (() => { const y = new Date(now); y.setDate(y.getDate() - 1); return y.toISOString().slice(0, 10); })(), prevTo: null };
    if (period === 'week') {
      const from = new Date(now); from.setDate(from.getDate() - 6);
      const pf = new Date(now); pf.setDate(pf.getDate() - 13);
      const pt = new Date(now); pt.setDate(pt.getDate() - 7);
      return { from: from.toISOString().slice(0, 10), prevFrom: pf.toISOString().slice(0, 10), prevTo: pt.toISOString().slice(0, 10) };
    }
    const from = todayStr.slice(0, 8) + '01';
    const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { from, prevFrom: pm.toISOString().slice(0, 10), prevTo: new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10) };
  }
  function statsFor(period) {
    const { from, prevFrom, prevTo } = periodBounds(period);
    const periodSales = allSales.filter((s) => (s.date || '').slice(0, 10) >= from);
    const prevSales = allSales.filter((s) => { const dd = (s.date || '').slice(0, 10); return prevTo ? (dd >= prevFrom && dd <= prevTo) : dd === prevFrom; });
    const rev = periodSales.reduce((a, s) => a + (s.total || 0), 0);
    const prof = periodSales.reduce((a, s) => a + ((s.price || 0) - (s.cost || 0)) * (s.qty || 0), 0);
    const prevRev = prevSales.reduce((a, s) => a + (s.total || 0), 0);
    const newDebt = allDebts.filter((dd) => (dd.date || '').slice(0, 10) >= from).reduce((a, dd) => a + (dd.total || 0), 0);
    const changePct = prevRev > 0 ? ((rev - prevRev) / prevRev) * 100 : (rev > 0 ? null : null);
    return { revenue: rev, profit: prof, salesCount: periodSales.length, newDebt, changePct, _sales: periodSales };
  }
  function topProductsFor(period) {
    const { _sales } = statsFor(period);
    const map = {};
    _sales.forEach((s) => {
      const key = s.productName || '?';
      if (!map[key]) map[key] = { name: key, revenue: 0, qty: 0 };
      map[key].revenue += s.total || 0;
      map[key].qty += s.qty || 0;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  }
  const reportStats = {};
  const topProducts = {};
  ['today', 'week', 'month'].forEach((per) => {
    const st = statsFor(per);
    reportStats[per] = { revenue: st.revenue, profit: st.profit, salesCount: st.salesCount, newDebt: st.newDebt, changePct: st.changePct };
    topProducts[per] = topProductsFor(per);
  });
  // YANGI: id, receiptId va productId ham qo'shildi — Mini App'dagi
  // "So'nggi savdolar" ro'yxatida web-panel bilan BIR XIL "↩ Qaytarish"
  // (revert_sale) tugmasini ko'rsatish/chaqirish uchun.
  const recentSales = allSales
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 25)
    .map((s) => ({
      id: s.id, receiptId: s.receiptId || s.id, productId: s.productId || '',
      productName: s.productName, qty: s.qty, price: s.price, total: s.total, date: s.date,
      seller: s.seller || '', isDebt: !!s.isDebt,
    }));

  const debtors = debtorsSnap.docs.map((d) => {
    const x = d.data();
    return {
      id: x.id, name: x.name || '', org: x.org || '', phone: x.phone || '',
      telegramUsername: x.telegramUsername || '', telegramUserId: x.telegramUserId || '', linked: !!x.telegramChatId,
      viewScope: x.viewScope === 'org' ? 'org' : 'own',
      creditLimit: x.creditLimit || 0, // YANGI: qarz limiti
    };
  });

  // YANGI: role va permissions ham yuboriladi — admin panelidagi
  // "🔐 Adminlar va huquqlar" oynasi shundan foydalanadi.
  const admins = (Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : []).map((a) => ({
    name: a.name || '', phone: a.phone || '', username: a.username || '', chatId: a.chatId || '', linked: !!a.chatId,
    role: a.role || 'owner', permissions: a.permissions || null,
  }));

  // YANGI: Xodimlar (sotuvchilar) ro'yxati — "Xodimlar" bo'limi uchun.
  const sellers = (Array.isArray(settings.sellers) ? settings.sellers : []).map((s) => ({
    id: s.id, name: s.name || '', pin: s.pin || '', telegramUsername: s.telegramUsername || '', linked: !!s.telegramChatId,
  }));

  // YANGI: Mijozlar / sodiqlik dasturi ro'yxati — "Mijozlar" bo'limi uchun.
  // TUZATILDI: tierOverride ilgari bu yerda yuborilmas edi — shuning uchun
  // admin mini-ilovada mijozga qo'lda daraja belgilasa ham, ro'yxatda bu
  // hech qachon ko'rinmas edi (doim avtomatik daraja ko'rsatilardi).
  const customers = customersSnap.docs.map((d) => {
    const c = d.data();
    return {
      id: d.id, name: c.name || '', phone: c.phone || '', telegramUsername: c.telegramUsername || '',
      points: c.points || 0, totalSpent: c.totalSpent || 0, purchaseCount: c.purchaseCount || 0, linked: !!c.telegramChatId,
      tierOverride: c.tierOverride || '',
    };
  });

  return {
    role: 'admin',
    shopName: settings.shopName || "Do'kon",
    currencySymbol: settings.currencySymbol || "so'm",
    // TUZATILDI (MUHIM): admin "Sotuv cheki sozlamalari"da (logotip,
    // manzil, telefon, footer matni, QR, shrift qalinligi va h.k.)
    // qanchalik ko'p narsani sozlamasin, bu ma'lumotlar bu yergacha
    // MUTLAQO YETIB KELMAS edi — shuning uchun Mini App orqali (bot ichida)
    // sotuv qilinganda chek doim qattiq yozilgan (hardcoded), sozlamalarga
    // mutlaqo bog'liq bo'lmagan ko'rinishda chiqardi. "Sozlama bor, lekin
    // ishlamaydi" muammosining sababi shu edi. Endi kerakli barcha
    // rekvizit va dizayn sozlamalari shu yerda yuboriladi.
    shopAddress: settings.shopAddress || '',
    shopPhone: settings.shopPhone || '',
    shopLogo: settings.shopLogo || '',
    workHours: settings.workHours || '',
    receiptFooter: settings.receiptFooter || '',
    saleReceiptDesign: settings.saleReceiptDesign || null,
    // YANGI: Mini App'da sotuvda ovozli e'lon sozlamalari.
    voiceAnnounceEnabled: !!settings.voiceAnnounceEnabled,
    voiceAnnounceTemplate: settings.voiceAnnounceTemplate || '',
    stats: { revenue, profit, salesCount: todaySales.length },
    last7Days,
    report: { ...reportStats, topProducts, recentSales },
    revertMinutes: settings.revertMinutes || 30,
    debts: activeDebts.map(debtSummary),
    totalDebt,
    stock: {
      low: lowStock.map((p) => ({ id: p.id, name: p.name, stock: p.stock, price: p.price })),
      out: outOfStock.map((p) => ({ id: p.id, name: p.name, price: p.price })),
    },
    products: products
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((p) => ({ id: p.id, name: p.name, price: p.price, cost: p.cost || 0, points: (p.points || p.points === 0) ? p.points : null, stock: p.stock || 0, volume: p.volume || '', note: p.note || '', img: p.img || '' })),
    debtors: debtors.sort((a, b) => (a.org || a.name).localeCompare(b.org || b.name)),
    sellers,
    customers,
    settings: {
      shopName: settings.shopName || "Do'kon",
      currencySymbol: settings.currencySymbol || "so'm",
      lowStockThreshold: settings.lowStockThreshold || 5,
      overdueDaysGlobal: settings.overdueDaysGlobal || 14,
      telegramNotifyLowStock: !!settings.telegramNotifyLowStock,
      telegramNotifyOverdueDebts: !!settings.telegramNotifyOverdueDebts,
      telegramNotifyDailyReport: !!settings.telegramNotifyDailyReport,
      telegramAdmins: admins,
      // YANGI: qarz limiti (umumiy) va ko'p bosqichli avto-eslatma jadvali
      // (kunlar ro'yxati, masalan [-3,-1,0,3,7]).
      defaultCreditLimit: settings.defaultCreditLimit || 0,
      debtReminderOffsets: Array.isArray(settings.debtReminderOffsets) && settings.debtReminderOffsets.length ? settings.debtReminderOffsets : [0, 3, 7],
      // YANGI: sodiqlik darajalari (Bronza/Kumush/Oltin va h.k., necha
      // so'mdan boshlanishi) — index.html'dagi "🏆 Darajalarni sozlash"
      // oynasida admin belgilagan ro'yxat. Bu yerga yuborilmasa,
      // mini-ilova o'zining (eskirgan, qattiq yozilgan) chegaralarini
      // ishlatib qolar edi — ikkala interfeys bir-biriga mos kelmasdi.
      loyaltyTiers: getLoyaltyTiers(settings),
      // YANGI: umumiy coin qoidasi (necha so'mdan 1 coin, 1 coin necha
      // so'mlik qiymat) — admin mini-ilova orqali ham ko'rishi mumkin.
      coinSettings: getCoinSettings(settings),
      // YANGI: COIN funksiyasi global yoqilgan/o'chirilganligi — miniapp.html
      // shu bayroqqa qarab coin bilan bog'liq bo'limlarni ko'rsatadi/yashiradi.
      coinEnabled: isCoinEnabled(settings),
      // YANGI: Mini App bo'limlari (tab'lar) qaysilari ko'rinishi kerakligi.
      miniAppSections: getMiniAppSectionsConfig(settings).admin,
    },
  };
}

// Firestore 'in' operator xohlaganda ko'pi bilan 30 ta qiymatni qabul
// qiladi - shu sababli katta ro'yxatlarni 10 talik bo'laklarga bo'lib,
// parallel so'rov yuboramiz (bitta odamda odatda 1 ta yozuv bo'ladi, lekin
// tashkilot holatlarida bir nechta bo'lishi mumkin).
async function fetchDebtsByDebtorIds(db, ids) {
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  const snaps = await Promise.all(chunks.map((c) => db.collection('debts').where('debtorId', 'in', c).get()));
  return snaps.flatMap((s) => s.docs.map((d) => d.data()));
}

// Mijoz (sodiqlik dasturi) uchun tovarlar katalogi — mijoz TOVARLAR
// BO'LIMIDAGI HAMMA MA'LUMOTNI (nomi, narxi, hajmi, izohi) ko'radi, LEKIN
// ombordagi mavjud miqdori (stock) HECH QACHON unga yuborilmaydi — bu
// faqat administrator uchun ichki ma'lumot.
function productUnitPoints(p) {
  // Admin aniq ball belgilagan bo'lsa — o'shani ishlatamiz (0 ham bo'lishi
  // mumkin, masalan aksiya tovarlari uchun ball berilmasin desa). Aks
  // holda avtomatik: narx/10000 (chekdagi umumiy formula bilan bir xil).
  if (p.points || p.points === 0) return Math.max(0, parseInt(p.points, 10) || 0);
  return Math.floor((p.price || 0) / 10000);
}

async function buildClientProducts(db) {
  const productsSnap = await db.collection('products').get();
  return productsSnap.docs
    .map((d) => d.data())
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    // Diqqat: aniq qoldiq (stock soni) mijozga ko'rsatilmaydi — faqat
    // "mavjud/tugagan" (inStock true/false) va sotib olganda necha ball
    // berilishi (points) ko'rsatiladi. Rasm (img) esa yuboriladi — chunki
    // admin panelidagi "Sotish" bo'limi kabi katalog ham rasm bilan
    // ko'rsatilishi kerak (bu ilgari yuborilmagan edi — kamchilik edi).
    .map((p) => ({ id: p.id, name: p.name, price: p.price, volume: p.volume || '', note: p.note || '', points: productUnitPoints(p), inStock: (p.stock || 0) > 0, img: p.img || '' }));
}

// Agar Telegram foydalanuvchisi hali "customers" (sodiqlik) kolleksiyasida
// bo'lmasa — shu yerda ham (bot /start bosilmagan holatlar uchun zaxira
// sifatida) avtomatik yaratib qo'yamiz, shunda mini-ilova hech qachon
// "notanish mehmon" holatini ko'rsatmaydi.
async function ensureCustomerRegistered(db, chatId, user) {
  const snap = await db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get();
  if (!snap.empty) return snap.docs[0].data();
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
    || (user.username ? '@' + user.username : `Mijoz ${chatId}`);
  const data = {
    name,
    telegramChatId: String(chatId),
    telegramUserId: String(user.id || ''),
    telegramUsername: user.username || '',
    phone: '',
    points: 0,
    totalSpent: 0,
    purchaseCount: 0,
    autoRegistered: true,
    createdAt: new Date().toISOString(),
  };
  await db.collection('customers').add(data);
  return data;
}

async function buildDebtorPayload(db, settings, chatId, user) {
  const [debtorsSnap, customerRecord, products] = await Promise.all([
    db.collection('debtors').where('telegramChatId', '==', String(chatId)).get(),
    ensureCustomerRegistered(db, chatId, user || {}),
    buildClientProducts(db),
  ]);

  if (debtorsSnap.empty) {
    // Qarzdor emas, faqat sodiqlik dasturi mijozi — baribir "mehmon" emas:
    // tovarlar katalogini va ball holatini ko'radi.
    return {
      role: 'client',
      shopName: settings.shopName || "Do'kon",
      currencySymbol: settings.currencySymbol || "so'm",
      name: customerRecord.name || '',
      isOrg: false,
      isOrgViewer: false,
      total: 0,
      totalPaidAmount: 0,
      byPerson: null,
      debts: [],
      historyDebts: [],
      payments: [],
      loyalty: {
        points: customerRecord.points || 0,
        totalSpent: customerRecord.totalSpent || 0,
        purchaseCount: customerRecord.purchaseCount || 0,
        tier: computeCustomerTier(customerRecord.totalSpent || 0, customerRecord.tierOverride || '', settings).label,
      },
      // YANGI: mini-ilova katalogida har bir tovarning "coinda sotib olish"
      // narxini hisoblashi uchun (getProductCoinCostClient — miniapp.html).
      coinSettings: getCoinSettings(settings),
      coinEnabled: isCoinEnabled(settings),
      miniAppSections: getMiniAppSectionsConfig(settings).client,
      products,
    };
  }

  const debtorDocs = debtorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const org = debtorDocs.find((d) => d.org)?.org || '';
  // Shu odam ulangan qarzdor yozuvlaridan kamida bittasida "butun tashkilot"
  // ko'rish huquqi (viewScope==='org') belgilangan bo'lsa - u tashkilot
  // vakili/buxgalter hisoblanadi va BARCHA xodimlar qarzini ko'radi.
  // Aks holda (default) - faqat o'ziga tegishli qarzlarni ko'radi.
  const isOrgViewer = !!org && debtorDocs.some((d) => d.org === org && d.viewScope === 'org');

  // TEZLIK: butun "debts" kolleksiyasini o'qib chiqish o'rniga (bu do'kon
  // kattalashgani sayin sekinlashadi va ortiqcha o'qish xarajati qiladi),
  // faqat kerakli qarzlarnigina to'g'ridan-to'g'ri so'raymiz.
  let debts;
  if (isOrgViewer) {
    const snap = await db.collection('debts').where('org', '==', org).get();
    debts = snap.docs.map((d) => d.data());
  } else {
    const myIds = debtorDocs.map((d) => d.id);
    debts = await fetchDebtsByDebtorIds(db, myIds);
  }

  const activeDebts = debts.filter((d) => !d.paid);
  const paidDebts = debts.filter((d) => d.paid);
  const total = activeDebts.reduce((a, d) => a + debtRemaining(d), 0);
  const totalPaidAmount = debts.reduce((a, d) => a + (d.paidAmount || 0), 0);
  const allPayments = debts
    .flatMap((d) => (Array.isArray(d.payments) ? d.payments.map((pmt) => ({ ...pmt, debtId: d.id, debtName: d.debtorName || d.org })) : []))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Tashkilot vakili bo'lsa - har bir xodim bo'yicha yig'indi ham chiqaramiz
  // TUZATILDI: ilgari faqat debtorName bo'yicha guruhlangani sabab, bir xil
  // ismli ikkita turli xodimning qarzi bitta qatorga qo'shilib ko'rsatilardi.
  // Endi mavjud bo'lsa debtorId asosiy kalit sifatida ishlatiladi.
  let byPerson = null;
  if (isOrgViewer) {
    const map = {};
    activeDebts.forEach((d) => {
      const key = d.debtorId || ('legacy:' + (d.debtorName || 'Noma\'lum'));
      if (!map[key]) map[key] = { name: d.debtorName || 'Noma\'lum', total: 0 };
      map[key].total += debtRemaining(d);
    });
    byPerson = Object.values(map).sort((a, b) => b.total - a.total);
  }

  return {
    role: 'client',
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
    loyalty: customerRecord ? {
      points: customerRecord.points || 0,
      totalSpent: customerRecord.totalSpent || 0,
      purchaseCount: customerRecord.purchaseCount || 0,
      tier: computeCustomerTier(customerRecord.totalSpent || 0, customerRecord.tierOverride || '', settings).label,
    } : null,
    coinSettings: getCoinSettings(settings),
    coinEnabled: isCoinEnabled(settings),
    miniAppSections: getMiniAppSectionsConfig(settings).client,
    products,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(200).json({ ok: true, info: 'Mini App data endpoint is up' }); return; }
  try {
    const { initData } = req.body || {};
    const db = getDb();
    // TEZLASHTIRISH: qisqa muddatli xotira-keshi — Mini App tez-tez (har
    // tab almashganda) shu endpoint'ga murojaat qiladi, shuning uchun
    // 'dokon/settings' hujjatini har safar qayta o'qish shart emas.
    const settings = await getSettings(db);
    if (!settings) { res.status(200).json({ role: 'guest' }); return; }
    const token = (settings.telegramBotToken || '').trim();

    const user = verifyInitData(initData, token);
    if (!user) { res.status(401).json({ ok: false, error: 'invalid_init_data' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    const isAdmin = admins.some((a) => String(a.chatId).trim() === chatId);

    let payload;
    if (isAdmin) payload = await buildAdminPayload(db, settings);
    else payload = await buildDebtorPayload(db, settings, chatId, user);

    res.status(200).json(payload);
  } catch (e) {
    console.error('miniapp-data xatolik:', e);
    res.status(200).json({ ok: false, error: String(e) });
  }
};
