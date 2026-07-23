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
//                      debtorId?, name?, org?, phone?, note? }
//   upsert_debtor   { id?, name, org, phone, telegramUsername, viewScope }
//   delete_debtor   { id }
//   send_debt_reminder { debtorId }          -> shu odamga batafsil eslatma
//   update_settings { patch:{shopName,currencySymbol,lowStockThreshold,
//                             overdueDaysGlobal,telegramNotifyLowStock,
//                             telegramNotifyOverdueDebts,telegramNotifyDailyReport} }
//   upsert_admin    { name, phone, username, chatId? }
//   remove_admin    { chatId?, username?, phone? }
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');
const { verifyInitData } = require('./_miniapp-auth');

function getDb() { return require('./_firebase').getDb(); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }

async function tgSendMessage(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  try {
    const { initData, action, payload } = req.body || {};
    const db = getDb();
    const settingsRef = db.collection('dokon').doc('settings');
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) { res.status(400).json({ ok: false, error: 'no_settings' }); return; }
    const settings = settingsSnap.data();
    const token = (settings.telegramBotToken || '').trim();
    const currencySymbol = settings.currencySymbol || "so'm";
    const shopName = settings.shopName || "Do'kon";

    const user = verifyInitData(initData, token);
    if (!user) { res.status(401).json({ ok: false, error: 'invalid_init_data' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    const isAdmin = admins.some((a) => String(a.chatId).trim() === chatId);
    if (!isAdmin) { res.status(403).json({ ok: false, error: 'not_admin' }); return; }
    const p = payload || {};

    // ---------------- QARZGA TO'LOV ----------------
    if (action === 'pay_debt') {
      const { debtId, amount } = p;
      const amt = parseFloat(amount);
      if (!debtId || isNaN(amt) || amt <= 0) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const debtRef = db.collection('debts').doc(debtId);
      const debtSnap = await debtRef.get();
      if (!debtSnap.exists) { res.status(404).json({ ok: false, error: 'debt_not_found' }); return; }
      const d = debtSnap.data();
      const remaining = debtRemaining(d);
      if (remaining <= 0) { res.status(400).json({ ok: false, error: 'already_paid' }); return; }
      const applied = Math.min(Math.round(amt), Math.round(remaining));
      const paymentRec = { amount: applied, date: new Date().toISOString(), note: 'Mini App orqali', by: 'Telegram admin' };
      const newPaidAmount = (d.paidAmount || 0) + applied;
      const isFullyPaid = d.total - newPaidAmount <= 0.5;
      const patch = { paidAmount: admin.firestore.FieldValue.increment(applied), payments: admin.firestore.FieldValue.arrayUnion(paymentRec) };
      if (isFullyPaid) { patch.paid = true; patch.paidDate = paymentRec.date; }
      await debtRef.update(patch);

      if (d.debtorId) {
        const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
        const cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
        if (cid) {
          await tgSendMessage(token, cid, `💵 <b>${esc(shopName)}</b>\n\nSizning ${fmt(applied)} ${esc(currencySymbol)} to'lovingiz qabul qilindi.${isFullyPaid ? "\n🎉 Qarzingiz to'liq yopildi!" : `\nQolgan qarz: ${fmt(remaining - applied)} ${esc(currencySymbol)}`}`);
        }
      }
      res.status(200).json({ ok: true, applied, remaining: remaining - applied, fullyPaid: isFullyPaid });
      return;
    }

    // ---------------- ESKI: FAQAT NARX (moslik uchun saqlab qolindi) ----------------
    if (action === 'update_price') {
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
      const { name, price, cost, stock, volume, note } = p;
      if (!name || isNaN(parseFloat(price))) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const id = uid();
      const doc = {
        id, name: String(name).trim(), price: parseFloat(price) || 0, cost: parseFloat(cost) || 0,
        stock: parseInt(stock, 10) || 0, volume: volume || '', note: note || '', img: '',
      };
      await db.collection('products').doc(id).set(doc);
      res.status(200).json({ ok: true, product: doc });
      return;
    }

    if (action === 'update_product') {
      const { id, patch } = p;
      if (!id || !patch) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const allowed = ['name', 'price', 'cost', 'stock', 'volume', 'note'];
      const clean = {};
      allowed.forEach((k) => { if (patch[k] !== undefined) clean[k] = (k === 'price' || k === 'cost') ? parseFloat(patch[k]) || 0 : (k === 'stock' ? parseInt(patch[k], 10) || 0 : patch[k]); });
      if (!Object.keys(clean).length) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const ref = db.collection('products').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      await ref.update(clean);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete_product') {
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      await db.collection('products').doc(id).delete();
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'restock') {
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
      const { items, mode, debtorId, name, org, phone, note, dueDate } = p;
      if (!Array.isArray(items) || !items.length) { res.status(400).json({ ok: false, error: 'no_items' }); return; }
      if (mode === 'debt' && !debtorId && !(name || '').trim()) { res.status(400).json({ ok: false, error: 'debtor_name_required' }); return; }

      // Tovarlarni o'qib, zaxirani tekshiramiz
      const productRefs = items.map((it) => db.collection('products').doc(it.productId));
      const productSnaps = await Promise.all(productRefs.map((r) => r.get()));
      const lineItems = [];
      for (let i = 0; i < items.length; i++) {
        const snap = productSnaps[i];
        const qty = parseInt(items[i].qty, 10);
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
        const prod = snap.data();
        if (!qty || qty <= 0) { res.status(400).json({ ok: false, error: 'bad_qty' }); return; }
        if ((prod.stock || 0) < qty) { res.status(400).json({ ok: false, error: 'not_enough_stock', productName: prod.name }); return; }
        lineItems.push({ ref: snap.ref, product: prod, qty, subtotal: (prod.price || 0) * qty });
      }
      const total = lineItems.reduce((a, x) => a + x.subtotal, 0);
      const now = new Date().toISOString();
      const seller = 'Admin (Mini App)';

      // Zaxirani kamaytiramiz
      await Promise.all(lineItems.map((x) => x.ref.update({ stock: admin.firestore.FieldValue.increment(-x.qty) })));

      if (mode === 'debt') {
        // Mavjud qarzdorni topamiz yoki yangi yaratamiz
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
            debtorData = { id: newId, name: name.trim(), org: org || '', phone: phone || '', login: '', password: '', createdAt: now, viewScope: 'own' };
            debtorRef = db.collection('debtors').doc(newId);
            await debtorRef.set(debtorData);
          }
        }

        const debtItems = lineItems.map((x) => ({ productId: x.product.id, productName: x.product.name, volume: x.product.volume || '', qty: x.qty, price: x.product.price, subtotal: x.subtotal }));
        const debtId = uid();
        const debtDoc = {
          id: debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '', phone: debtorData.phone || '',
          items: debtItems, total, paid: false, paidDate: null, date: now, dueDate: dueDate || null, note: note || '', seller, type: debtorData.org ? 'organization' : 'person',
        };
        await db.collection('debts').doc(debtId).set(debtDoc);

        await Promise.all(lineItems.map((x) => db.collection('sales').doc(uid()).set({
          id: uid(), productId: x.product.id, productName: x.product.name, volume: x.product.volume || '', qty: x.qty, price: x.product.price,
          cost: x.product.cost || 0, total: x.subtotal, seller, date: now, reverted: false, isDebt: true, debtorName: debtorData.name, org: debtorData.org || '',
        })));

        if (debtorData.telegramChatId) {
          const text = `🧾 <b>${esc(shopName)}</b>\n\nSizga yangi qarz yozildi:\n\n${debtDetailText(debtDoc, currencySymbol)}\n💰 Jami: <b>${fmt(total)} ${esc(currencySymbol)}</b>`;
          await tgSendMessage(token, debtorData.telegramChatId, text);
        }

        res.status(200).json({ ok: true, total, debtId, debtorId: debtorData.id });
        return;
      }

      // Naqd sotish
      await Promise.all(lineItems.map((x) => db.collection('sales').doc(uid()).set({
        id: uid(), productId: x.product.id, productName: x.product.name, volume: x.product.volume || '', qty: x.qty, price: x.product.price,
        cost: x.product.cost || 0, total: x.subtotal, seller, date: now, reverted: false, isDebt: false,
      })));
      res.status(200).json({ ok: true, total });
      return;
    }

    // ---------------- KASSADAN NAQD PUL QARZGA BERISH ----------------
    // Tovar sotilmaydi — kassadan to'g'ridan-to'g'ri naqd pul beriladi va bu
    // pul qarz sifatida yoziladi (mahsulot/ombor/sales'ga tegmaydi).
    if (action === 'cash_loan') {
      const { debtorId, name, org, phone, amount, note, dueDate } = p;
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

      const now = new Date().toISOString();
      const debtId = uid();
      const debtDoc = {
        id: debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '', phone: debtorData.phone || '',
        items: [], total: amt, paid: false, paidDate: null, date: now, dueDate: dueDate || null,
        note: note || "Kassadan naqd pul qarzga olindi", seller: 'Admin (Mini App) — naqd pul',
        type: debtorData.org ? 'organization' : 'person', isCashLoan: true,
      };
      await db.collection('debts').doc(debtId).set(debtDoc);

      // Kassadan naqd pul chiqimi sifatida ham qayd etamiz (hisobot/eksport uchun).
      await db.collection('cashLoans').doc(debtId).set({
        id: debtId, debtId, debtorId: debtorData.id, debtorName: debtorData.name, org: debtorData.org || '',
        amount: amt, date: now, note: note || '', by: 'Mini App orqali',
      });

      if (debtorData.telegramChatId) {
        const text = `💵 <b>${esc(shopName)}</b>\n\nKassadan sizga <b>${fmt(amt)} ${esc(currencySymbol)}</b> naqd pul berildi va bu summa qarz sifatida yozildi.${note ? `\n📝 Izoh: ${esc(note)}` : ''}`;
        await tgSendMessage(token, debtorData.telegramChatId, text);
      }

      res.status(200).json({ ok: true, debtId, debtorId: debtorData.id });
      return;
    }

    // ---------------- QARZDORLAR: YARATISH / TAHRIRLASH / O'CHIRISH ----------------
    if (action === 'upsert_debtor') {
      const { id, name, org, phone, telegramUsername, telegramUserId, viewScope } = p;
      if (!name || !String(name).trim()) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const cleanScope = viewScope === 'org' ? 'org' : 'own';
      const cleanTgId = String(telegramUserId || '').replace(/\D/g, '');
      const now = new Date().toISOString();
      if (id) {
        const ref = db.collection('debtors').doc(id);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ ok: false, error: 'debtor_not_found' }); return; }
        const patch = {
          name: String(name).trim(), org: org || '', phone: phone || '',
          telegramUsername: (telegramUsername || '').replace(/^@/, ''), telegramUserId: cleanTgId, viewScope: cleanScope,
        };
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
      };
      await db.collection('debtors').doc(newId).set(doc);
      res.status(200).json({ ok: true, id: newId });
      return;
    }

    if (action === 'delete_debtor') {
      const { id } = p;
      if (!id) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      await db.collection('debtors').doc(id).delete();
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- QARZDORGA BATAFSIL ESLATMA YUBORISH ----------------
    if (action === 'send_debt_reminder') {
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
      const patch = p.patch || {};
      const allowed = ['shopName', 'currencySymbol', 'lowStockThreshold', 'overdueDaysGlobal', 'telegramNotifyLowStock', 'telegramNotifyOverdueDebts', 'telegramNotifyDailyReport'];
      const clean = {};
      allowed.forEach((k) => {
        if (patch[k] === undefined) return;
        if (k === 'lowStockThreshold' || k === 'overdueDaysGlobal') clean[k] = parseInt(patch[k], 10) || 0;
        else if (k.startsWith('telegramNotify')) clean[k] = !!patch[k];
        else clean[k] = String(patch[k]);
      });
      if (!Object.keys(clean).length) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      await settingsRef.set(clean, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    // ---------------- ADMINLAR: QO'SHISH / O'CHIRISH ----------------
    if (action === 'upsert_admin') {
      const { name, phone, username } = p;
      if (!name || (!phone && !username)) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const list = Array.isArray(settings.telegramAdmins) ? [...settings.telegramAdmins] : [];
      list.push({ name: String(name).trim(), phone: phone || '', username: (username || '').replace(/^@/, ''), chatId: '' });
      await settingsRef.set({ telegramAdmins: list }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'remove_admin') {
      const { chatId: targetChatId, username: targetUsername, phone: targetPhone } = p;
      const list = Array.isArray(settings.telegramAdmins) ? [...settings.telegramAdmins] : [];
      const filtered = list.filter((a) => !(
        (targetChatId && String(a.chatId) === String(targetChatId)) ||
        (targetUsername && (a.username || '').toLowerCase() === String(targetUsername).toLowerCase()) ||
        (targetPhone && a.phone === targetPhone)
      ));
      if (filtered.length === list.length) { res.status(404).json({ ok: false, error: 'admin_not_found' }); return; }
      if (String(chatId) === String(targetChatId)) { res.status(400).json({ ok: false, error: 'cannot_remove_self' }); return; }
      await settingsRef.set({ telegramAdmins: filtered }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('miniapp-action xatolik:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
