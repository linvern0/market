// api/miniapp-action.js
// ----------------------------------------------------------------------------
// Mini App'dagi admin panelidan chaqiriladigan YOZISH amallari. Faqat
// tekshirilgan (initData orqali) va admin ekanligi aniqlangan chat'lardan
// kelgan so'rovlar bajariladi.
//
// Qo'llab-quvvatlanadigan action'lar:
//   pay_debt        { debtId, amount }
//   update_product  { id, patch:{name,price,cost,stock,volume,note} }
//   create_product  { name, price, cost, stock, volume, note }
//   delete_product  { id }
//   restock         { id, qty }              -> omborga tovar kirimi
//   sell            { items:[{productId,qty}], mode:'cash'|'debt',
//                      debtorId?, name?, org?, phone?, note?, customerId? }
//                      (customerId — faqat naqd sotuvda, sodiqlik mijoziga coin/xarid tarixini bog'lash uchun)
//   revert_sale     { receiptId }                             -> savdoni bekor qilish/qaytarish (faqat revertMinutes ichida)
//   upsert_debtor   { id?, name, org, phone, telegramUsername, viewScope }
//   delete_debtor   { id }
//   send_debt_reminder { debtorId }          -> shu odamga batafsil eslatma
//   update_settings { patch:{shopName,currencySymbol,lowStockThreshold,
//                             overdueDaysGlobal,telegramNotifyLowStock,
//                             telegramNotifyOverdueDebts,telegramNotifyDailyReport} }
//   upsert_admin    { name, phone, username, chatId? }
//   remove_admin    { chatId?, username?, phone? }
//   upsert_customer { id?, name, phone, telegramUsername, tierOverride? }   -> sodiqlik mijozi (tierOverride: '' yoki admin sozlagan daraja id'si)
//   delete_customer { id }
//   adjust_customer_points { id, delta, reason? }            -> ball qo'lda +/-
//   upsert_seller   { id?, name, pin, telegramUsername }     -> xodim/sotuvchi
//   remove_seller   { id }
//   create_order    { items:[{productId,qty}], usePoints? }  -> mijoz (admin EMAS): savatni buyurtma qiladi, admin botdan tasdiqlaydi
//   create_coin_order { productId, qty? }                    -> mijoz: BITTA tovarni FAQAT COIN evaziga sotib olish so'rovi, admin botdan tasdiqlaydi/bekor qiladi
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');
const { verifyInitData } = require('./_miniapp-auth');
const { productCoinCost, getCoinSettings, isCoinEnabled } = require('./_loyalty');
const { hasPermission } = require('./_permissions');
const { logAction } = require('./_audit');

function getDb() { return require('./_firebase').getDb(); }
const { getSettings, invalidateSettingsCache } = require('./_firebase');

function uid() { return Date.now().toString(36) + require('crypto').randomBytes(5).toString('hex'); }
function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
// YANGI (MUHIM): index.html/telegram-webhook.js bilan bir xil — admin
// o'zi yozgan xabar shablonlarini ({dokon},{summa},{mijoz},{qoldiq} kabi
// o'rin bosuvchilar bilan) shu yerda (Mini App orqali sotuv/to'lov/
// coinga sotib olish amallarida) ham qo'llash uchun.
function fillTelegramTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}
function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }

const { computeCustomerTier } = require('./_loyalty');

// ============ v7: UMUMIY HISOB-KITOB YORDAMCHILARI ============
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_LINES = 100, MAX_QTY = 1000000;
// Savat qatorlarini tekshiradi va BIR XIL tovarni birlashtiradi (ilgari bir
// tovar ikki qatorda yuborilsa, zaxira har qator uchun ALOHIDA tekshirilib,
// omborda bor sondan KO'P sotish mumkin edi).
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES) return { error: 'no_items' };
  const map = new Map();
  for (const it of items) {
    const pid = it && typeof it.productId === 'string' ? it.productId.trim() : '';
    const qty = Number(it && it.qty);
    if (!pid || pid.includes('/')) return { error: 'bad_product' };
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return { error: 'bad_qty' };
    map.set(pid, (map.get(pid) || 0) + qty);
  }
  return { items: [...map].map(([productId, qty]) => ({ productId, qty })) };
}
// Zaxirani ATOMIK (tranzaksiya) kamaytiradi: tekshirish va yozish orasida
// boshqa sotuv kirib qolsa ham zaxira manfiyga ketmaydi.
async function reserveStock(db, lines) {
  await db.runTransaction(async (tx) => {
    const snaps = await Promise.all(lines.map((x) => tx.get(x.ref)));
    snaps.forEach((sn, i) => {
      if (!sn.exists) { const e = new Error('product_not_found'); e.code = 'product_not_found'; throw e; }
      if ((Number(sn.data().stock) || 0) < lines[i].qty) { const e = new Error('not_enough_stock'); e.code = 'not_enough_stock'; e.productName = sn.data().name; throw e; }
    });
    lines.forEach((x) => tx.update(x.ref, { stock: admin.firestore.FieldValue.increment(-x.qty) }));
  });
}
async function releaseStock(lines) {
  await Promise.allSettled(lines.map((x) => x.ref.update({ stock: admin.firestore.FieldValue.increment(x.qty) })));
}


async function tgSendMessage(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('tgSendMessage xatolik:', e && e.message); }
}

// Bitta qarz uchun "nima uchun qarzdorligi" batafsil matnini quradi:
// tovar nomlari, miqdori va narxi bilan.
function debtDetailText(d, currencySymbol) {
  let text = `📅 ${new Date(d.date).toLocaleDateString('uz-UZ')} — <b>${fmt(debtRemaining(d))} ${esc(currencySymbol)}</b>\n`;
  if (Array.isArray(d.items) && d.items.length) {
    d.items.forEach((it) => {
      text += `   • ${esc(it.productName)} — ${it.qty} ta × ${fmt(it.price)} = ${fmt(it.subtotal || it.qty * it.price)} ${esc(currencySymbol)}\n`;
    });
  }
  if (d.note) text += `   📝 Izoh: ${esc(d.note)}\n`;
  return text;
}
// YANGI: qarzning BARCHA (qisman) to'lovlari tarixini — sanasi va summasi
// bilan — ko'p qatorli matn ko'rinishida tayyorlaydi. Ilgari qisman
// to'lovlarda mijoz/admin faqat "shu safargi summa"ni ko'rar, oldingi
// to'lovlar tarixini ko'rmas edi.
function debtPaymentHistoryText(d, currencySymbol) {
  if (!Array.isArray(d.payments) || !d.payments.length) return '';
  return d.payments.map((p, i) => `   ${i + 1}) ${new Date(p.date).toLocaleString('uz-UZ')} — ${fmt(p.amount)} ${esc(currencySymbol)}`).join('\n');
}
// YANGI: admin qarzdorning Telegram xabarlarida qanday ko'rsatilishini
// tanlashi mumkin (index.html'dagi debtorDisplayNameForNotify() bilan
// bir xil sozlamalarni o'qiydi).
function debtorDisplayNameForNotify(d, settings) {
  const style = settings.telegramDebtorNameStyle || 'full';
  if (style === 'generic') return settings.telegramDebtorGenericWord || 'Hurmatli mijoz';
  if (style === 'nameonly') return d.debtorName || d.org || '';
  return `${d.debtorName || d.org || ''}${d.org ? ' (' + d.org + ')' : ''}`;
}
// YANGI: to'lov xabarida ko'rsatiladigan TO'LIQ tafsilot bloki — umumiy
// qarz, hozirgacha jami to'langan, qoldiq, va (agar bor bo'lsa) barcha
// qisman to'lovlar tarixi. Ilgari faqat "shu safargi summa + qoldiq"
// ko'rsatilardi.
function debtPaymentDetailBlock(d, isFullyPaid, remainingAfter, currencySymbol) {
  const history = debtPaymentHistoryText(d, currencySymbol);
  return `\n\n📊 <b>Qarz holati:</b>\n📅 Qarz olingan sana: ${new Date(d.date).toLocaleString('uz-UZ')}\n💳 Umumiy qarz: ${fmt(d.total)} ${esc(currencySymbol)}\n✅ Jami to'langan: ${fmt(d.paidAmount || 0)} ${esc(currencySymbol)}\n${isFullyPaid ? "🎉 <b>To'liq to'landi!</b>" : `⏳ Qolgan qarz: <b>${fmt(remainingAfter)} ${esc(currencySymbol)}</b>`}${history ? `\n\n💰 <b>To'lovlar tarixi:</b>\n${history}` : ''}`;
}

// YANGI: "Qarz limiti". Har bir qarzdorda ixtiyoriy `creditLimit` maydoni
// bo'lishi mumkin (0/bo'sh — cheklovsiz). Agar bo'lmasa, umumiy sozlamadagi
// `defaultCreditLimit` ishlatiladi (u ham 0/bo'sh bo'lsa — cheklovsiz).
// Qaytaradi: { limit, currentRemaining, wouldExceed }.
async function checkCreditLimit(db, debtorData, settings, newAmount) {
  const limit = (debtorData && debtorData.creditLimit) ? Number(debtorData.creditLimit) : (Number(settings.defaultCreditLimit) || 0);
  if (!limit || limit <= 0) return { limit: 0, currentRemaining: 0, wouldExceed: false };
  const snap = await db.collection('debts').where('debtorId', '==', debtorData.id).where('paid', '==', false).get();
  const currentRemaining = snap.docs.reduce((a, d) => a + debtRemaining(d.data()), 0);
  return { limit, currentRemaining, wouldExceed: (currentRemaining + newAmount) > limit };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  try {
    const { initData, action, payload } = req.body || {};
    if (typeof initData !== 'string' || initData.length > 4096 || typeof action !== 'string') { res.status(400).json({ ok: false, error: 'bad_request' }); return; }
    const db = getDb();
    const settingsRef = db.collection('dokon').doc('settings');
    // TEZLASHTIRISH: qisqa muddatli xotira-keshi (batafsil izoh uchun
    // api/_firebase.js'ga qarang) — bu amal ENDPOINT'i admin panelidan
    // tez-tez (har bir tugma bosilganda) chaqiriladi.
    const settings = await getSettings(db);
    if (!settings) { res.status(400).json({ ok: false, error: 'no_settings' }); return; }
    const token = (settings.telegramBotToken || '').trim();
    const currencySymbol = settings.currencySymbol || "so'm";
    const shopName = settings.shopName || "Do'kon";

    const user = verifyInitData(initData, token);
    if (!user) { res.status(401).json({ ok: false, error: 'invalid_init_data' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    // YANGI (Xavfsizlik/rollar): endi shunchaki "adminmi/emasmi" emas, balki
    // BUTUN admin yozuvi (role + permissions) saqlanadi — quyida har bir
    // xavfli amal shu yozuv asosida (forbid()) tekshiriladi.
    const adminEntry = admins.find((a) => String(a.chatId).trim() === chatId) || null;
    const isAdmin = !!adminEntry;
    const actorName = (adminEntry && adminEntry.name) || (user.first_name || '') + (user.last_name ? ' ' + user.last_name : '') || 'Admin';
    const p = payload || {};
    // Ruxsat yo'q bo'lsa 403 qaytaradi (va true qaytaradi — chaqiruvchi
    // shundan keyin darhol `return` qilishi kerak).
    function forbid(permKey) {
      if (!hasPermission(adminEntry, permKey)) {
        res.status(403).json({ ok: false, error: 'no_permission', permission: permKey });
        return true;
      }
      return false;
    }
    // Har bir muhim amaldan so'ng chaqiriladi — xatolik bo'lsa ham asosiy
    // amalga ta'sir qilmaydi (logAction ichida try/catch bor).
    function audit(action, detail) {
      logAction(db, { source: 'miniapp', actorName, actorChatId: chatId, action, detail });
    }

    // ---------------- MIJOZ (SODIQLIK DASTURI): BUYURTMA BERISH ----------------
    // Bu yagona amal — admin bo'lmagan foydalanuvchi ham chaqira oladi
    // (mijoz mini-ilova katalogidan tovar tanlab "Sotib olish" bosganda).
    // Boshqa barcha amallar hamon faqat admin uchun.
    if (action === 'create_order') {
      if (isAdmin) { res.status(400).json({ ok: false, error: 'admins_cannot_order' }); return; }
      const { usePoints } = p;
      const norm = normalizeItems(p.items);
      if (norm.error) { res.status(400).json({ ok: false, error: norm.error }); return; }
      const items = norm.items;

      const customerSnap = await db.collection('customers').where('telegramChatId', '==', chatId).limit(1).get();
      if (customerSnap.empty) { res.status(400).json({ ok: false, error: 'not_registered' }); return; }
      const customerRef = customerSnap.docs[0].ref;
      const customerData = customerSnap.docs[0].data();
      // v7: spamdan himoya — bitta mijozda 5 tadan ortiq kutilayotgan buyurtma bo'lmasin
      const pendingSnap = await db.collection('orders').where('customerChatId', '==', chatId).where('status', '==', 'pending').limit(6).get();
      if (pendingSnap.size >= 5) { res.status(429).json({ ok: false, error: 'too_many_pending' }); return; }

      // TUZATILDI: ilgari bu yerda "narx/10000" va "1 coin = 100 so'm"
      // qattiq yozilgan edi — admin sozlamalardan (coinSettings) coin
      // qoidasini o'zgartirsa ham, mini-ilova katalogidan to'g'ridan-to'g'ri
      // buyurtma berishda ESKI (10000/100) nisbat ishlatilardi. Endi
      // boshqa hamma joy (chek orqali coin, coinga sotib olish) kabi
      // markazlashtirilgan getCoinSettings() dan foydalanadi.
      const { earnPerAmount, redeemValuePerCoin } = getCoinSettings(settings);

      const productRefs = items.map((it) => db.collection('products').doc(String(it.productId)));
      const productSnaps = await Promise.all(productRefs.map((r) => r.get()));
      const lineItems = [];
      for (let i = 0; i < items.length; i++) {
        const snap = productSnaps[i];
        const qty = parseInt(items[i].qty, 10);
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
        const prod = snap.data();
        if (!qty || qty <= 0) { res.status(400).json({ ok: false, error: 'bad_qty' }); return; }
        if ((prod.stock || 0) < qty) { res.status(400).json({ ok: false, error: 'not_enough_stock', productName: prod.name }); return; }
        const unitPoints = (prod.points || prod.points === 0) ? Math.max(0, parseInt(prod.points, 10) || 0) : Math.floor((prod.price || 0) / earnPerAmount);
        const subtotal = (prod.price || 0) * qty;
        lineItems.push({ productId: snap.id, name: prod.name, qty, price: Number(prod.price) || 0, points: unitPoints * qty, subtotal: round2((Number(prod.price) || 0) * qty) });
      }
      const total = round2(lineItems.reduce((a, x) => a + x.subtotal, 0));
      const totalPoints = isCoinEnabled(settings) ? lineItems.reduce((a, x) => a + x.points, 0) : 0;

      // Ball bilan to'lash: 1 ball = redeemValuePerCoin so'm chegirma (admin
      // sozlagan qiymat). Mijozning ballari yetarli bo'lmasa, faqat mavjud
      // qadar ishlatiladi, qolgani naqd bo'ladi.
      let pointsUsed = 0, cashDue = total;
      // YANGI: COIN o'chirilgan bo'lsa — ball/coin bilan to'lash imkoni
      // yo'q, hammasi naqd hisoblanadi (usePoints bo'lsa ham e'tiborsiz
      // qoldiriladi).
      if (usePoints && isCoinEnabled(settings)) {
        const neededPoints = Math.ceil(total / redeemValuePerCoin);
        pointsUsed = Math.min(Math.max(0, Math.floor(Number(customerData.points) || 0)), neededPoints);
        cashDue = round2(Math.max(0, total - pointsUsed * redeemValuePerCoin));
      }

      const orderRef = db.collection('orders').doc();
      const now = new Date().toISOString();
      const orderDoc = {
        id: orderRef.id, customerId: customerRef.id, customerName: customerData.name || '', customerChatId: chatId,
        items: lineItems, total, totalPoints, usePoints: !!usePoints, pointsUsed, cashDue,
        status: 'pending', createdAt: now,
      };
      await orderRef.set(orderDoc);

      // Barcha (chatId ulangan) adminlarga buyurtma haqida xabar — Tasdiqlash
      // yoki Bekor qilish tugmalari bilan.
      let text = `🛒 <b>Yangi buyurtma!</b>\n\n👤 Mijoz: <b>${esc(customerData.name || 'Noma\'lum')}</b>\n\n`;
      lineItems.forEach((it) => { text += `• ${esc(it.name)} — ${it.qty} ta × ${fmt(it.price)} ${esc(currencySymbol)} = ${fmt(it.subtotal)} ${esc(currencySymbol)}\n`; });
      text += `\n💰 Jami: <b>${fmt(total)} ${esc(currencySymbol)}</b>\n`;
      if (pointsUsed > 0) text += `⭐ Balldan to'langan: <b>${pointsUsed} ball</b> (${fmt(pointsUsed * redeemValuePerCoin)} ${esc(currencySymbol)})\n💵 Naqd to'lanadigan: <b>${fmt(cashDue)} ${esc(currencySymbol)}</b>\n`;
      else text += `💵 To'lov turi: Naqd pul\n`;
      text += `\n✅ Tasdiqlasangiz — tovar avtomatik sotiladi va ombordan yechiladi.`;
      const keyboard = { inline_keyboard: [[
        { text: '✅ Tasdiqlash', callback_data: `order_confirm:${orderRef.id}` },
        { text: '❌ Bekor qilish', callback_data: `order_cancel:${orderRef.id}` },
      ]] };
      const targets = admins.filter((a) => a.chatId).map((a) => a.chatId);
      await Promise.allSettled(targets.map((cid) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text, parse_mode: 'HTML', reply_markup: keyboard }),
      })));

      res.status(200).json({ ok: true, orderId: orderRef.id, total, pointsUsed, cashDue });
      return;
    }

    // ---------------- MIJOZ: BITTA TOVARNI FAQAT COIN EVAZIGA SOTIB OLISH ----------------
    // YANGI: "Sodiqlik ballari" endi "COIN" deb ataladi. Mijoz mini-ilova
    // katalogidan bitta tovarni tanlab, uni TO'LIQ coin evaziga (naqd
    // pulsiz) sotib olish so'rovini yuboradi. Kerakli coin miqdori —
    // mahsulotda alohida belgilangan "coinCost" (yoki bo'lmasa, umumiy
    // sozlamadagi narx/qiymat formulasidan avtomatik hisoblanadi). Coin
    // yetarli bo'lmasa so'rov yaratilmaydi. Admin botdan Tasdiqlash/Bekor
    // qilish tugmasi bilan qaror qabul qiladi (coinOrders to'plami,
    // handleCoinOrderDecision — telegram-webhook.js).
    if (action === 'create_coin_order') {
      // YANGI: admin COIN funksiyasini o'chirib qo'ygan bo'lsa — yangi
      // coinga sotib olish so'rovi umuman yaratilmaydi.
      if (!isCoinEnabled(settings)) { res.status(400).json({ ok: false, error: 'coin_disabled' }); return; }
      if (isAdmin) { res.status(400).json({ ok: false, error: 'admins_cannot_order' }); return; }
      const productId = String(p.productId || '');
      const qty = Math.min(MAX_QTY, Math.max(1, parseInt(p.qty, 10) || 1));
      if (!productId || productId.includes('/')) { res.status(400).json({ ok: false, error: 'no_product' }); return; }

      const customerSnap = await db.collection('customers').where('telegramChatId', '==', chatId).limit(1).get();
      if (customerSnap.empty) { res.status(400).json({ ok: false, error: 'not_registered' }); return; }
      const customerRef = customerSnap.docs[0].ref;
      const customerData = customerSnap.docs[0].data();

      const productSnap = await db.collection('products').doc(productId).get();
      if (!productSnap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      const prod = productSnap.data();
      if ((prod.stock || 0) < qty) { res.status(400).json({ ok: false, error: 'not_enough_stock', productName: prod.name }); return; }

      const unitCoinCost = productCoinCost(prod, settings);
      const totalCoinCost = unitCoinCost * qty;
      // v7: kutilayotgan (hali tasdiqlanmagan) coin buyurtmalar ham hisobga olinadi —
      // aks holda mijoz balansidan ko'p buyurtma yig'ib, adminni chalg'itishi mumkin edi.
      const pendCoin = await db.collection('coinOrders').where('customerChatId', '==', chatId).where('status', '==', 'pending').limit(20).get();
      const reserved = pendCoin.docs.reduce((a, d) => a + (Number(d.data().totalCoinCost) || 0), 0);
      const balance = Math.max(0, Math.floor(Number(customerData.points) || 0)) - reserved;
      if (balance < totalCoinCost) { res.status(400).json({ ok: false, error: 'not_enough_coins', need: totalCoinCost, have: balance }); return; }

      const coinOrderRef = db.collection('coinOrders').doc();
      const now = new Date().toISOString();
      const coinOrderDoc = {
        id: coinOrderRef.id, customerId: customerRef.id, customerName: customerData.name || '', customerChatId: chatId,
        productId, productName: prod.name || '', qty, unitCoinCost, totalCoinCost,
        status: 'pending', createdAt: now,
      };
      await coinOrderRef.set(coinOrderDoc);

      let text = `🪙 <b>Yangi COIN xarid so'rovi!</b>\n\n👤 Mijoz: <b>${esc(customerData.name || "Noma'lum")}</b>\n📦 Tovar: <b>${esc(prod.name)}</b> — ${qty} ta\n🪙 Coin narxi: <b>${totalCoinCost}</b> (mijozda: ${balance})\n\n✅ Tasdiqlasangiz — tovar sotiladi, ombordan yechiladi va mijozning coinidan ${totalCoinCost} ta ayiriladi.`;
      const keyboard = { inline_keyboard: [[
        { text: '✅ Tasdiqlash', callback_data: `coinorder_confirm:${coinOrderRef.id}` },
        { text: '❌ Bekor qilish', callback_data: `coinorder_cancel:${coinOrderRef.id}` },
      ]] };
      const targets = admins.filter((a) => a.chatId).map((a) => a.chatId);
      await Promise.allSettled(targets.map((cid) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text, parse_mode: 'HTML', reply_markup: keyboard }),
      })));

      res.status(200).json({ ok: true, coinOrderId: coinOrderRef.id, totalCoinCost });
      return;
    }

    if (!isAdmin) { res.status(403).json({ ok: false, error: 'not_admin' }); return; }

    // ---------------- QARZGA TO'LOV ----------------
    if (action === 'pay_debt') {
      if (forbid('manageDebts')) return;
      const { debtId, amount } = p;
      const amt = parseFloat(amount);
      if (typeof debtId !== 'string' || !debtId || !isFinite(amt) || Math.round(amt) <= 0) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const debtRef = db.collection('debts').doc(debtId);
      // TUZATILDI (poyga holati / race condition): ilgari bu yerda avval
      // debtRef.get() bilan o'qib, "qancha to'landi"/"to'liq yopildimi"
      // degan qarorni O'SHA (eskirishi mumkin bo'lgan) qiymat asosida qabul
      // qilib, keyin alohida update() bilan yozar edi. Agar shu paytda bot
      // yoki index.html tomonidan HAM shu qarzga to'lov yozilsa (masalan
      // tugma tasodifan ikki marta bosilsa), ikkalasi ham bir xil eski
      // qiymatni ko'rar, natijada qarz limitidan oshib to'lov yozilishi
      // yoki paid:true belgisi umuman qo'yilmay qolishi mumkin edi — garchi
      // paidAmount FieldValue.increment() tufayli yig'indi to'g'ri chiqsa
      // ham. Endi butun o'qish+yozish db.runTransaction() ichida, ATOMIK
      // bajariladi — Firestore boshqa parallel yozuv bo'lsa, tranzaksiyani
      // avtomatik qayta urinadi va har doim ENG YANGI ma'lumot asosida
      // hisoblaydi.
      let d, applied, paymentRec, isFullyPaid, remaining;
      try {
        await db.runTransaction(async (tx) => {
          const debtSnap = await tx.get(debtRef);
          if (!debtSnap.exists) { const e = new Error('debt_not_found'); e.code = 404; throw e; }
          d = debtSnap.data();
          remaining = debtRemaining(d);
          if (remaining <= 0) { const e = new Error('already_paid'); e.code = 400; throw e; }
          applied = Math.min(Math.round(amt), Math.round(remaining));
          paymentRec = { amount: applied, date: new Date().toISOString(), note: 'Mini App orqali', by: 'Telegram admin' };
          const newPaidAmount = (d.paidAmount || 0) + applied;
          isFullyPaid = d.total - newPaidAmount <= 0.5;
          const patch = { paidAmount: newPaidAmount, payments: Array.isArray(d.payments) ? d.payments.concat([paymentRec]) : [paymentRec] };
          if (isFullyPaid) { patch.paid = true; patch.paidDate = paymentRec.date; }
          tx.update(debtRef, patch);
        });
      } catch (e) {
        if (e.code === 404) { res.status(404).json({ ok: false, error: 'debt_not_found' }); return; }
        if (e.code === 400) { res.status(400).json({ ok: false, error: 'already_paid' }); return; }
        throw e;
      }
      audit('pay_debt', `${d.debtorName || ''} — ${fmt(applied)} ${currencySymbol}${isFullyPaid ? ' (to\'liq yopildi)' : ''}`);

      // YANGI (MUHIM — TO'LIQ BATAFSIL): "d" hali TRANZAKSIYADAN OLDINGI
      // (eski paidAmount/payments) holatni saqlaydi — xabarda esa YANGI
      // (shu to'lovdan keyingi) holat kerak: umumiy qarz, jami to'langan,
      // qoldiq, va barcha to'lovlar tarixi (ayniqsa qisman to'lovlarda).
      const dAfter = { ...d, paidAmount: (d.paidAmount || 0) + applied, payments: Array.isArray(d.payments) ? d.payments.concat([paymentRec]) : [paymentRec] };
      const includeItems = settings.telegramDebtIncludeItems !== false;
      const detailBlock = includeItems ? debtPaymentDetailBlock(dAfter, isFullyPaid, remaining - applied, currencySymbol) : '';
      const payVars = { dokon: shopName, mijoz: d.debtorName || d.org || '', summa: fmt(applied), qoldiq: isFullyPaid ? 0 : fmt(remaining - applied), qarz_sanasi: new Date(d.date).toLocaleString('uz-UZ'), tolov_sanasi: new Date(paymentRec.date).toLocaleString('uz-UZ'), umumiy: fmt(d.total), jami_tolangan: fmt(dAfter.paidAmount) };

      // TUZATILDI (MUHIM): ilgari bu yerda ADMINGA hech qanday xabar
      // ketmasdi (faqat mijozning o'ziga ketardi) — Mini App orqali
      // to'lov qabul qilinganda admin buni faqat panelni ochib
      // ko'rgandagina bilardi.
      if (settings.telegramNotifyPayment !== false) {
        const adminTargets = admins.filter((a) => a.chatId).map((a) => a.chatId);
        if (adminTargets.length) {
          const adminText = settings.telegramTplPaymentAdmin
            ? `<b>${esc(shopName)}</b>\n\n` + esc(fillTelegramTemplate(settings.telegramTplPaymentAdmin, payVars))
            : `💵 <b>To'lov qabul qilindi</b> — ${esc(shopName)}\n\n👤 ${esc(d.debtorName || d.org || '')}\n➕ Shu safar: ${fmt(applied)} ${esc(currencySymbol)}${detailBlock}`;
          await Promise.allSettled(adminTargets.map((cid) => tgSendMessage(token, cid, adminText)));
        }
      }

      if (d.debtorId) {
        const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
        const cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
        if (cid && settings.telegramNotifyPayment !== false) {
          // TUZATILDI: ilgari admin sozlagan xabar shabloni
          // (telegramTplPayment) bu yerda umuman e'tiborga olinmasdi.
          const custDisplayName = debtorDisplayNameForNotify(d, settings);
          const custText = settings.telegramTplPayment
            ? `<b>${esc(shopName)}</b>\n\n` + esc(fillTelegramTemplate(settings.telegramTplPayment, payVars))
            : `💵 <b>${esc(shopName)}</b>\n\nHurmatli ${esc(custDisplayName)}, ${fmt(applied)} ${esc(currencySymbol)} to'lovingiz qabul qilindi.${detailBlock}`;
          await tgSendMessage(token, cid, custText);
        }
      }
      res.status(200).json({ ok: true, applied, remaining: remaining - applied, fullyPaid: isFullyPaid });
      return;
    }

    // ---------------- ESKI: FAQAT NARX (moslik uchun saqlab qolindi) ----------------
    if (action === 'update_price') {
      if (forbid('manageProducts')) return;
      const { productName, price } = p;
      const newPrice = parseFloat(price);
      if (!productName || isNaN(newPrice) || newPrice < 0) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const productsSnap = await db.collection('products').where('name', '==', productName).get();
      if (productsSnap.empty) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      await productsSnap.docs[0].ref.update({ price: newPrice });
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- TOVAR: YARATISH / TAHRIRLASH / O'CHIRISH ----------------
    if (action === 'create_product') {
      if (forbid('manageProducts')) return;
      const { name, price, cost, points, coinCost, stock, volume, note, img } = p;
      if (!name || isNaN(parseFloat(price))) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      // TUZATILDI: narx/tannarx/miqdor manfiy bo'lishi mumkin emas — ilgari
      // bu yerda tekshirilmagani uchun (server — haqiqiy xavfsizlik
      // chegarasi, index.html'dagi tekshiruv esa faqat qulaylik uchun va
      // devtools orqali chetlab o'tilishi mumkin edi) manfiy narxli
      // mahsulot yaratilishi mumkin edi, bu esa keyinchalik barcha
      // hisob-kitoblarni (savdo summasi, hisobotlar) buzardi.
      if (parseFloat(price) < 0 || (cost != null && parseFloat(cost) < 0) || (stock != null && parseInt(stock, 10) < 0)) {
        res.status(400).json({ ok: false, error: 'negative_values_not_allowed' }); return;
      }
      const id = uid();
      const doc = {
        id, name: String(name).trim(), price: parseFloat(price) || 0, cost: parseFloat(cost) || 0,
        points: (points === null || points === undefined || points === '') ? null : Math.max(0, parseInt(points, 10) || 0),
        coinCost: (coinCost === null || coinCost === undefined || coinCost === '') ? null : Math.max(0, parseInt(coinCost, 10) || 0),
        stock: parseInt(stock, 10) || 0, volume: volume || '', note: note || '', img: img || '',
      };
      await db.collection('products').doc(id).set(doc);
      res.status(200).json({ ok: true, product: doc });
      return;
    }

    if (action === 'update_product') {
      if (forbid('manageProducts')) return;
      const { id, patch } = p;
      if (!id || !patch) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      // TUZATILDI: create_product bilan bir xil sabab — narx/tannarx/
      // miqdor manfiy bo'lishi mumkin emas.
      if (patch.price !== undefined && parseFloat(patch.price) < 0) { res.status(400).json({ ok: false, error: 'negative_values_not_allowed' }); return; }
      if (patch.cost !== undefined && parseFloat(patch.cost) < 0) { res.status(400).json({ ok: false, error: 'negative_values_not_allowed' }); return; }
      if (patch.stock !== undefined && parseInt(patch.stock, 10) < 0) { res.status(400).json({ ok: false, error: 'negative_values_not_allowed' }); return; }
      const allowed = ['name', 'price', 'cost', 'points', 'coinCost', 'stock', 'volume', 'note', 'img'];
      const clean = {};
      allowed.forEach((k) => {
        if (patch[k] === undefined) return;
        if (k === 'price' || k === 'cost') clean[k] = parseFloat(patch[k]) || 0;
        else if (k === 'stock') clean[k] = parseInt(patch[k], 10) || 0;
        else if (k === 'points' || k === 'coinCost') clean[k] = (patch[k] === null || patch[k] === '') ? null : Math.max(0, parseInt(patch[k], 10) || 0);
        else clean[k] = patch[k];
      });
      if (!Object.keys(clean).length) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const ref = db.collection('products').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      await ref.update(clean);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete_product') {
      if (forbid('manageProducts') || forbid('deleteRecords')) return;
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const pSnap = await db.collection('products').doc(id).get();
      await db.collection('products').doc(id).delete();
      audit('delete_product', pSnap.exists ? pSnap.data().name : id);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'restock') {
      if (forbid('manageProducts')) return;
      const { id, qty } = p;
      const q = parseInt(qty, 10);
      if (!id || isNaN(q) || q <= 0) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const ref = db.collection('products').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      await ref.update({ stock: admin.firestore.FieldValue.increment(q) });
      const rId = uid();
      await db.collection('restocks').doc(rId).set({
        id: rId, productId: id, productName: snap.data().name, qty: q, date: new Date().toISOString(), by: 'Mini App orqali',
      });
      res.status(200).json({ ok: true, newStock: (snap.data().stock || 0) + q });
      return;
    }

    // ---------------- SOTISH (naqd yoki nasiya/qarzga) ----------------
    if (action === 'sell') {
      const { mode, debtorId, phone, note, dueDate, customerId, forceOverLimit } = p;
      const name = String(p.name || '').trim();   // v7: trim — ilgari bo'sh joyli ism takroriy qarzdor yaratardi
      const org = String(p.org || '').trim();
      const norm = normalizeItems(p.items);
      if (norm.error) { res.status(400).json({ ok: false, error: norm.error }); return; }
      const items = norm.items;
      if (mode === 'debt') {
        if (forbid('manageDebts')) return;
        if (!debtorId && !name) { res.status(400).json({ ok: false, error: 'debtor_name_required' }); return; }
        if (debtorId && typeof debtorId !== 'string') { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
        if (dueDate && !/^\d{4}-\d{2}-\d{2}/.test(String(dueDate))) { res.status(400).json({ ok: false, error: 'bad_due_date' }); return; }
      }

      const productRefs = items.map((it) => db.collection('products').doc(it.productId));
      const productSnaps = await Promise.all(productRefs.map((r) => r.get()));
      const lineItems = [];
      for (let i = 0; i < items.length; i++) {
        const snap = productSnaps[i];
        const qty = items[i].qty;
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
        const prod = snap.data();
        if ((Number(prod.stock) || 0) < qty) { res.status(400).json({ ok: false, error: 'not_enough_stock', productName: prod.name }); return; }
        const price = Number(prod.price) || 0;
        lineItems.push({ ref: snap.ref, product: { ...prod, id: snap.id, price }, qty, subtotal: round2(price * qty) });
      }
      const total = round2(lineItems.reduce((a, x) => a + x.subtotal, 0));
      const now = new Date().toISOString();
      const seller = 'Admin (Mini App)';
      const receiptId = uid();

      // v7 (MUHIM TUZATISH): qarzdor va kredit limiti zaxira kamaytirilishidan OLDIN
      // tekshiriladi. Ilgari zaxira avval yechilar, keyin "qarzdor topilmadi" (404)
      // bo'lsa ombor tiklanmasdan qolib ketardi (tovar "yo'qolardi").
      let debtorRef, debtorData, newDebtor = false;
      if (mode === 'debt') {
        if (debtorId) {
          const s0 = await db.collection('debtors').doc(debtorId).get();
          if (!s0.exists) { res.status(404).json({ ok: false, error: 'debtor_not_found' }); return; }
          debtorRef = s0.ref; debtorData = s0.data();
        } else {
          const existingSnap = org
            ? await db.collection('debtors').where('org', '==', org).where('name', '==', name).get()
            : await db.collection('debtors').where('name', '==', name).get();
          const existing = existingSnap.docs.find((d2) => (org ? d2.data().org === org : !d2.data().org));
          if (existing) { debtorRef = existing.ref; debtorData = existing.data(); }
          else {
            const newId = uid();
            debtorData = { id: newId, name, org, phone: phone || '', login: '', password: '', createdAt: now, viewScope: 'own' };
            debtorRef = db.collection('debtors').doc(newId);
            newDebtor = true;
          }
        }
        const limitCheck = await checkCreditLimit(db, debtorData, settings, total);
        if (limitCheck.wouldExceed && !forceOverLimit) {
          res.status(409).json({ ok: false, error: 'credit_limit_exceeded', limit: limitCheck.limit, currentRemaining: limitCheck.currentRemaining, newAmount: total });
          return;
        }
      }

      // Zaxirani ATOMIK kamaytirish (tekshirish + yechish bitta tranzaksiyada)
      try { await reserveStock(db, lineItems); }
      catch (e) {
        if (e.code === 'not_enough_stock') { res.status(400).json({ ok: false, error: 'not_enough_stock', productName: e.productName }); return; }
        if (e.code === 'product_not_found') { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
        throw e;
      }

      // Savdo qatorlari: hujjat ID si va `id` maydoni BIR XIL (ilgari har xil uid() edi)
      const makeRows = (extra, perLine) => lineItems.map((x) => {
        const id = uid();
        return { id, receiptId, productId: x.product.id, productName: x.product.name, volume: x.product.volume || '', qty: x.qty, price: x.product.price,
          cost: Number(x.product.cost) || 0, total: x.subtotal, seller, date: now, reverted: false, ...extra, ...(perLine ? perLine(x) : {}) };
      });
      const writeRows = (rows) => Promise.all(rows.map((r) => db.collection('sales').doc(r.id).set(r)));

      if (mode === 'debt') {
        if (newDebtor) { try { await debtorRef.set(debtorData); } catch (err) { await releaseStock(lineItems); throw err; } }

        const debtItems = lineItems.map((x) => ({ productId: x.product.id, productName: x.product.name, volume: x.product.volume || '', qty: x.qty, price: x.product.price, subtotal: x.subtotal }));
        const debtId = uid();
        const debtDoc = {
          id: debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '', phone: debtorData.phone || '',
          items: debtItems, total, receiptId, paid: false, paidDate: null, date: now, dueDate: dueDate || null, note: note || '', seller, type: debtorData.org ? 'organization' : 'person',
        };
        try {
          await db.collection('debts').doc(debtId).set(debtDoc);
          await writeRows(makeRows({ isDebt: true, debtorName: debtorData.name, org: debtorData.org || '' }));
        } catch (err) {
          await db.collection('debts').doc(debtId).delete().catch(() => {});
          await releaseStock(lineItems);
          throw err;
        }

        // TUZATILDI (MUHIM): ilgari Mini App orqali (masalan bot ichida)
        // nasiyaga sotilganda ADMINGA HECH QANDAY xabar ketmasdi — faqat
        // mijozning o'ziga (agar ulangan bo'lsa) ketardi. Endi index.html
        // (brauzer) orqali qilingan sotuv bilan bir xil — adminlarga ham
        // xabar ketadi, va admin "📦 mahsulot va vaqtni ko'rsatish"
        // sozlamasini yoqib/o'chirib qo'yishi mumkin.
        if (settings.telegramNotifyNewDebt !== false) {
          const includeItems = settings.telegramDebtIncludeItems !== false;
          const itemsBlock = includeItems ? debtDoc.items.map((i) => `• ${i.productName}${i.volume ? ' (' + i.volume + 'L)' : ''} × ${i.qty} — ${fmt(i.subtotal)} ${currencySymbol}`).join('\n') : '';
          const timeLine = includeItems ? `\n🕒 Vaqti: ${new Date(now).toLocaleString('uz-UZ')}` : '';
          const debtVars = { dokon: shopName, mijoz: debtorData.name + (debtorData.org ? ' (' + debtorData.org + ')' : ''), summa: fmt(total), tovarlar: itemsBlock, sana: new Date(now).toLocaleString('uz-UZ') };
          const adminTargets = admins.filter((a) => a.chatId).map((a) => a.chatId);
          if (adminTargets.length) {
            const adminText = settings.telegramTplNewDebtAdmin
              ? `<b>${esc(shopName)}</b>\n\n` + esc(fillTelegramTemplate(settings.telegramTplNewDebtAdmin, debtVars))
              : `🆕 <b>Yangi qarz</b> — ${esc(shopName)}\n\n👤 ${esc(debtorData.name)}${debtorData.org ? ' (' + esc(debtorData.org) + ')' : ''}${itemsBlock ? `\n\n${esc(itemsBlock)}` : ''}\n💰 Summa: ${fmt(total)} ${esc(currencySymbol)}${timeLine}`;
            await Promise.allSettled(adminTargets.map((cid) => tgSendMessage(token, cid, adminText)));
          }
          if (debtorData.telegramChatId) {
            // TUZATILDI: ilgari bu yerda admin "✍️ Mijozga yuboriladigan
            // xabar matni"da yozgan shabloni UMUMAN e'tiborga olinmasdi —
            // faqat index.html orqali yozilgan qarzda ishlardi. Endi bu
            // yerda ham xuddi shunday qo'llaniladi (shablon bo'lmasa,
            // oldingi batafsil — tovarlar ro'yxati bilan — standart xabar
            // qoladi).
            const custDisplayNameSell = debtorDisplayNameForNotify(debtDoc, settings);
            const text = settings.telegramTplNewDebt
              ? `<b>${esc(shopName)}</b>\n\n` + esc(fillTelegramTemplate(settings.telegramTplNewDebt, debtVars))
              : `🧾 <b>${esc(shopName)}</b>\n\nHurmatli ${esc(custDisplayNameSell)}, sizga yangi qarz yozildi:\n\n${debtDetailText(debtDoc, currencySymbol)}\n💰 Jami: <b>${fmt(total)} ${esc(currencySymbol)}</b>`;
            await tgSendMessage(token, debtorData.telegramChatId, text);
          }
        }
        audit('sell_debt', `${debtorData.name || ''} — ${fmt(total)} ${currencySymbol}`);

        res.status(200).json({ ok: true, total, debtId, debtorId: debtorData.id });
        return;
      }

      // Naqd sotish
      let pointsEarned = 0, custRef = null;
      try {
        if (customerId && typeof customerId === 'string') {
          custRef = db.collection('customers').doc(customerId);
          const custSnap = await custRef.get();
          if (!custSnap.exists) custRef = null;
        }
        if (custRef && isCoinEnabled(settings)) {
          const { earnPerAmount } = getCoinSettings(settings);
          pointsEarned = lineItems.reduce((a, x) => {
            const prod = x.product;
            const unitPoints = (prod.points || prod.points === 0) ? Math.max(0, parseInt(prod.points, 10) || 0) : Math.floor((prod.price || 0) / earnPerAmount);
            return a + unitPoints * x.qty;
          }, 0);
        }
        // Qaytarish (revert) paytida mijoz coini va jami xaridini TO'G'RI ayirish uchun
        // har bir qatorda mijoz va coin saqlanadi (ilgari qaytarishda coin qolib ketardi).
        await writeRows(makeRows({ isDebt: false }, (x) => custRef ? {
          customerId: custRef.id,
          pointsEarned: (() => { const pr = x.product; const eps = getCoinSettings(settings).earnPerAmount; const u = (pr.points || pr.points === 0) ? Math.max(0, parseInt(pr.points, 10) || 0) : Math.floor((pr.price || 0) / eps); return isCoinEnabled(settings) ? u * x.qty : 0; })(),
        } : {}));
        if (custRef) {
          await custRef.update({
            totalSpent: admin.firestore.FieldValue.increment(total),
            purchaseCount: admin.firestore.FieldValue.increment(1),
            points: admin.firestore.FieldValue.increment(pointsEarned),
            lastPurchaseAt: now,
          });
        }
      } catch (err) { await releaseStock(lineItems); throw err; }
      res.status(200).json({ ok: true, total, receiptId, pointsEarned });
      return;
    }

    // ---------------- SAVDONI BEKOR QILISH / QAYTARISH ----------------
    // Web-paneldagi ("index.html") revertSaleGroup/adminRevertGroup bilan BIR
    // XIL mantiq: receiptId bo'yicha barcha (hali qaytarilmagan) savdo
    // qatorlari "reverted:true" deb belgilanadi va omborga tovar qaytariladi.
    // Faqat admin va faqat sozlamalardagi "revertMinutes" oynasi ichida.
    if (action === 'revert_sale') {
      // TUZATILDI (MUHIM — XAVFSIZLIK NOMUVOFIQLIGI): ilgari bu yerda
      // FAQAT "shaxs har qanday turdagi admin ekanligi" (isAdmin)
      // tekshirilardi — boshqa barcha nozik amallar (masalan
      // delete_product) kabi ANIQ huquq (forbid()) tekshirilmasdi. Bu
      // degani: agar admin faqat "manageDebts" huquqi bilan cheklangan
      // bo'lsa ham (masalan qarzlar bilan ishlash uchun qo'shilgan
      // yordamchi), u baribir istalgan savdoni bekor qilib, ombordagi
      // mahsulot sonini o'zgartira olar edi — bu mo'ljallangan
      // cheklovni chetlab o'tish edi. Endi delete_product bilan bir xil
      // huquq talab qilinadi (chunki bekor qilish ham mahsulot/ombor
      // holatini o'zgartiradi, ham savdo yozuvini "o'chiradi").
      if (forbid('manageProducts') || forbid('deleteRecords')) return;
      const { receiptId } = p;
      if (typeof receiptId !== 'string' || !receiptId) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const salesSnap = await db.collection('sales').where('receiptId', '==', receiptId).get();
      const docs = salesSnap.docs.filter((d) => !d.data().reverted);
      if (!docs.length) { res.status(404).json({ ok: false, error: 'sale_not_found' }); return; }
      const revertMinutes = settings.revertMinutes || 30;
      const nowMs = Date.now();
      const expired = docs.some((d) => {
        const t = new Date(d.data().date).getTime();
        return isNaN(t) || (nowMs - t) / 60000 > revertMinutes;
      });
      if (expired) { res.status(400).json({ ok: false, error: 'revert_window_expired' }); return; }

      // v7 (MUHIM TUZATISH): butun qaytarish BITTA tranzaksiyada. Ilgari:
      //  - ikki marta bosilsa ombor 2 marta to'lib ketardi (poyga holati);
      //  - nasiya sotuv qaytarilganda QARZ yozuvi o'chmay qolardi;
      //  - naqd sotuvda mijozning coini/jami xaridi qaytarilmasdi.
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await Promise.all(docs.map((d) => tx.get(d.ref)));
          const live = fresh.filter((f) => f.exists && !f.data().reverted);
          if (!live.length) { const e = new Error('sale_not_found'); e.code = 'sale_not_found'; throw e; }
          const debtSnap = await tx.get(db.collection('debts').where('receiptId', '==', receiptId));
          for (const ds of debtSnap.docs) {
            if ((Number(ds.data().paidAmount) || 0) > 0) { const e = new Error('debt_has_payments'); e.code = 'debt_has_payments'; throw e; }
          }
          const stockBack = new Map();
          let custId = null, pointsBack = 0, spentBack = 0;
          live.forEach((f) => {
            const d = f.data();
            if (d.productId) stockBack.set(d.productId, (stockBack.get(d.productId) || 0) + (Number(d.qty) || 0));
            if (d.customerId) { custId = d.customerId; pointsBack += Number(d.pointsEarned) || 0; spentBack += Number(d.total) || 0; }
          });
          const prodRefs = [...stockBack.keys()].map((id) => db.collection('products').doc(id));
          const prodSnaps = await Promise.all(prodRefs.map((r) => tx.get(r)));
          const custRef = custId ? db.collection('customers').doc(custId) : null;
          const custSnap = custRef ? await tx.get(custRef) : null;

          live.forEach((f) => tx.update(f.ref, { reverted: true, revertedAt: new Date().toISOString() }));
          prodSnaps.forEach((ps) => { if (ps.exists) tx.update(ps.ref, { stock: admin.firestore.FieldValue.increment(stockBack.get(ps.id)) }); });
          debtSnap.docs.forEach((ds) => tx.delete(ds.ref));
          if (custSnap && custSnap.exists) {
            const c = custSnap.data();
            tx.update(custRef, {
              points: Math.max(0, (Number(c.points) || 0) - pointsBack),
              totalSpent: Math.max(0, (Number(c.totalSpent) || 0) - spentBack),
              purchaseCount: Math.max(0, (Number(c.purchaseCount) || 0) - 1),
            });
          }
        });
      } catch (e) {
        if (e.code === 'sale_not_found') { res.status(404).json({ ok: false, error: 'sale_not_found' }); return; }
        if (e.code === 'debt_has_payments') { res.status(409).json({ ok: false, error: 'debt_has_payments' }); return; }
        throw e;
      }
      audit('revert_sale', receiptId);
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- KASSADAN NAQD PUL QARZGA BERISH ----------------
    // Tovar sotilmaydi — kassadan to'g'ridan-to'g'ri naqd pul beriladi va bu
    // pul qarz sifatida yoziladi (mahsulot/ombor/sales'ga tegmaydi).
    if (action === 'cash_loan') {
      if (forbid('manageDebts')) return;
      const { debtorId, name, org, phone, amount, note, dueDate, forceOverLimit } = p;
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) { res.status(400).json({ ok: false, error: 'bad_amount' }); return; }
      if (!debtorId && !(name || '').trim()) { res.status(400).json({ ok: false, error: 'debtor_name_required' }); return; }

      let debtorRef, debtorData;
      if (debtorId) {
        debtorRef = db.collection('debtors').doc(debtorId);
        const s = await debtorRef.get();
        if (!s.exists) { res.status(404).json({ ok: false, error: 'debtor_not_found' }); return; }
        debtorData = s.data();
      } else {
        const existingSnap = org
          ? await db.collection('debtors').where('org', '==', org).where('name', '==', name).get()
          : await db.collection('debtors').where('name', '==', name).get();
        const existing = existingSnap.docs.find((d2) => (org ? d2.data().org === org : !d2.data().org));
        if (existing) { debtorRef = existing.ref; debtorData = existing.data(); }
        else {
          const newId = uid();
          const now0 = new Date().toISOString();
          debtorData = { id: newId, name: name.trim(), org: org || '', phone: phone || '', login: '', password: '', createdAt: now0, viewScope: 'own' };
          debtorRef = db.collection('debtors').doc(newId);
          await debtorRef.set(debtorData);
        }
      }

      const limitCheck = await checkCreditLimit(db, debtorData, settings, amt);
      if (limitCheck.wouldExceed && !forceOverLimit) {
        res.status(409).json({ ok: false, error: 'credit_limit_exceeded', limit: limitCheck.limit, currentRemaining: limitCheck.currentRemaining, newAmount: amt });
        return;
      }

      const now = new Date().toISOString();
      const debtId = uid();
      const debtDoc = {
        id: debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '', phone: debtorData.phone || '',
        items: [], total: amt, paid: false, paidDate: null, date: now, dueDate: dueDate || null,
        note: note || "Kassadan naqd pul qarzga olindi", seller: 'Admin (Mini App) — naqd pul',
        type: debtorData.org ? 'organization' : 'person', isCashLoan: true,
      };
      await db.collection('debts').doc(debtId).set(debtDoc);
      audit('cash_loan', `${debtorData.name || ''} — ${fmt(amt)} ${currencySymbol}`);

      // Kassadan naqd pul chiqimi sifatida ham qayd etamiz (hisobot/eksport uchun).
      await db.collection('cashLoans').doc(debtId).set({
        id: debtId, debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '',
        amount: amt, date: now, note: note || '', by: 'Mini App orqali',
      });

      // TUZATILDI (izchillik + MUHIM): boshqa qarz turlari (sotuv/qarz,
      // /qarz_qoshish) bilan bir xil — endi bu yerda ham (1) adminga xabar
      // ketadi (ilgari umuman ketmasdi), (2) mijozga xabarda uning nomi
      // admin tanlagan uslubda ko'rsatiladi, (3) vaqt ko'rsatiladi.
      if (settings.telegramNotifyNewDebt !== false) {
        const adminTargets = admins.filter((a) => a.chatId).map((a) => a.chatId);
        if (adminTargets.length) {
          const adminText = `💵 <b>Kassadan naqd pul berildi</b> — ${esc(shopName)}\n\n👤 ${esc(debtorData.name)}${debtorData.org ? ' (' + esc(debtorData.org) + ')' : ''}\n💰 Summa: ${fmt(amt)} ${esc(currencySymbol)}${note ? `\n📝 Izoh: ${esc(note)}` : ''}\n🕒 Vaqti: ${new Date(now).toLocaleString('uz-UZ')}`;
          await Promise.allSettled(adminTargets.map((cid) => tgSendMessage(token, cid, adminText)));
        }
      }
      if (debtorData.telegramChatId && settings.telegramNotifyNewDebt !== false) {
        const custDisplayNameCL = debtorDisplayNameForNotify(debtDoc, settings);
        const text = `💵 <b>${esc(shopName)}</b>\n\nHurmatli ${esc(custDisplayNameCL)}, kassadan sizga <b>${fmt(amt)} ${esc(currencySymbol)}</b> naqd pul berildi va bu summa qarz sifatida yozildi.${note ? `\n📝 Izoh: ${esc(note)}` : ''}\n🕒 Vaqti: ${new Date(now).toLocaleString('uz-UZ')}`;
        await tgSendMessage(token, debtorData.telegramChatId, text);
      }

      res.status(200).json({ ok: true, debtId, debtorId: debtorData.id });
      return;
    }

    // ---------------- QARZDORLAR: YARATISH / TAHRIRLASH / O'CHIRISH ----------------
    if (action === 'upsert_debtor') {
      if (forbid('manageDebts')) return;
      const { id, name, org, phone, telegramUsername, telegramUserId, viewScope, creditLimit } = p;
      if (!name || !String(name).trim()) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const cleanScope = viewScope === 'org' ? 'org' : 'own';
      const cleanTgId = String(telegramUserId || '').replace(/\D/g, '');
      // YANGI: qarz limiti — bo'sh/0 = cheklovsiz.
      const cleanCreditLimit = (creditLimit === undefined) ? undefined : (Math.max(0, parseFloat(creditLimit) || 0) || 0);
      const now = new Date().toISOString();
      if (id) {
        const ref = db.collection('debtors').doc(id);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'debtor_not_found' }); return; }
        const patch = {
          name: String(name).trim(), org: org || '', phone: phone || '',
          telegramUsername: (telegramUsername || '').replace(/^@/, ''), telegramUserId: cleanTgId, viewScope: cleanScope,
        };
        if (cleanCreditLimit !== undefined) patch.creditLimit = cleanCreditLimit;
        // Agar username yoki Telegram ID BOSHQA (bo'sh emas) qiymatga
        // o'zgartirilgan bo'lsa, eski chatId endi mos kelmasligi mumkin -
        // shuning uchun tozalaymiz, bot keyingi murojaatda avtomatik qayta
        // ulaydi. MUHIM: faqat MAYDON BO'SH QOLDIRILGANDA (masalan forma
        // to'liq yuklanmagan holatda saqlangan) chatId'ni O'CHIRIB
        // YUBORMAYMIZ — aks holda allaqachon ishlayotgan bot ulanishi
        // shunchaki qayta saqlashda (hech narsa o'zgartirmasdan ham)
        // bekor bo'lib qolar, va mijoz "ertasi kuni" botdan
        // foydalana olmay qolardi.
        const prev = snap.data();
        const usernameChanged = patch.telegramUsername && patch.telegramUsername !== (prev.telegramUsername || '');
        const userIdChanged = patch.telegramUserId && patch.telegramUserId !== (prev.telegramUserId || '');
        if (usernameChanged || userIdChanged) {
          patch.telegramChatId = admin.firestore.FieldValue.delete();
        }
        await ref.update(patch);
        res.status(200).json({ ok: true, id });
        return;
      }
      const newId = uid();
      const doc = {
        id: newId, name: String(name).trim(), org: org || '', phone: phone || '', login: '', password: '',
        telegramUsername: (telegramUsername || '').replace(/^@/, ''), telegramUserId: cleanTgId, viewScope: cleanScope, createdAt: now,
        creditLimit: cleanCreditLimit || 0,
      };
      await db.collection('debtors').doc(newId).set(doc);
      res.status(200).json({ ok: true, id: newId });
      return;
    }

    if (action === 'delete_debtor') {
      if (forbid('manageDebts') || forbid('deleteRecords')) return;
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      // TUZATILDI (MUHIM): ilgari bu yerda qarzdorning TO'LANMAGAN qarzi
      // bor-yo'qligi umuman tekshirilmasdi. Agar hali qarzi bor odamni
      // o'chirib yuborilsa, uning qarz yozuvlari (debtorId orqali) "egasiz"
      // qolib ketardi — bu esa keyinchalik o'sha qarz uchun avtomatik
      // Telegram eslatmasi (debtor hujjatidan telegramChatId olinadi) va
      // qarz limiti tekshiruvi (debtor hujjatidan creditLimit olinadi)
      // ISHLAMAY qolishiga olib kelardi, hech qanday ogohlantirishsiz. Endi
      // to'lanmagan qarzi bor odamni o'chirishga yo'l qo'yilmaydi — avval
      // qarzlari yopilishi yoki boshqa qarzdorga ko'chirilishi kerak.
      const unpaidSnap = await db.collection('debts').where('debtorId', '==', id).where('paid', '==', false).limit(1).get();
      if (!unpaidSnap.empty) { res.status(400).json({ ok: false, error: 'has_unpaid_debt' }); return; }
      const dSnap = await db.collection('debtors').doc(id).get();
      await db.collection('debtors').doc(id).delete();
      audit('delete_debtor', dSnap.exists ? dSnap.data().name : id);
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- QARZDORGA BATAFSIL ESLATMA YUBORISH ----------------
    if (action === 'send_debt_reminder') {
      if (forbid('manageDebts')) return;
      const { debtorId } = p;
      if (!debtorId) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const debtorSnap = await db.collection('debtors').doc(debtorId).get();
      if (!debtorSnap.exists) { res.status(404).json({ ok: false, error: 'debtor_not_found' }); return; }
      const debtorData = debtorSnap.data();
      if (!debtorData.telegramChatId) { res.status(400).json({ ok: false, error: 'not_linked' }); return; }
      const debtsSnap = await db.collection('debts').where('debtorId', '==', debtorId).get();
      const myDebts = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid);
      if (!myDebts.length) { res.status(400).json({ ok: false, error: 'no_active_debts' }); return; }
      const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
      let text = `⏰ <b>${esc(shopName)}</b> — qarz eslatmasi\n\n`;
      myDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).forEach((d) => { text += debtDetailText(d, currencySymbol) + '\n'; });
      text += `💰 Jami qarzingiz: <b>${fmt(total)} ${esc(currencySymbol)}</b>`;
      await tgSendMessage(token, debtorData.telegramChatId, text);
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- SOZLAMALAR ----------------
    if (action === 'update_settings') {
      if (forbid('manageSettings')) return;
      const patch = p.patch || {};
      // YANGI: `defaultCreditLimit` (umumiy qarz limiti) va
      // `debtReminderOffsets` (avto-eslatma jadvali, kunlar ro'yxati,
      // masalan [-3,-1,0,3,7]) endi shu yerdan ham sozlanadi.
      const allowed = ['shopName', 'currencySymbol', 'lowStockThreshold', 'overdueDaysGlobal', 'telegramNotifyLowStock', 'telegramNotifyOverdueDebts', 'telegramNotifyDailyReport', 'defaultCreditLimit', 'debtReminderOffsets'];
      const clean = {};
      allowed.forEach((k) => {
        if (patch[k] === undefined) return;
        if (k === 'lowStockThreshold' || k === 'overdueDaysGlobal' || k === 'defaultCreditLimit') clean[k] = parseInt(patch[k], 10) || 0;
        else if (k.startsWith('telegramNotify')) clean[k] = !!patch[k];
        else if (k === 'debtReminderOffsets') clean[k] = Array.isArray(patch[k]) ? patch[k].map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)).slice(0, 20) : [];
        else clean[k] = String(patch[k]);
      });
      if (!Object.keys(clean).length) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      await settingsRef.set(clean, { merge: true });
      invalidateSettingsCache();
      audit('update_settings', Object.keys(clean).join(', '));
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- ADMINLAR: QO'SHISH / O'CHIRISH ----------------
    if (action === 'upsert_admin') {
      if (forbid('manageAdmins')) return;
      const { name, phone, username, role, permissions } = p;
      if (!name || (!phone && !username)) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      // TUZATILDI (JIDDIY XAVFSIZLIK ZAIFLIGI): ilgari "role" maydoni
      // foydalanuvchi (frontend) yuborgan qiymatga qarab to'g'ridan-
      // to'g'ri o'rnatilardi — faqat "manageAdmins" huquqiga ega (lekin
      // OWNER bo'lmagan) oddiy admin ham so'rovda role:'owner' yuborib,
      // yangi bosh admin yaratishi mumkin edi — bu esa hasPermission()
      // orqali BARCHA cheklovlarni chetlab o'tishga imkon berardi. Endi
      // faqat allaqachon OWNER bo'lgan so'rovchi yangi owner yarata oladi.
      if (role === 'owner' && (adminEntry?.role || 'owner') !== 'owner') {
        res.status(403).json({ ok: false, error: 'only_owner_can_grant_owner' }); return;
      }
      const list = Array.isArray(settings.telegramAdmins) ? [...settings.telegramAdmins] : [];
      // `permissions` — ixtiyoriy, PERMISSION_KEYS bo'yicha {key:true/false}.
      const cleanRole = role === 'owner' ? 'owner' : 'admin';
      const cleanPerms = (permissions && typeof permissions === 'object') ? permissions : undefined;
      const entry = { name: String(name).trim(), phone: phone || '', username: (username || '').replace(/^@/, ''), chatId: '', role: cleanRole };
      if (cleanPerms) entry.permissions = cleanPerms;
      list.push(entry);
      await settingsRef.set({ telegramAdmins: list }, { merge: true });
      invalidateSettingsCache();
      audit('upsert_admin', `${entry.name} — ${cleanRole}`);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'remove_admin') {
      if (forbid('manageAdmins')) return;
      const { chatId: targetChatId, username: targetUsername, phone: targetPhone } = p;
      const list = Array.isArray(settings.telegramAdmins) ? [...settings.telegramAdmins] : [];
      const removed = list.find((a) => (
        (targetChatId && String(a.chatId) === String(targetChatId)) ||
        (targetUsername && (a.username || '').toLowerCase() === String(targetUsername).toLowerCase()) ||
        (targetPhone && a.phone === targetPhone)
      ));
      if (!removed) { res.status(404).json({ ok: false, error: 'admin_not_found' }); return; }
      if (String(chatId) === String(targetChatId)) { res.status(400).json({ ok: false, error: 'cannot_remove_self' }); return; }
      // TUZATILDI (JIDDIY XAVFSIZLIK ZAIFLIGI + XATO): ilgari bu yerda (1)
      // oddiy admin ownerni o'chirishi mumkin edi (huquqni oshirish
      // zaifligi bilan bir oilaga tegishli — boshqaruvdan chetlatish), va
      // (2) "oxirgi owner'ni o'chirib bo'lmaydi" himoyasi UMUMAN yo'q edi
      // — bu esa BUTUN do'kon boshqaruvidan hech kim to'liq huquqli
      // bo'lmay qolishiga (lock-out) olib kelishi mumkin edi. Endi bot
      // buyrug'i (/admin_ochirish) bilan bir xil ikkala himoya ham bor.
      if ((removed.role || 'owner') === 'owner') {
        if ((adminEntry?.role || 'owner') !== 'owner') { res.status(403).json({ ok: false, error: 'only_owner_can_remove_owner' }); return; }
        const remainingOwners = list.filter((a) => a !== removed && (a.role || 'owner') === 'owner');
        if (!remainingOwners.length) { res.status(400).json({ ok: false, error: 'cannot_remove_last_owner' }); return; }
      }
      const filtered = list.filter((a) => a !== removed);
      await settingsRef.set({ telegramAdmins: filtered }, { merge: true });
      invalidateSettingsCache();
      audit('remove_admin', removed ? removed.name : '');
      res.status(200).json({ ok: true });
      return;
    }

    // YANGI: bitta adminning rolini/huquqlarini yangilash (o'chirib qayta
    // qo'shmasdan) — index.html "🔐 Adminlar va huquqlar" oynasidagi
    // checkboxlar shu amalga yozadi.
    if (action === 'update_admin_permissions') {
      if (forbid('manageAdmins')) return;
      const { chatId: targetChatId, role, permissions } = p;
      if (!targetChatId) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const list = Array.isArray(settings.telegramAdmins) ? [...settings.telegramAdmins] : [];
      const idx = list.findIndex((a) => String(a.chatId) === String(targetChatId));
      if (idx === -1) { res.status(404).json({ ok: false, error: 'admin_not_found' }); return; }
      // TUZATILDI (JIDDIY XAVFSIZLIK ZAIFLIGI): upsert_admin bilan bir xil
      // muammo — oddiy (manageAdmins huquqiga ega, lekin owner bo'lmagan)
      // admin bu amal orqali O'ZINI (yoki boshqa birovni) "owner"
      // darajasiga ko'tarishi, YOKI haqiqiy ownerni "admin"ga tushirib,
      // uni boshqaruvdan chetlatishi mumkin edi. Endi ikkala yo'nalish
      // ham faqat allaqachon OWNER bo'lgan so'rovchi tomonidan bajarilishi
      // mumkin.
      const targetCurrentlyOwner = (list[idx].role || 'owner') === 'owner';
      if ((role === 'owner' || targetCurrentlyOwner) && (adminEntry?.role || 'owner') !== 'owner') {
        res.status(403).json({ ok: false, error: 'only_owner_can_change_owner' }); return;
      }
      if (role === 'owner' || role === 'admin') list[idx].role = role;
      if (permissions && typeof permissions === 'object') list[idx].permissions = permissions;
      await settingsRef.set({ telegramAdmins: list }, { merge: true });
      invalidateSettingsCache();
      audit('update_admin_permissions', `${list[idx].name || targetChatId}`);
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- MIJOZLAR / SODIQLIK DASTURI ----------------
    if (action === 'upsert_customer') {
      if (forbid('manageCustomers')) return;
      const { id, name, phone, telegramUsername, tierOverride } = p;
      if (!name || !String(name).trim()) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const cleanUsername = (telegramUsername || '').replace(/^@/, '');
      // TUZATILDI (2x): (1) admin daraja (Bronza/Kumush/Oltin)ni qo'lda
      // belgilasa, bu maydon oldin umuman saqlanmas edi (unutilib qolgan).
      // (2) Faqat 'bronze'/'silver'/'gold' qabul qilinardi — endi admin
      // index.html'dagi "🏆 Darajalarni sozlash"dan o'zi qo'shgan har
      // qanday daraja (masalan Platina, id: 'tier_xxxx') ham to'g'ri
      // saqlanadi. Bo'sh/notanish qiymat — "avtomatik" deb olinadi.
      const cleanTierOverride = (typeof tierOverride === 'string') ? tierOverride.trim().slice(0, 60) : '';
      if (id) {
        const ref = db.collection('customers').doc(id);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'customer_not_found' }); return; }
        const cur = snap.data();
        const beforeTier = computeCustomerTier(cur.totalSpent || 0, cur.tierOverride || '', settings.loyaltyTiers);
        await ref.update({ name: String(name).trim(), phone: phone || '', telegramUsername: cleanUsername, tierOverride: cleanTierOverride });
        // YANGI: daraja o'zgargan bo'lsa (masalan admin qo'lda "Oltin"ga
        // o'tkazsa), mijozga darhol Telegram xabari boradi.
        const afterTier = computeCustomerTier(cur.totalSpent || 0, cleanTierOverride, settings.loyaltyTiers);
        if (cur.telegramChatId && afterTier.id !== beforeTier.id) {
          const isUpgrade = afterTier.idx > beforeTier.idx;
          const text = isUpgrade
            ? `🎉 <b>${esc(shopName)}</b>\n\nTabriklaymiz! Sodiqlik darajangiz endi <b>${esc(afterTier.label)}</b> ga oshdi!`
            : `ℹ️ <b>${esc(shopName)}</b>\n\nSodiqlik darajangiz <b>${esc(afterTier.label)}</b> ga o'zgardi.`;
          await tgSendMessage(token, cur.telegramChatId, text);
        }
        res.status(200).json({ ok: true, id });
        return;
      }
      const newRef = db.collection('customers').doc();
      const doc = {
        id: newRef.id, name: String(name).trim(), phone: phone || '', telegramUsername: cleanUsername,
        tierOverride: cleanTierOverride,
        points: 0, totalSpent: 0, purchaseCount: 0, createdAt: new Date().toISOString(), addedBy: 'Mini App orqali',
      };
      await newRef.set(doc);
      res.status(200).json({ ok: true, id: newRef.id });
      return;
    }

    if (action === 'delete_customer') {
      if (forbid('manageCustomers') || forbid('deleteRecords')) return;
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const cSnap = await db.collection('customers').doc(id).get();
      await db.collection('customers').doc(id).delete();
      audit('delete_customer', cSnap.exists ? cSnap.data().name : id);
      res.status(200).json({ ok: true });
      return;
    }

    // Ballarni qo'lda qo'shish/ayirish (masalan sovg'a yoki tuzatish uchun).
    // delta manfiy bo'lsa — ball ayiriladi (0 dan pastga tushmaydi).
    if (action === 'adjust_customer_points') {
      if (forbid('manageCustomers')) return;
      const { id, delta, reason } = p;
      const d2 = parseInt(delta, 10);
      if (!id || !d2) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const ref = db.collection('customers').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ ok: false, error: 'customer_not_found' }); return; }
      const cur = snap.data();
      // TUZATILDI — IKKI MARTA COIN YOZILISH XATOSINING OLDINI OLISH
      // (SERVER TOMONDA): frontendda ham himoya qo'yilgan, lekin tarmoq
      // ikkilanib so'rovni qayta yuborishi yoki ikki qurilmadan bir vaqtda
      // bosilishi kabi holatlar uchun bu yerda ham qo'shimcha tekshiruv
      // qo'yamiz. Agar aynan shu mijozga, aynan shu delta+sabab bilan
      // so'nggi 5 soniya ichida allaqachon yozuv qo'shilgan bo'lsa —
      // buni takroriy so'rov deb hisoblab, QAYTA QO'SHMASDAN joriy holatni
      // qaytaramiz.
      const lastAdj = Array.isArray(cur.pointsAdjustments) ? cur.pointsAdjustments[0] : null;
      if (lastAdj && lastAdj.delta === d2 && (lastAdj.reason || '') === (reason || '')) {
        const lastTime = new Date(lastAdj.date || 0).getTime();
        if (Date.now() - lastTime < 5000) {
          res.status(200).json({ ok: true, points: cur.points || 0, duplicate: true });
          return;
        }
      }
      const newPoints = Math.max(0, (cur.points || 0) + d2);
      const entry = { date: new Date().toISOString(), delta: d2, reason: reason || '', by: 'Mini App admin' };
      await ref.update({ points: newPoints, pointsAdjustments: admin.firestore.FieldValue.arrayUnion(entry) });
      audit('adjust_customer_points', `${cur.name || ''} — ${d2 > 0 ? '+' : ''}${d2}${reason ? ' (' + reason + ')' : ''}`);
      if (cur.telegramChatId) {
        const text = d2 > 0
          ? `⭐ <b>${esc(shopName)}</b>\n\nSizga <b>+${d2} ball</b> qo'shildi${reason ? ` (${esc(reason)})` : ''}.\n💳 Jami ball: <b>${newPoints}</b>`
          : `ℹ️ <b>${esc(shopName)}</b>\n\nBallaringizdan ${Math.abs(d2)} ball ayirildi${reason ? ` (${esc(reason)})` : ''}.\n💳 Jami ball: <b>${newPoints}</b>`;
        await tgSendMessage(token, cur.telegramChatId, text);
      }
      res.status(200).json({ ok: true, points: newPoints });
      return;
    }

    // ---------------- XODIMLAR (SOTUVCHILAR): QO'SHISH / O'CHIRISH ----------------
    if (action === 'upsert_seller') {
      if (forbid('manageStaff')) return;
      const { id, name, pin, telegramUsername } = p;
      if (!name || !String(name).trim()) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      if (pin && !/^\d{4}$/.test(String(pin))) { res.status(400).json({ ok: false, error: 'bad_pin' }); return; }
      const list = Array.isArray(settings.sellers) ? [...settings.sellers] : [];
      if (pin && list.some((s) => s.pin === String(pin) && s.id !== id)) { res.status(400).json({ ok: false, error: 'pin_taken' }); return; }
      const cleanUsername = (telegramUsername || '').replace(/^@/, '');
      if (id) {
        const idx = list.findIndex((s) => s.id === id);
        if (idx === -1) { res.status(404).json({ ok: false, error: 'seller_not_found' }); return; }
        list[idx] = { ...list[idx], name: String(name).trim(), ...(pin ? { pin: String(pin) } : {}), telegramUsername: cleanUsername };
      } else {
        list.push({ id: uid(), name: String(name).trim(), pin: String(pin || ''), telegramUsername: cleanUsername, telegramChatId: '' });
      }
      await settingsRef.set({ sellers: list }, { merge: true });
      invalidateSettingsCache();
      audit('upsert_seller', String(name).trim());
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'remove_seller') {
      if (forbid('manageStaff') || forbid('deleteRecords')) return;
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const removed = (Array.isArray(settings.sellers) ? settings.sellers : []).find((s) => s.id === id);
      const list = (Array.isArray(settings.sellers) ? settings.sellers : []).filter((s) => s.id !== id);
      await settingsRef.set({ sellers: list }, { merge: true });
      invalidateSettingsCache();
      audit('remove_seller', removed ? removed.name : id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('miniapp-action xatolik:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
