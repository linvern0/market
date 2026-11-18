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

function getDb() { return require('./_firebase').getDb(); }
const { invalidateSettingsCache } = require('./_firebase');

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

  const settingsRef = db.collection('dokon').doc('settings');
  const settingsSnap = await settingsRef.get();
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

  if (!token) {
    console.log("Bot token sozlanmagan — ilova ichidagi 'Sozlamalar > Telegram' bo'limida to'ldiring.");
    return { ok: true, info: 'no token' };
  }

  // TUZATILDI (MUHIM): "📢 Mijozlarga rejalashtirilgan xabar yuborish"
  // ilgari pastdagi "admin Chat ID sozlanmagan bo'lsa BUTUNLAY chiqib
  // ketish" tekshiruvidan KEYIN joylashgan edi — ya'ni agar do'kon admin
  // xabarnomalarini (past zaxira/qarz/hisobot) sozlamagan bo'lsa, MIJOZLARGA
  // rejalashtirilgan xabar ham hech qachon yuborilmasdi, garchi bu ikkisi
  // bir-biriga aloqasi yo'q funksiyalar bo'lsa ham (biri admin uchun,
  // ikkinchisi mijozlar uchun). Endi bu tekshiruv faqat "token" borligini
  // talab qiladi (admin Chat ID shart emas) va ADMIN xabarnomalari
  // gate'idan OLDIN ishlaydi.
  try {
    const broadcasts = Array.isArray(s.scheduledBroadcasts) ? s.scheduledBroadcasts : [];
    const due = broadcasts.filter((b) => !b.sent && new Date(b.sendAt).getTime() <= Date.now());
    if (due.length) {
      const customersSnap = await db.collection('customers').get();
      const allCustomers = customersSnap.docs.map((d) => d.data());
      const segmentTargets = (segment) => {
        const now = Date.now();
        return allCustomers.filter((c) => {
          if (!c.telegramChatId) return false;
          if (segment === 'coin') return (c.points || 0) > 0;
          if (segment === 'active30') { const t = c.lastPurchaseAt ? new Date(c.lastPurchaseAt).getTime() : 0; return t && now - t <= 30 * 86400000; }
          if (segment === 'inactive30') { const t = c.lastPurchaseAt ? new Date(c.lastPurchaseAt).getTime() : 0; return !t || now - t > 30 * 86400000; }
          return true;
        });
      };
      const shopNameBC = s.shopName || "Do'kon";
      for (const b of due) {
        const targets = b.targetType === 'customers' ? segmentTargets(b.segment) : [];
        const full = `📢 <b>${esc(shopNameBC)}</b>\n\n${esc(b.text)}`;
        for (const c of targets) {
          try { await sendToAllAdmins(token, [c.telegramChatId], full); } catch (e) { /* bittasi xato bo'lsa ham davom etamiz */ }
        }
        b.sent = true;
        b.sentAt = new Date().toISOString();
        b.sentCount = targets.length;
      }
      const cleaned = broadcasts.filter((b) => !b.sent || Date.now() - new Date(b.sentAt || b.sendAt).getTime() < 30 * 86400000);
      await settingsRef.set({ scheduledBroadcasts: cleaned }, { merge: true });
      invalidateSettingsCache();
    }
  } catch (e) { console.error('Rejalashtirilgan xabarlarni yuborishda xatolik:', e); }

  if (!chatIds.length) {
    console.log("Admin (Chat ID) sozlanmagan — admin xabarnomalari (past zaxira/qarz/hisobot) o'tkazib yuborildi.");
    return { ok: true, info: 'no admins' };
  }

  const shopName = s.shopName || "Do'kon";
  const currencySymbol = s.currencySymbol || "so'm";
  // v7: sana do'kon vaqt zonasida (standart Asia/Tashkent). Ilgari UTC ishlatilib,
  // zonasi boshqacha do'konlarda "bugun/kecha" 1 kunga adashardi.
  let todayStr;
  try { todayStr = new Date().toLocaleDateString('en-CA', { timeZone: s.timezone || 'Asia/Tashkent' }); }
  catch (e) { todayStr = new Date().toISOString().slice(0, 10); }

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
    const stockOf = (p) => Number(p.stock) || 0;
    const low = products.filter((p) => stockOf(p) <= threshold && stockOf(p) > 0);
    const empty = products.filter((p) => stockOf(p) <= 0); // v7: manfiy/bo'sh zaxira ham "tugagan"
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
    // OPTIMALLASHTIRISH (Firebase xarajati): ilgari BUTUN 'debts'
    // to'plami (to'langanlari ham) har kuni o'qilardi — vaqt o'tishi
    // bilan bu son cheksiz o'sib boradi. Endi faqat hali TO'LANMAGAN
    // qarzlar o'qiladi (`paid == false`), chunki faqat ular muddati
    // o'tganligi bo'yicha tekshiriladi — to'langan qarzlarni o'qishning
    // hojati yo'q.
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const debts = debtsSnap.docs.map((d) => d.data());
    const overdueDays = s.overdueDaysGlobal || 14;
    const overdue = debts.filter(
      (d) => ((d.total || 0) - (d.paidAmount || 0)) > 0.5 && Date.now() - new Date(d.date).getTime() >= overdueDays * 86400000
    );
    if (overdue.length) {
      const remaining = (d) => (d.total || 0) - (d.paidAmount || 0);
      const sum = overdue.reduce((a, d) => a + remaining(d), 0);
      const text = `⏰ <b>Muddati o'tgan qarzlar</b> — ${esc(shopName)}\n\n${overdue.length} ta qarzdor, jami ${fmt(sum)} ${esc(currencySymbol)} ${overdueDays} kundan ortiq to'lanmagan.`;
      const ok = await sendToAllAdmins(token, chatIds, text);
      if (ok) patch.overdue = todayStr;
    }
  }

  // ---------- 2.5) Muddati belgilangan (dueDate) qarzlar — KO'P BOSQICHLI
  // avto-eslatma jadvali. YANGI: ilgari faqat BITTA eslatma yuborilardi
  // (muddat kelgan/o'tgan kuni, kuniga 1 marta — lastAutoReminderDate orqali
  // nazorat qilinardi). Endi admin Sozlamalar'da butun jadval belgilashi
  // mumkin (`debtReminderOffsets`, masalan [-3,-1,0,3,7] — muddatdan necha
  // kun OLDIN yoki necha kun O'TGACH eslatish kerakligi). Har bir bosqich
  // faqat BIR MARTA yuboriladi — yuborilgan bosqichlar debt.remindersSent
  // massivida saqlanadi (eski lastAutoReminderDate maydoni endi
  // ishlatilmaydi, lekin eski yozuvlarga ham ta'sir qilmaydi). ----------
  {
    const offsets = (Array.isArray(s.debtReminderOffsets) && s.debtReminderOffsets.length)
      ? [...new Set(s.debtReminderOffsets.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)))].sort((a, b) => a - b)
      : [0, 3, 7]; // standart: muddat kunida, 3 va 7 kun o'tgach
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const withDue = debtsSnap.docs.filter((docSnap) => docSnap.data().dueDate);
    for (const docSnap of withDue) {
      const d = docSnap.data();
      const remaining = (d.total || 0) - (d.paidAmount || 0);
      if (remaining <= 0.5) continue;
      const dueMs = new Date(d.dueDate.slice(0, 10)).getTime();
      const daysFromDue = Math.round((new Date(todayStr).getTime() - dueMs) / 86400000);
      // Bugungi kunga mos keladigan (yoki o'tib ketgan, hali yuborilmagan
      // eng yaqin) bosqich(lar)ni topamiz. Faqat "daysFromDue >= offset"
      // bo'lgan eng so'nggi (kattaroq) offsetni yuboramiz — shunda
      // Cron bir kun ishlamay qolsa ham, oraliq bosqich butunlay
      // tashlab ketilmaydi (eng yaqin mos bosqich baribir yuboriladi).
      const sent = Array.isArray(d.remindersSent) ? d.remindersSent : [];
      const dueOffsets = offsets.filter((off) => daysFromDue >= off && !sent.includes(off));
      if (!dueOffsets.length) continue;
      const stage = dueOffsets[dueOffsets.length - 1]; // eng yaqin/so'nggi mos bosqich

      let cid = null;
      if (d.debtorId) {
        const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
        cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
      }
      let situationText;
      if (stage < 0) situationText = `Qarzingizni to'lash muddatiga ${Math.abs(stage)} kun qoldi.`;
      else if (stage === 0) situationText = "Bugun qarzingizni to'lash muddati keldi.";
      else situationText = `Qarzingizni to'lash muddati ${stage} kun oldin o'tib ketgan.`;
      const text = `⏰ <b>${esc(shopName)}</b>\n\n${situationText}\n💰 Qoldiq: <b>${fmt(remaining)} ${esc(currencySymbol)}</b>${d.note ? `\n📝 ${esc(d.note)}` : ''}`;
      // TUZATILDI (MUHIM): ilgari qarzdor hali Telegram'ga ulanmagan bo'lsa
      // ham (cid yo'q — xabar HAQIQATDA yuborilmagan bo'lsa ham), pastdagi
      // "remindersSent" baribir yangilanardi — ya'ni bosqich "yuborilgan"
      // deb "yolg'on" belgilanib qolardi. Natijada qarzdor KEYINROQ botga
      // ulansa ham (masalan ertasi kuni /start bossa), o'sha o'tkazib
      // yuborilgan eslatma bosqichi UNGA HECH QACHON yetib bormas edi —
      // chunki tizim uni allaqachon "yuborilgan" deb hisoblab qo'ygan edi.
      // Endi faqat XABAR HAQIQATDA yuborilganda (cid mavjud bo'lganda)
      // "yuborilgan" deb belgilanadi — aks holda keyingi cron ishga
      // tushganda (agar shu orada ulangan bo'lsa) qayta urinib ko'riladi.
      if (cid) {
        await sendTelegramMessage(token, cid, text);
        await docSnap.ref.update({ remindersSent: admin.firestore.FieldValue.arrayUnion(...dueOffsets), lastAutoReminderDate: todayStr });
      }
    }
  }

  // ---------- 3) Kunlik hisobot ----------
  if (s.telegramNotifyDailyReport && !alreadySent('dailyreport')) {
    // OPTIMALLASHTIRISH (Firebase xarajati): ilgari BUTUN 'sales'
    // to'plami (loyiha boshlanganidan beri bo'lgan HAMMA savdolar) har
    // kuni o'qilardi, faqat bugungisini ajratib olish uchun — vaqt
    // o'tishi bilan bu son cheksiz o'sib, kunlik cron ishga tushganda
    // xarajat ham shunga yarasha ortib boradi. 'date' maydoni ISO
    // formatda (masalan "2026-08-16T...") saqlangani uchun matn bo'yicha
    // range-so'rov orqali faqat BUGUNGI savdolar o'qiladi.
    const salesSnap = await db.collection('sales')
      .where('date', '>=', todayStr)
      .where('date', '<', todayStr + '\uf8ff')
      .get();
    const todaySales = salesSnap.docs.map((d) => d.data()).filter((sale) => !sale.reverted);
    const revenue = todaySales.reduce((a, sale) => a + (sale.total || 0), 0);
    const profit = todaySales.reduce((a, sale) => a + (sale.price - (sale.cost || 0)) * sale.qty, 0);
    // YANGI: yangi mijozlar statistikasi (bugun va so'nggi 7 kunda
    // sodiqlik dasturiga qo'shilgan mijozlar soni) — kunlik hisobotga
    // qo'shildi.
    let newCustomersLine = '';
    try {
      const customersSnap = await db.collection('customers').get();
      const customers = customersSnap.docs.map((d) => d.data());
      const now = Date.now();
      const newToday = customers.filter((c) => (c.createdAt || '').slice(0, 10) === todayStr).length;
      const newWeek = customers.filter((c) => c.createdAt && now - new Date(c.createdAt).getTime() <= 7 * 86400000).length;
      newCustomersLine = `\n👥 Yangi mijozlar: bugun ${newToday} ta, so'nggi 7 kunda ${newWeek} ta`;
    } catch (e) { /* mijozlar bo'limi bo'lmasa ham hisobot to'xtab qolmasin */ }
    const text = `📊 <b>Kunlik hisobot</b> — ${esc(shopName)}\n${new Date().toLocaleDateString('uz-UZ')}\n\n🧾 Savdolar: ${todaySales.length} ta\n💰 Tushum: ${fmt(revenue)} ${esc(currencySymbol)}\n📈 Foyda: ${fmt(profit)} ${esc(currencySymbol)}${newCustomersLine}`;
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
    const a = Buffer.from(auth), b = Buffer.from(`Bearer ${cronSecret}`);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  try {
    const result = await runNotify();
    res.status(200).json(result);
  } catch (e) {
    console.error('notify-cron xatolik:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
