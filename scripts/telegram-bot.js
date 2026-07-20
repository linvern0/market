
// telegram-bot.js
// ----------------------------------------------------------------------------
// IKKI TOMONLAMA Telegram bot: GitHub Actions orqali muntazam (masalan har 5
// daqiqada) ishga tushib, botga kelgan YANGI xabarlarni (Telegram Bot API'ning
// getUpdates usuli orqali) o'qiydi va ularga javob qaytaradi. telegram-notify.js
// skriptidan farqli — bu FAQAT bir tomonlama ("push") xabar emas, balki
// odamlar botga yozganda ularga javob beradi:
//
//   1) Har qanday ADMIN (Sozlamalar > Telegram bo'limida qo'shilgan Chat ID)
//      botga buyruq (masalan /qarzlar, /tolov, /statistika) yozib, ilovani
//      to'liq boshqarishi mumkin.
//   2) Har qanday MIJOZ (qarzdor) botga /start yozib, telefon raqamini
//      yuborsa, tizim uni "debtors" kolleksiyasidagi mos yozuvga (telefon
//      raqami bo'yicha) bog'laydi — shundan keyin unga YANGI qarz va TO'LOV
//      haqida xabarlar avtomatik boradi (buni ilovaning o'zi, index.html,
//      qarz/tolov amalga oshganda darhol yuboradi).
//
// Bu skript "offset" (oxirgi ko'rilgan update_id) qiymatini Firestore'dagi
// dokon/telegramBotState hujjatida saqlaydi — shu orqali har ishga tushganda
// faqat YANGI xabarlarni qayta ishlaydi (eskilarini takrorlamaydi).
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
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

function fmt(n) {
  return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
// Telefon raqamlarni solishtirish uchun: faqat raqamlarni qoldiramiz va oxirgi
// 9 ta raqamni (O'zbekiston mobil raqami davlat kodisiz) tayanch sifatida
// olamiz — shu orqali "+998901234567", "998901234567", "90 123 45 67" kabi
// turli formatlar bir xil deb topiladi.
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-9);
}
// Telegram usernamelarni solishtirish uchun: boshidagi "@" belgisini olib
// tashlaymiz va kichik harflarga o'giramiz — shu orqali "@Dilnoza",
// "dilnoza", "@DILNOZA" bir xil deb topiladi.
function usernameKey(u) {
  return String(u || '').replace(/^@/, '').trim().toLowerCase();
}
function debtRemaining(d) {
  const rem = (d.total || 0) - (d.paidAmount || 0);
  return rem > 0.5 ? rem : 0;
}

async function tgCall(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}
async function sendMessage(token, chatId, text, extra) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (extra) Object.assign(params, extra);
  const data = await tgCall(token, 'sendMessage', params);
  if (!data.ok) console.error(`Telegram xabar yuborishda xatolik (chat_id=${chatId}):`, data.description || data);
  return data;
}
const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Telefon raqamimni yuborish', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

function isAdminChat(admins, chatId) {
  return admins.some((a) => String(a.chatId).trim() === String(chatId).trim());
}

// "Kutayotgan" (hali chatId bilan bog'lanmagan, faqat telefon va/yoki
// username bilan qo'shilgan) adminlar orasidan mos kelganini topadi.
function findPendingAdminIndex(admins, { phone, username }) {
  const uKey = usernameKey(username);
  const pKey = phoneKey(phone);
  return admins.findIndex((a) => {
    if (a.chatId) return false; // allaqachon bog'langan
    if (uKey && usernameKey(a.username) && usernameKey(a.username) === uKey) return true;
    if (pKey && phoneKey(a.phone) && phoneKey(a.phone) === pKey) return true;
    return false;
  });
}

// Topilgan "kutayotgan" adminni haqiqiy chatId bilan bog'laydi va
// Firestore'ga saqlaydi. `admins` massivini joyida (in-place) o'zgartiradi.
async function linkPendingAdmin(db, settingsRef, admins, idx, chatId) {
  admins[idx] = { ...admins[idx], chatId: String(chatId) };
  await settingsRef.set({ telegramAdmins: admins }, { merge: true });
}

function helpText(admin) {
  let t = `🤖 <b>Do'kon boti</b>\n\n`;
  if (admin) {
    t +=
      `<b>Admin buyruqlari:</b>\n` +
      `/qarzlar — faol (to'lanmagan) qarzlar ro'yxati\n` +
      `/qarz &lt;ism yoki telefon&gt; — muayyan mijoz qarzlarini qidirish\n` +
      `/tolov &lt;ID&gt; &lt;summa&gt; — qarzga to'lov qo'shish\n` +
      `/qarz_qoshish Ism; Telefon; Summa; Izoh — yangi qarz yozish\n` +
      `/statistika — bugungi savdo hisoboti\n` +
      `/ombor — kam qolgan/tugagan tovarlar\n` +
      `/mahsulot &lt;nom&gt; — tovar narxi va qoldig'ini ko'rish\n` +
      `/tovar_narx &lt;nom&gt; &lt;yangi narx&gt; — tovar narxini yangilash\n` +
      `/adminlar — admin ro'yxati\n` +
      `/admin_qoshish &lt;chatId&gt; &lt;Ism&gt; — yangi admin qo'shish\n` +
      `/admin_ochirish &lt;chatId&gt; — adminni o'chirish\n`;
  } else {
    t +=
      `Bu bot orqali qarzingiz va to'lovlaringiz haqida xabar olasiz.\n\n` +
      `📱 Ro'yxatdan o'tish uchun pastdagi tugma orqali telefon raqamingizni yuboring ` +
      `(agar do'kon administratori sizni Telegram username orqali oldindan qo'shgan bo'lsa, buning ham hojati yo'q — avtomatik tanildingiz).\n` +
      `(Agar do'kon administratori sizni admin sifatida telefon raqamingiz bilan qo'shgan bo'lsa, ` +
      `xuddi shu tugma orqali admin sifatida ham avtomatik tanilasiz.)\n` +
      `/qarzim — joriy qarzingizni ko'rish`;
  }
  return t;
}

// Qaytariladigan qiymat: true bo'lsa, telefon raqami "kutayotgan" adminga
// mos kelib, chatId shu odamga bog'landi (bu holda mijoz sifatida qayta
// ishlashning hojati yo'q).
async function tryLinkAdminByContact(db, token, settingsRef, admins, msg) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  if (!phone) return false;
  const idx = findPendingAdminIndex(admins, { phone });
  if (idx === -1) return false;
  const name = admins[idx].name || 'Admin';
  await linkPendingAdmin(db, settingsRef, admins, idx, chatId);
  await sendMessage(
    token, chatId,
    `✅ Xush kelibsiz, <b>${esc(name)}</b>! Siz admin sifatida tanildingiz va endi botni to'liq boshqarishingiz mumkin.\n\n` +
    helpText(true),
    { reply_markup: { remove_keyboard: true } }
  );
  return true;
}

// Topilgan qarzdor(lar)ni chatId bilan bog'laydi va joriy qarz haqida
// xush kelibsiz xabarini yuboradi. Ham telefon orqali (contact), ham
// Telegram username orqali bog'lanishda ishlatiladi.
async function sendDebtorLinkedWelcome(db, token, chatId, matches) {
  const batch = db.batch();
  matches.forEach((d) => batch.set(d.ref, { telegramChatId: String(chatId) }, { merge: true }));
  await batch.commit();

  const debtsSnap = await db.collection('debts').get();
  const names = [...new Set(matches.map((d) => d.data().name))];
  let text = `✅ Ro'yxatdan o'tdingiz: <b>${esc(names.join(', '))}</b>\n\nEndi qarz va to'lovlaringiz haqida shu yerga xabar keladi.\n\n`;
  const debtorIds = matches.map((d) => d.id);
  const myDebts = debtsSnap.docs.map((d) => d.data()).filter((d) => debtorIds.includes(d.debtorId) && !d.paid);
  if (myDebts.length) {
    const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
    text += `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b> (${myDebts.length} ta yozuv)`;
  } else {
    text += `Hozircha faol qarzingiz yo'q. 👍`;
  }
  await sendMessage(token, chatId, text, { reply_markup: { remove_keyboard: true } });
}

async function handleCustomerContact(db, token, msg) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  const key = phoneKey(phone);
  if (!key) {
    await sendMessage(token, chatId, "Telefon raqami o'qilmadi, qaytadan urinib ko'ring.");
    return;
  }
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => phoneKey(d.data().phone) === key);
  if (!matches.length) {
    await sendMessage(
      token,
      chatId,
      "Bu raqam bo'yicha do'konda qarz yozuvi topilmadi. Agar bu xato bo'lsa, do'kon administratoriga murojaat qiling.",
      { reply_markup: { remove_keyboard: true } }
    );
    return;
  }
  await sendDebtorLinkedWelcome(db, token, chatId, matches);
}

// Qarzdor administratorga oldindan Telegram username kiritilgan bo'lsa,
// odam botga /start yozgan zahoti (telefon ulashishning hojati yo'q)
// avtomatik bog'lanadi. Mos kelmasa false qaytaradi — shunda odatdagi
// telefon-orqali oqim (tugma bosish) davom etadi.
async function tryLinkCustomerByUsername(db, token, msg) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches);
  return true;
}

async function handleCustomerMyDebts(db, token, chatId) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) {
    await sendMessage(token, chatId, "Siz hali ro'yxatdan o'tmagansiz. /start yozib telefon raqamingizni yuboring.");
    return;
  }
  const debtorIds = debtorsSnap.docs.map((d) => d.id);
  const debtsSnap = await db.collection('debts').get();
  const myDebts = debtsSnap.docs.map((d) => d.data()).filter((d) => debtorIds.includes(d.debtorId) && !d.paid);
  if (!myDebts.length) {
    await sendMessage(token, chatId, "Faol qarzingiz yo'q. 👍");
    return;
  }
  const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
  let text = `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b>\n\n`;
  myDebts
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10)
    .forEach((d) => {
      text += `• ${new Date(d.date).toLocaleDateString('uz-UZ')} — ${fmt(debtRemaining(d))} so'm\n`;
    });
  await sendMessage(token, chatId, text);
}

async function handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr) {
  const shopName = (await settingsRef.get()).data()?.shopName || "Do'kon";

  if (cmd === '/yordam' || cmd === '/start' || cmd === '/help') {
    return sendMessage(token, chatId, helpText(true));
  }

  if (cmd === '/qarzlar') {
    const debtsSnap = await db.collection('debts').get();
    const active = debtsSnap.docs
      .map((d) => d.data())
      .filter((d) => !d.paid)
      .sort((a, b) => debtRemaining(b) - debtRemaining(a))
      .slice(0, 15);
    if (!active.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q.");
    let text = `📋 <b>Faol qarzlar</b> (eng kattadan)\n\n`;
    active.forEach((d) => {
      text += `• ${esc(d.debtorName || d.org || '?')} — ${fmt(debtRemaining(d))} so'm\n  ID: <code>${esc(d.id)}</code>\n`;
    });
    text += `\nTo'lov qo'shish: <code>/tolov ID summa</code>`;
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/qarz') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Qidiruv uchun ism yoki telefon kiriting: /qarz Aziz");
    const debtsSnap = await db.collection('debts').get();
    const found = debtsSnap.docs
      .map((d) => d.data())
      .filter(
        (d) =>
          !d.paid &&
          ((d.debtorName || '').toLowerCase().includes(q) ||
            (d.org || '').toLowerCase().includes(q) ||
            (d.phone || '').includes(q))
      );
    if (!found.length) return sendMessage(token, chatId, "Hech narsa topilmadi.");
    const total = found.reduce((a, d) => a + debtRemaining(d), 0);
    let text = `🔎 "${esc(argStr.trim())}" bo'yicha: <b>${fmt(total)} so'm</b>\n\n`;
    found.slice(0, 15).forEach((d) => {
      text += `• ${new Date(d.date).toLocaleDateString('uz-UZ')} — ${fmt(debtRemaining(d))} so'm (ID: <code>${esc(d.id)}</code>)\n`;
    });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/tolov') {
    const parts = argStr.trim().split(/\s+/);
    const idPart = parts[0];
    const amount = parseFloat(parts[1]);
    if (!idPart || isNaN(amount) || amount <= 0) {
      return sendMessage(token, chatId, "Foydalanish: /tolov ID summa\nMasalan: /tolov ab12cd 50000");
    }
    const debtsSnap = await db.collection('debts').get();
    const matches = debtsSnap.docs.filter((d) => d.id === idPart || d.id.startsWith(idPart));
    if (!matches.length) return sendMessage(token, chatId, "Bunday ID'li qarz topilmadi. /qarzlar orqali ID'ni tekshiring.");
    if (matches.length > 1) return sendMessage(token, chatId, "Bir nechta qarz shu ID bilan boshlanadi — to'liq ID kiriting.");
    const debtDoc = matches[0];
    const d = debtDoc.data();
    const remaining = debtRemaining(d);
    if (remaining <= 0) return sendMessage(token, chatId, "Bu qarz allaqachon to'liq to'langan.");
    const applied = Math.min(Math.round(amount), Math.round(remaining));
    const payment = { amount: applied, date: new Date().toISOString(), note: 'Telegram bot orqali', by: 'Telegram admin' };
    const newPaidAmount = (d.paidAmount || 0) + applied;
    const isFullyPaid = d.total - newPaidAmount <= 0.5;
    const patch = {
      paidAmount: admin.firestore.FieldValue.increment(applied),
      payments: admin.firestore.FieldValue.arrayUnion(payment),
    };
    if (isFullyPaid) {
      patch.paid = true;
      patch.paidDate = payment.date;
    }
    await debtDoc.ref.update(patch);
    await sendMessage(
      token,
      chatId,
      `✅ ${fmt(applied)} so'm to'lov qabul qilindi: ${esc(d.debtorName || d.org || '')}${isFullyPaid ? '\n🎉 Qarz to\'liq yopildi!' : `\nQoldiq: ${fmt(remaining - applied)} so'm`}`
    );
    // Mijozga ham xabar boradi (agar bog'langan bo'lsa)
    if (d.debtorId) {
      const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
      const cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
      if (cid) {
        await sendMessage(
          token,
          cid,
          `💵 <b>${esc(shopName)}</b>\n\nSizning ${fmt(applied)} so'm to'lovingiz qabul qilindi.${isFullyPaid ? "\n🎉 Qarzingiz to'liq yopildi!" : `\nQolgan qarz: ${fmt(remaining - applied)} so'm`}`
        );
      }
    }
    return;
  }

  if (cmd === '/qarz_qoshish') {
    // Format: /qarz_qoshish Ism; Telefon; Summa; Izoh
    const parts = argStr.split(';').map((s) => s.trim());
    const [name, phone, amountStr, note] = parts;
    const amount = parseFloat(amountStr);
    if (!name || isNaN(amount) || amount <= 0) {
      return sendMessage(token, chatId, "Foydalanish: /qarz_qoshish Ism; Telefon; Summa; Izoh\nMasalan: /qarz_qoshish Aziz Karimov; +998901234567; 50000; noutbuk narxi");
    }
    const now = new Date().toISOString();
    const debtorsSnap = await db.collection('debtors').get();
    const debtor = debtorsSnap.docs.find((d) => d.data().name === name && !d.data().org);
    const debtorId = debtor ? debtor.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!debtor) {
      await db.collection('debtors').doc(debtorId).set({
        id: debtorId, name, org: '', phone: phone || '', login: '', password: '', createdAt: now,
      });
    }
    const debtId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const debt = {
      id: debtId, debtorId, debtorName: name, org: '', phone: phone || '',
      items: [], total: amount, paid: false, paidDate: null,
      date: now, note: note || 'Telegram bot orqali qo\'shildi', seller: 'Telegram admin', type: 'person',
    };
    await db.collection('debts').doc(debtId).set(debt);
    await sendMessage(token, chatId, `✅ Yangi qarz yozildi: ${esc(name)} — ${fmt(amount)} so'm`);
    return;
  }

  if (cmd === '/statistika') {
    const todayStr = new Date().toISOString().slice(0, 10);
    const salesSnap = await db.collection('sales').get();
    const todaySales = salesSnap.docs.map((d) => d.data()).filter((s) => !s.reverted && (s.date || '').slice(0, 10) === todayStr);
    const revenue = todaySales.reduce((a, s) => a + (s.total || 0), 0);
    const profit = todaySales.reduce((a, s) => a + (s.price - (s.cost || 0)) * s.qty, 0);
    return sendMessage(
      token,
      chatId,
      `📊 <b>Bugungi hisobot</b> — ${esc(shopName)}\n\n🧾 Savdolar: ${todaySales.length} ta\n💰 Tushum: ${fmt(revenue)} so'm\n📈 Foyda: ${fmt(profit)} so'm`
    );
  }

  if (cmd === '/ombor') {
    const productsSnap = await db.collection('products').get();
    const products = productsSnap.docs.map((d) => d.data());
    const threshold = (await settingsRef.get()).data()?.lowStockThreshold || 5;
    const low = products.filter((p) => p.stock <= threshold && p.stock > 0);
    const empty = products.filter((p) => p.stock === 0);
    if (!low.length && !empty.length) return sendMessage(token, chatId, "✅ Barcha tovarlar yetarli.");
    let text = `⚠️ <b>Ombor holati</b>\n\n`;
    if (empty.length) text += `🔴 Tugagan (${empty.length}): ${empty.slice(0, 20).map((p) => esc(p.name)).join(', ')}\n`;
    if (low.length) text += `🟡 Kam qolgan (${low.length}): ${low.slice(0, 20).map((p) => `${esc(p.name)} (${p.stock})`).join(', ')}`;
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/mahsulot') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Foydalanish: /mahsulot nomi");
    const productsSnap = await db.collection('products').get();
    const found = productsSnap.docs.map((d) => d.data()).filter((p) => (p.name || '').toLowerCase().includes(q));
    if (!found.length) return sendMessage(token, chatId, "Topilmadi.");
    let text = `🔎 "${esc(argStr.trim())}" bo'yicha (${found.length} ta):\n\n`;
    found.slice(0, 15).forEach((p) => {
      text += `• ${esc(p.name)} — ${fmt(p.price)} so'm, qoldiq: ${p.stock} ta\n`;
    });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/tovar_narx') {
    const m = argStr.match(/^(.*)\s+(\d+)$/);
    if (!m) return sendMessage(token, chatId, "Foydalanish: /tovar_narx nomi yangi_narx\nMasalan: /tovar_narx Coca-Cola 12000");
    const q = m[1].trim().toLowerCase();
    const newPrice = parseFloat(m[2]);
    const productsSnap = await db.collection('products').get();
    const found = productsSnap.docs.filter((d) => (d.data().name || '').toLowerCase().includes(q));
    if (!found.length) return sendMessage(token, chatId, "Tovar topilmadi.");
    if (found.length > 1) {
      return sendMessage(
        token, chatId,
        `Bir nechta tovar topildi, aniqroq nom kiriting:\n${found.slice(0, 10).map((d) => '• ' + esc(d.data().name)).join('\n')}`
      );
    }
    await found[0].ref.update({ price: newPrice });
    return sendMessage(token, chatId, `✅ "${esc(found[0].data().name)}" narxi ${fmt(newPrice)} so'mga yangilandi.`);
  }

  if (cmd === '/adminlar') {
    if (!admins.length) return sendMessage(token, chatId, "Hali admin qo'shilmagan.");
    let text = `👤 <b>Adminlar</b>\n\n`;
    admins.forEach((a) => {
      if (a.chatId) {
        text += `• ✅ ${esc(a.name || 'Admin')} — Chat ID: <code>${esc(a.chatId)}</code>\n`;
      } else {
        const via = a.username ? `@${esc(a.username)}` : a.phone ? esc(a.phone) : '—';
        text += `• ⏳ ${esc(a.name || 'Admin')} — kutmoqda (${via})\n`;
      }
    });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/admin_qoshish') {
    // Ikkita usulda ishlaydi:
    //   1) /admin_qoshish 123456789 Ism           — to'g'ridan-to'g'ri Chat ID bilan (darhol faollashadi)
    //   2) /admin_qoshish +998901234567 Ism        — telefon raqami bilan (odam botga
    //      yozganda yoki telefon raqamini yuborganda avtomatik faollashadi)
    //   3) /admin_qoshish @username Ism            — username bilan (odam botga birinchi
    //      marta yozganda avtomatik faollashadi)
    const parts = argStr.trim().split(/\s+/);
    const idArg = parts[0];
    const name = parts.slice(1).join(' ') || 'Admin';
    if (!idArg) {
      return sendMessage(
        token, chatId,
        "Foydalanish:\n" +
        "/admin_qoshish 123456789 Ism — Chat ID bilan\n" +
        "/admin_qoshish +998901234567 Ism — telefon raqami bilan\n" +
        "/admin_qoshish @username Ism — username bilan"
      );
    }
    const isNumericChatId = /^-?\d{5,}$/.test(idArg) && !idArg.startsWith('+');
    const isUsername = idArg.startsWith('@');
    const newAdmin = { id: 'tg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, chatId: '', phone: '', username: '' };
    if (isNumericChatId) {
      if (admins.some((a) => String(a.chatId) === idArg)) return sendMessage(token, chatId, "Bu Chat ID allaqachon admin.");
      newAdmin.chatId = idArg;
    } else if (isUsername) {
      const uKey = usernameKey(idArg);
      if (admins.some((a) => usernameKey(a.username) === uKey)) return sendMessage(token, chatId, "Bu username allaqachon admin ro'yxatida.");
      newAdmin.username = idArg.replace(/^@/, '');
    } else {
      const pKey = phoneKey(idArg);
      if (!pKey) return sendMessage(token, chatId, "Telefon raqami noto'g'ri formatda.");
      if (admins.some((a) => phoneKey(a.phone) === pKey)) return sendMessage(token, chatId, "Bu telefon raqami allaqachon admin ro'yxatida.");
      newAdmin.phone = idArg;
    }
    admins.push(newAdmin);
    await settingsRef.set({ telegramAdmins: admins }, { merge: true });
    if (newAdmin.chatId) {
      await sendMessage(token, chatId, `✅ Yangi admin qo'shildi: ${esc(name)} (${esc(newAdmin.chatId)})`);
      await sendMessage(token, newAdmin.chatId, `👋 Siz "${esc(shopName)}" do'konining Telegram admini etib tayinlandingiz. /yordam yozib buyruqlar ro'yxatini ko'ring.`).catch(() => {});
    } else {
      await sendMessage(
        token, chatId,
        `✅ ${esc(name)} "kutayotgan admin" sifatida qo'shildi.\n` +
        `U botga birinchi marta yozganda (yoki telefon raqamini yuborganda) avtomatik faollashadi.`
      );
    }
    return;
  }

  if (cmd === '/admin_ochirish') {
    const target = argStr.trim();
    if (!target) return sendMessage(token, chatId, "Foydalanish: /admin_ochirish 123456789 (yoki telefon/@username)");
    const uKey = usernameKey(target);
    const pKey = phoneKey(target);
    const remaining = admins.filter((a) => {
      if (String(a.chatId) === target) return false;
      if (target.startsWith('@') && usernameKey(a.username) === uKey) return false;
      if (pKey && phoneKey(a.phone) === pKey) return false;
      return true;
    });
    if (remaining.length === admins.length) return sendMessage(token, chatId, "Bunday admin topilmadi.");
    await settingsRef.set({ telegramAdmins: remaining }, { merge: true });
    return sendMessage(token, chatId, `✅ Admin o'chirildi (${esc(target)}).`);
  }

  return sendMessage(token, chatId, "Noma'lum buyruq. /yordam yozing.");
}

async function main() {
  const db = initFirebase();
  const settingsRef = db.collection('dokon').doc('settings');
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) { console.log('Sozlamalar topilmadi.'); return; }
  const s = settingsSnap.data();
  const token = (s.telegramBotToken || '').trim();
  if (!token) { console.log("Bot token sozlanmagan."); return; }
  const admins = Array.isArray(s.telegramAdmins) ? s.telegramAdmins : [];

  const stateRef = db.collection('dokon').doc('telegramBotState');
  const stateSnap = await stateRef.get();
  const offset = stateSnap.exists ? stateSnap.data().offset || 0 : 0;

  const updatesRes = await tgCall(token, 'getUpdates', { offset, timeout: 0, limit: 50 });
  if (!updatesRes.ok) { console.error('getUpdates xatosi:', updatesRes.description); return; }
  const updates = updatesRes.result || [];
  if (!updates.length) { console.log('Yangi xabar yo\'q.'); return; }

  let maxUpdateId = offset - 1;
  for (const upd of updates) {
    maxUpdateId = Math.max(maxUpdateId, upd.update_id);
    try {
      const msg = upd.message;
      if (!msg) continue;
      const chatId = msg.chat.id;
      let admin_ = isAdminChat(admins, chatId);

      // Agar bu odam hali admin sifatida bog'lanmagan bo'lsa, uning Telegram
      // username'ini (agar bor bo'lsa) "kutayotgan" adminlar ro'yxati bilan
      // solishtiramiz — mos kelsa, u YANGI HAR QANDAY xabar yozganda
      // (nafaqat /start'da) avtomatik admin sifatida bog'lanadi.
      if (!admin_ && msg.from && msg.from.username) {
        const idx = findPendingAdminIndex(admins, { username: msg.from.username });
        if (idx !== -1) {
          const name = admins[idx].name || 'Admin';
          await linkPendingAdmin(db, settingsRef, admins, idx, chatId);
          admin_ = true;
          await sendMessage(
            token, chatId,
            `✅ Xush kelibsiz, <b>${esc(name)}</b>! Siz admin sifatida tanildingiz va endi botni to'liq boshqarishingiz mumkin.\n\n` +
            helpText(true)
          );
          continue;
        }
      }

      if (msg.contact) {
        const linkedAsAdmin = await tryLinkAdminByContact(db, token, settingsRef, admins, msg);
        if (linkedAsAdmin) continue;
        await handleCustomerContact(db, token, msg);
        continue;
      }
      const text = (msg.text || '').trim();
      if (!text) continue;

      if (text === '/start') {
        if (!admin_) {
          const linkedByUsername = await tryLinkCustomerByUsername(db, token, msg);
          if (linkedByUsername) continue;
        }
        await sendMessage(token, chatId, helpText(admin_), admin_ ? undefined : { reply_markup: CONTACT_KEYBOARD });
        continue;
      }
      if (text === '/qarzim' && !admin_) {
        await handleCustomerMyDebts(db, token, chatId);
        continue;
      }
      if (text.startsWith('/')) {
        const spaceIdx = text.indexOf(' ');
        const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
        const argStr = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);
        if (!admin_) {
          await sendMessage(token, chatId, "Bu buyruq faqat do'kon adminlari uchun. /start yozib ro'yxatdan o'ting yoki /qarzim orqali qarzingizni ko'ring.");
          continue;
        }
        await handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr);
        continue;
      }
      // Oddiy matn (buyruq emas)
      await sendMessage(token, chatId, helpText(admin_));
    } catch (e) {
      console.error('Update qayta ishlashda xatolik:', e);
    }
  }

  await stateRef.set({ offset: maxUpdateId + 1 }, { merge: true });
  console.log(`${updates.length} ta yangi xabar qayta ishlandi.`);
}

main().catch((e) => {
  console.error('telegram-bot.js xatolik bilan yakunlandi:', e);
  process.exit(1);
});
