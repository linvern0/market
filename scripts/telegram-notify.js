
// telegram-notify.js
// ----------------------------------------------------------------------------
// GitHub Actions uchun 24/7 Telegram bildirishnoma skripti.
// Bu skript ilova OCHIQ bo'lmasa ham (hech kim brauzerda kirmagan bo'lsa ham)
// belgilangan jadval bo'yicha (masalan har 30 daqiqada) ishga tushadi va:
//   1) Firestore'dan sozlamalarni (bot token, adminlar, bildirishnoma turlari) o'qiydi
//   2) Kam qolgan/tugagan tovar, muddati o'tgan qarz va kunlik hisobotni tekshiradi
//   3) Har bir qo'shilgan admin (Chat ID)ga Telegram orqali xabar yuboradi
//   4) Bir kunda faqat bir marta yuborilishini Firestore ichidagi "sentLog"
//      hujjati orqali nazorat qiladi (ilovaning localStorage'idan farqli, bu
//      barcha GitHub Actions ishga tushishlari o'rtasida umumiy holat)
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT topilmadi. GitHub repo -> Settings -> Secrets and variables -> Actions bo'limiga xizmat hisobi (service account) JSON kalitini FIREBASE_SERVICE_ACCOUNT nomi bilan qo'shing."
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return admin.firestore();
}

function fmt(n) {
  return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

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

async function main() {
  const db = initFirebase();

  const settingsSnap = await db.collection('dokon').doc('settings').get();
  if (!settingsSnap.exists) {
    console.log("Sozlamalar hujjati (dokon/settings) topilmadi — chiqilmoqda.");
    return;
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
    return;
  }

  const shopName = s.shopName || "Do'kon";
  const todayStr = new Date().toISOString().slice(0, 10);

  // Bir kunda faqat bir marta yuborish uchun umumiy (Firestore'dagi) holat
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
      const remaining = (d) => (d.amount || 0) - (d.paidAmount || 0);
      const sum = overdue.reduce((a, d) => a + remaining(d), 0);
      const text = `⏰ <b>Muddati o'tgan qarzlar</b> — ${esc(shopName)}\n\n${overdue.length} ta qarzdor, jami ${fmt(sum)} so'm ${overdueDays} kundan ortiq to'lanmagan.`;
      const ok = await sendToAllAdmins(token, chatIds, text);
      if (ok) patch.overdue = todayStr;
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
    console.log('Bugun uchun yangi bildirishnoma yo\'q edi (yoki allaqachon yuborilgan).');
  }
}

main().catch((e) => {
  console.error('telegram-notify.js xatolik bilan yakunlandi:', e);
  process.exit(1);
});
