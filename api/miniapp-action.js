// api/miniapp-action.js
// ----------------------------------------------------------------------------
// Mini App'dagi admin panelidan chaqiriladigan YOZISH amallari:
//   - pay_debt     { debtId, amount }   -> qarzga to'lov qo'shadi
//   - update_price { productName, price } -> tovar narxini yangilaydi
// Faqat tekshirilgan (initData orqali) va admin ekanligi aniqlangan
// chat'lardan kelgan so'rovlar bajariladi.
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

function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }

async function tgSendMessage(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
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

    const user = verifyInitData(initData, token);
    if (!user) { res.status(401).json({ ok: false, error: 'invalid_init_data' }); return; }

    const chatId = String(user.id);
    const admins = Array.isArray(settings.telegramAdmins) ? settings.telegramAdmins : [];
    const isAdmin = admins.some((a) => String(a.chatId).trim() === chatId);
    if (!isAdmin) { res.status(403).json({ ok: false, error: 'not_admin' }); return; }

    if (action === 'pay_debt') {
      const { debtId, amount } = payload || {};
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
          await tgSendMessage(token, cid, `💵 <b>${settings.shopName || "Do'kon"}</b>\n\nSizning ${fmt(applied)} so'm to'lovingiz qabul qilindi.${isFullyPaid ? "\n🎉 Qarzingiz to'liq yopildi!" : `\nQolgan qarz: ${fmt(remaining - applied)} so'm`}`);
        }
      }
      res.status(200).json({ ok: true, applied, remaining: remaining - applied, fullyPaid: isFullyPaid });
      return;
    }

    if (action === 'update_price') {
      const { productName, price } = payload || {};
      const newPrice = parseFloat(price);
      if (!productName || isNaN(newPrice) || newPrice < 0) { res.status(400).json({ ok: false, error: 'bad_params' }); return; }
      const productsSnap = await db.collection('products').where('name', '==', productName).get();
      if (productsSnap.empty) { res.status(404).json({ ok: false, error: 'product_not_found' }); return; }
      await productsSnap.docs[0].ref.update({ price: newPrice });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('miniapp-action xatolik:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
