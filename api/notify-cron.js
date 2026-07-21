// api/notify-cron.js
// ----------------------------------------------------------------------------
// Vercel serverless funksiyasi. scripts/telegram-notify.js dagi bilan BIR XIL
// mantiq — farqi shundaki, bu GitHub Actions cron o'RNIGA Vercel'ning o'z
// ichki "Cron Jobs" xizmati orqali ishga tushadi (vercel.json ichida
// belgilangan jadval bo'yicha). Vercel Hobby (bepul) rejada kuniga 1 marta
// ishga tushadigan cron BEPUL.
//
// Bu funksiya kam qolgan/tugagan tovar, muddati o'tgan qarz va kunlik
// hisobot haqida xabarlarni tekshiradi va tegishli adminlarga yuboradi.
// Bir kunda faqat bir marta yuborilishini Firestore ichidagi "sentLog"
// hujjati orqali nazorat qiladi.
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');

let firebaseApp = null;
function getDb() {
  if (!firebaseApp) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var topilmadi (Vercel Settings > Environment Variables).');
    const serviceAccount = JSON.parse(raw);
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function sendTelegramMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram xatosi (chat_id=${chatId}):`, data.description || data);
    return false;
  }
  return true;
}

async function sendToAllAdmins(token, chatIds, text) {
  let anyOk = false;
  for (const chatId of chatIds) {
    const ok = await sendTelegramMessage(token, chatId, text);
    anyOk = anyOk || ok;
  }
  return anyOk;
}

async function runNotify() {
  const db = getDb();

  const settingsSnap = await db.collection('dokon').doc('settings').get();
  if (!settingsSnap.exists) {
    console.log("Sozlamalar hujjati (dokon/settings) topilmadi — chiqilmoqda.");
    return { ok: true, info: 'no settings' };
  }
  const s = settingsSnap.data();

  const token = (s.telegramBotToken || '').trim();
  const chatIds = [
    ...new Set(
      [
        ...(Array.isArray(s.telegramAdmins) ? s.telegramAdmins.map((a) => String(a.chatId || '').trim()) : []),
        (s.telegramChatId || '').trim(),
      ].filter(Boolean)
    ),
  ];

  if (!token || !chatIds.length) {
    console.log("Bot token yoki admin (Chat ID) sozlanmagan — ilova ichidagi 'Sozlamalar > Telegram' bo'limida to'ldiring.");
    return { ok: true, info: 'no token/admins' };
  }

  const shopName = s.shopName || "Do'kon";
  const todayStr = new Date().toISOString().slice(0, 10);

  const sentLogRef = db.collection('dokon').doc('telegramSentLog');
  const sentLogSnap = await sentLogRef.get();
  const sentLog = sentLogSnap.exists ? sentLogSnap.data() : {};
  const alreadySent = (key) => sentLog[key] === todayStr;
  const patch = {};

  // ---------- 1) Kam qolgan / tugagan tovar ----------
  if (s.telegramNotifyLowStock && !alreadySent('lowstock')) {
    const productsSnap = await db.collection('products').get();
    const products = productsSnap.docs.map((d) => d.data());
    const threshold = s.lowStockThreshold || 5;
    const low = products.filter((p) => p.stock <= threshold && p.stock > 0);
    const empty = products.filter((p) => p.stock === 0);
    if (low.length || empty.length) {
      let text = `⚠️ <b>Zaxira ogohlantirishi</b> — ${esc(shopName)}\n\n`;
      if (empty.length) text += `🔴 Tugagan (${empty.length} ta): ${empty.slice(0, 15).map((p) => esc(p.name)).join(', ')}\n`;
      if (low.length) text += `🟡 Kam qolgan (${low.length} ta): ${low.slice(0, 15).map((p) => `${esc(p.name)} (${p.stock} ta)`).join(', ')}`;
      const ok = await sendToAllAdmins(token, chatIds, text);
      if (ok) patch.lowstock = todayStr;
    }
  }

  // ---------- 2) Muddati o'tgan qarzlar ----------
  if (s.telegramNotifyOverdueDebts && !alreadySent('overdue')) {
    const debtsSnap = await db.collection('debts').get();
    const debts = debtsSnap.docs.map((d) => d.data());
    const overdueDays = s.overdueDaysGlobal || 14;
    const overdue = debts.filter(
      (d) => !d.paid && Date.now() - new Date(d.date).getTime() >= overdueDays * 86400000
    );
    if (overdue.length) {
      const remaining = (d) => (d.total || 0) - (d.paidAmount || 0);
      const sum = overdue.reduce((a, d) => a + remaining(d), 0);
      const text = `⏰ <b>Muddati o'tgan qarzlar</b> — ${esc(shopName)}\n\n${overdue.length} ta qarzdor, jami ${fmt(sum)} so'm ${overdueDays} kundan ortiq to'lanmagan.`;
      const ok = await sendToAllAdmins(token, chatIds, text);
      if (ok) patch.overdue = todayStr;
    }
  }

  // ---------- 2.5) Muddati belgilangan (dueDate) qarzlar — qarzdorga
  // to'g'ridan-to'g'ri avtomatik eslatma (bir marta, muddat kelgan/o'tgan
  // kunda, kuniga 1 marta) ----------
  {
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const dueToday = debtsSnap.docs.filter((docSnap) => {
      const d = docSnap.data();
      if (!d.dueDate) return false;
      if (d.dueDate.slice(0, 10) > todayStr) return false; // muddat hali kelmagan
      return d.lastAutoReminderDate !== todayStr; // bugun hali yuborilmagan
    });
    for (const docSnap of dueToday) {
      const d = docSnap.data();
      const remaining = (d.total || 0) - (d.paidAmount || 0);
      if (remaining <= 0.5) continue;
      let cid = null;
      if (d.debtorId) {
        const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
        cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
      }
      const overdue = d.dueDate.slice(0, 10) < todayStr;
      const text = `⏰ <b>${esc(shopName)}</b>\n\n${overdue ? "Qarzingizni to'lash muddati o'tib ketdi." : "Bugun qarzingizni to'lash muddati keldi."}\n💰 Qoldiq: <b>${fmt(remaining)} so'm</b>${d.note ? `\n📝 ${esc(d.note)}` : ''}`;
      if (cid) await sendTelegramMessage(token, cid, text);
      await docSnap.ref.update({ lastAutoReminderDate: todayStr });
    }
  }

  // ---------- 3) Kunlik hisobot ----------
  if (s.telegramNotifyDailyReport && !alreadySent('dailyreport')) {
    const salesSnap = await db.collection('sales').get();
    const sales = salesSnap.docs.map((d) => d.data());
    const todaySales = sales.filter((sale) => !sale.reverted && (sale.date || '').slice(0, 10) === todayStr);
    const revenue = todaySales.reduce((a, sale) => a + (sale.total || 0), 0);
    const profit = todaySales.reduce((a, sale) => a + (sale.price - (sale.cost || 0)) * sale.qty, 0);
    const text = `📊 <b>Kunlik hisobot</b> — ${esc(shopName)}\n${new Date().toLocaleDateString('uz-UZ')}\n\n🧾 Savdolar: ${todaySales.length} ta\n💰 Tushum: ${fmt(revenue)} so'm\n📈 Foyda: ${fmt(profit)} so'm`;
    const ok = await sendToAllAdmins(token, chatIds, text);
    if (ok) patch.dailyreport = todayStr;
  }

  if (Object.keys(patch).length) {
    await sentLogRef.set(patch, { merge: true });
    console.log('Yuborilgan bildirishnomalar:', patch);
  } else {
    console.log("Bugun uchun yangi bildirishnoma yo'q edi (yoki allaqachon yuborilgan).");
  }
  return { ok: true, sent: patch };
}

module.exports = async (req, res) => {
  // Vercel Cron o'zi so'rov yuborganda "Authorization: Bearer <CRON_SECRET>"
  // header'ini qo'shadi (agar CRON_SECRET environment variable o'rnatilgan
  // bo'lsa). Shu orqali boshqa hech kim bu manzilni bekorga chaqirib,
  // bildirishnomalarni oldindan "yuborib qo'ymasin" (kunlik limitni band
  // qilib qo'ymasin) deb tekshiramiz.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  try {
    const result = await runNotify();
    res.status(200).json(result);
  } catch (e) {
    console.error('notify-cron xatolik:', e);
    res.status(200).json({ ok: false, error: String(e) });
  }
};
