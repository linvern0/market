// api/telegram-webhook.js
// ----------------------------------------------------------------------------
// Vercel serverless funksiyasi. scripts/telegram-bot.js dagi bilan BIR XIL
// mantiq — farqi shundaki, bu yerda GitHub Actions cron/getUpdates polling
// o'RNIGA, Telegram WEBHOOK orqali har bir xabarni DARHOL (real vaqtda,
// kechikishsiz) shu funksiyaga yuboradi. Vercel Hobby (bepul) reja bunday
// yuk uchun to'liq yetarli va funksiya 24/7 tayyor turadi.
//
// SOZLASH (bir marta):
//   1) Bu repo'ni Vercel'ga ulang (vercel.com -> New Project -> GitHub repo).
//   2) Vercel loyihasi -> Settings -> Environment Variables bo'limiga
//      qo'shing:
//        FIREBASE_SERVICE_ACCOUNT   = (Firebase xizmat hisobi JSON'i, bitta qatorda)
//        TELEGRAM_WEBHOOK_SECRET    = (o'zingiz o'ylab topgan tasodifiy, uzun matn -
//                                      masalan 32 ta belgidan iborat tasodifiy satr)
//   3) Deploy tugagach, sizga masalan https://SIZNING-LOYIHA.vercel.app manzili beriladi.
//   4) Brauzerda (bir marta) shu manzilga o'ting - bu Telegram'ga
//      "har bir yangi xabarni shu URL'ga yubor" deb aytadi:
//
//      https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://SIZNING-LOYIHA.vercel.app/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
//
//   5) Shundan keyin GitHub Actions'dagi eski "telegram-bot.yml" workflow'ini
//      O'CHIRIB TASHLANG (yoki repo'dan olib tashlang) - webhook va polling
//      (getUpdates) bir vaqtda ishlay olmaydi, ular bir-biriga zid keladi.
//      ("telegram-notify.yml" esa qolaveradi - u boshqa ish qiladi, muammo yo'q.)
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
function phoneKey(phone) { return String(phone || '').replace(/\D/g, '').slice(-9); }
function usernameKey(u) { return String(u || '').replace(/^@/, '').trim().toLowerCase(); }
function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }

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
// ESKI: telefon-tugmasi endi ishlatilmaydi (qarzdorlar avtomatik, tugmasiz
// aniqlanadi — Telegram username va/yoki Telegram ID orqali). Funksiya
// mos kelish uchun saqlab qolindi, lekin hech qayerda chaqirilmaydi.
const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Telefon raqamimni yuborish', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// Mini App (web_app) tugmasi uchun inline keyboard. URL'ni so'rov kelgan
// host'dan avtomatik olamiz - shuning uchun alohida ENV o'zgaruvchi shart
// emas (domen o'zgarsa ham ishlayveradi).
// MUHIM (yangilanish): Admin uchun endi maxsus, soddalashtirilgan
// "miniapp.html" o'rniga TO'G'RIDAN-TO'G'RI to'liq veb-panel (index.html —
// veb-brauzerda ochiladigan boshqaruv paneli bilan BIR XIL fayl) ochiladi.
// Shu sababli admin endi hech qanday /buyruq yozmasdan, veb-loyihadagi
// BARCHA imkoniyatlarni (hisobot, ombor, xarajat, mijozlar va h.k.) shu
// Mini App ichida bajara oladi — ikkita alohida interfeys emas, bitta manba.
// Qarzdorlar uchun esa hamon yengil, faqat o'z qarzini ko'rsatadigan
// "miniapp.html" ochiladi (ular uchun to'liq admin panelini ko'rsatish
// xavfsizlik nuqtai nazaridan noto'g'ri bo'lardi).
function miniAppKeyboard(req, isAdmin) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return undefined;
  const file = isAdmin ? 'index.html' : 'miniapp.html';
  const text = isAdmin ? '🖥 Boshqaruv panelini ochish' : '📱 Mini-ilovani ochish';
  const url = `https://${host}/${file}`;
  return { inline_keyboard: [[{ text, web_app: { url } }]] };
}

// Telegram'ning pastki, DOIMIY menyu tugmasi (chat oynasining chap pastki
// burchagidagi "Menu"/ilova belgisi) — inline xabar tugmasidan farqli
// o'laroq, bu tugma suhbat tarixida "yo'qolib qolmaydi", doim ko'rinib
// turadi. Buni faqat ADMIN sifatida tanilgan chat'lar uchun, ularning
// shaxsiy chat'iga (chat_id bo'yicha) o'rnatamiz — shunda ular botga hech
// narsa yozmasdan ham, istalgan payt bitta bosish bilan to'liq boshqaruv
// panelini ochishlari mumkin.
async function setAdminMenuButton(token, chatId, req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return;
  const url = `https://${host}/index.html`;
  try {
    await tgCall(token, 'setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text: 'Boshqaruv paneli', web_app: { url } },
    });
  } catch (e) { console.error('setChatMenuButton xatolik:', e); }
}

function isAdminChat(admins, chatId) { return admins.some((a) => String(a.chatId).trim() === String(chatId).trim()); }
function findPendingAdminIndex(admins, { phone, username }) {
  const uKey = usernameKey(username);
  const pKey = phoneKey(phone);
  return admins.findIndex((a) => {
    if (a.chatId) return false;
    if (uKey && usernameKey(a.username) && usernameKey(a.username) === uKey) return true;
    if (pKey && phoneKey(a.phone) && phoneKey(a.phone) === pKey) return true;
    return false;
  });
}
async function linkPendingAdmin(settingsRef, admins, idx, chatId) {
  admins[idx] = { ...admins[idx], chatId: String(chatId) };
  await settingsRef.set({ telegramAdmins: admins }, { merge: true });
}
function helpText(isAdmin) {
  let t = `🤖 <b>Do'kon boti</b>\n\n`;
  if (isAdmin) {
    t += `✅ Endi deyarli hamma narsani buyruq yozmasdan, to'g'ridan-to'g'ri ` +
      `<b>boshqaruv panelida</b> qilishingiz mumkin — u veb-saytdagi (brauzerdagi) ` +
      `bilan AYNAN BIR XIL panel, faqat shu bot ichida ochiladi:\n\n` +
      `🖥 /ilova — Boshqaruv panelini ochish (qarzlar, tovarlar, sotish, hisobotlar, xarajatlar, mijozlar — hammasi shu yerda)\n\n` +
      `Buyruqlar ixtiyoriy, tezkor holatlar uchun hamon mavjud:\n` +
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
    t += `Bu bot orqali qarzingiz va to'lovlaringiz haqida xabar olasiz.\n\n` +
      `✅ Hech qanday tugma bosish shart emas — do'kon administratori sizni ` +
      `Telegram username yoki Telegram ID orqali oldindan ro'yxatga qo'shgan bo'lsa, ` +
      `siz shunchaki shu botga <b>/start</b> yozishingiz bilan avtomatik tanilasiz.\n\n` +
      `/qarzim — joriy qarzingizni ko'rish\n` +
      `/ilova — Mini-ilovada qarzingizni to'liq ko'rish`;
  }
  return t;
}

async function tryLinkAdminByContact(token, settingsRef, admins, msg, kb) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  if (!phone) return false;
  const idx = findPendingAdminIndex(admins, { phone });
  if (idx === -1) return false;
  const name = admins[idx].name || 'Admin';
  await linkPendingAdmin(settingsRef, admins, idx, chatId);
  await sendMessage(token, chatId,
    `✅ Xush kelibsiz, <b>${esc(name)}</b>! Siz admin sifatida tanildingiz va endi botni to'liq boshqarishingiz mumkin.\n\n` + helpText(true),
    { reply_markup: kb || { remove_keyboard: true } });
  return true;
}

async function sendDebtorLinkedWelcome(db, token, chatId, matches, kb) {
  const batch = db.batch();
  matches.forEach((d) => batch.set(d.ref, { telegramChatId: String(chatId) }, { merge: true }));
  await batch.commit();
  const debtsSnap = await db.collection('debts').get();
  const names = [...new Set(matches.map((d) => d.data().name))];
  let text = `✅ Ro'yxatdan o'tdingiz: <b>${esc(names.join(', '))}</b>\n\nEndi qarz va to'lovlaringiz haqida shu yerga xabar keladi.\n\n`;
  const org = matches.find((d) => d.data().org)?.data().org || '';
  const isOrgViewer = !!org && matches.some((d) => d.data().org === org && d.data().viewScope === 'org');
  const debtorIds = matches.map((d) => d.id);
  const allDebts = debtsSnap.docs.map((d) => d.data());
  const myDebts = isOrgViewer
    ? allDebts.filter((d) => d.org === org && !d.paid)
    : allDebts.filter((d) => debtorIds.includes(d.debtorId) && !d.paid);
  if (myDebts.length) {
    const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
    text += `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b> (${myDebts.length} ta yozuv)`;
  } else {
    text += `Hozircha faol qarzingiz yo'q. 👍`;
  }
  text += `\n\n📱 Qarzingizni istalgan vaqt to'liq (nima uchun qarzdorligingiz bilan birga) ko'rish uchun pastdagi "Mini-ilovani ochish" tugmasidan foydalaning.`;
  await sendMessage(token, chatId, text, { reply_markup: kb || { remove_keyboard: true } });
}

async function handleCustomerContact(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  const key = phoneKey(phone);
  if (!key) { await sendMessage(token, chatId, "Telefon raqami o'qilmadi, qaytadan urinib ko'ring."); return; }
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => phoneKey(d.data().phone) === key);
  if (!matches.length) {
    await sendMessage(token, chatId, "Bu raqam bo'yicha do'konda qarz yozuvi topilmadi. Agar bu xato bo'lsa, do'kon administratoriga murojaat qiling.", { reply_markup: { remove_keyboard: true } });
    return;
  }
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb);
}

async function tryLinkCustomerByUsername(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}

// Telegram username bo'lmasa ham (yoki mos kelmasa) ishlaydigan ikkinchi
// avtomatik usul: admin qarzdorni ro'yxatga qo'shayotganda uning haqiqiy
// Telegram ID'sini (raqam) kiritgan bo'lsa, shu orqali ham hech qanday
// tugmasiz avtomatik tanib olamiz — chunki Telegram ID har doim, hatto
// username bo'lmasa ham, har bir xabarda botga avtomatik keladi.
async function tryLinkCustomerByTelegramId(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const idKey = String((msg.from && msg.from.id) || '').trim();
  if (!idKey) return false;
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => String(d.data().telegramUserId || '').trim() === idKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}

// Hech qanday moslik topilmasa — tugma taklif qilish o'rniga, shaxsning
// o'z username/ID'sini ko'rsatib, buni administratorga berishini so'raymiz
// (administrator shu ma'lumot bilan Mini-ilovada qarzdorni ro'yxatga oladi).
async function sendNotRecognizedNotice(token, msg, kb) {
  const chatId = msg.chat.id;
  const uname = msg.from && msg.from.username;
  let text = `👋 Siz hali do'kon ro'yxatida topilmadingiz.\n\nAdministratorga quyidagi ma'lumotni bering, shunda keyingi safar (hech qanday tugmasiz) avtomatik tanilasiz:\n\n`;
  text += uname ? `• Telegram username: <code>@${esc(uname)}</code>\n` : '';
  text += `• Telegram ID: <code>${esc(chatId)}</code>`;
  await sendMessage(token, chatId, text, kb ? { reply_markup: kb } : { remove_keyboard: true });
}

// Bitta qarz uchun "nima uchun qarzdorligi" batafsil matnini quradi: tovar
// nomlari, miqdori va narxi bilan (agar shu ma'lumot saqlangan bo'lsa).
function debtDetailText(d) {
  let text = `📅 ${new Date(d.date).toLocaleDateString('uz-UZ')} — <b>${fmt(debtRemaining(d))} so'm</b>\n`;
  if (Array.isArray(d.items) && d.items.length) {
    d.items.forEach((it) => {
      text += `   • ${esc(it.productName)} — ${it.qty} ta × ${fmt(it.price)} = ${fmt(it.subtotal || it.qty * it.price)} so'm\n`;
    });
  }
  if (d.note) text += `   📝 Izoh: ${esc(d.note)}\n`;
  return text;
}

async function handleCustomerMyDebts(db, token, chatId) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) { await sendMessage(token, chatId, "Siz hali ro'yxatdan o'tmagansiz. /start yozib qayta urinib ko'ring."); return; }
  const debtorDocs = debtorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const org = debtorDocs.find((d) => d.org)?.org || '';
  const isOrgViewer = !!org && debtorDocs.some((d) => d.org === org && d.viewScope === 'org');
  // TEZLIK: butun "debts" kolleksiyasini o'qish o'rniga faqat kerakli
  // qarzlarnigina to'g'ridan-to'g'ri so'raymiz (do'kon kattalashganda ham tez ishlaydi).
  let allDebts;
  if (isOrgViewer) {
    const snap = await db.collection('debts').where('org', '==', org).where('paid', '==', false).get();
    allDebts = snap.docs.map((d) => d.data());
  } else {
    const ids = debtorDocs.map((x) => x.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    const snaps = await Promise.all(chunks.map((c) => db.collection('debts').where('debtorId', 'in', c).where('paid', '==', false).get()));
    allDebts = snaps.flatMap((s) => s.docs.map((d) => d.data()));
  }
  const myDebts = allDebts;
  if (!myDebts.length) { await sendMessage(token, chatId, "Faol qarzingiz yo'q. 👍"); return; }
  const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
  let text = `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b>\n\n`;
  myDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10).forEach((d) => {
    text += (isOrgViewer ? `👤 ${esc(d.debtorName || '')}\n` : '') + debtDetailText(d) + '\n';
  });
  text += `\n📱 Batafsil ko'rish uchun "Mini-ilovani ochish" tugmasidan foydalaning.`;
  await sendMessage(token, chatId, text);
}

async function handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr, kb, req) {
  const shopName = (await settingsRef.get()).data()?.shopName || "Do'kon";

  if (cmd === '/yordam' || cmd === '/start' || cmd === '/help') return sendMessage(token, chatId, helpText(true), kb ? { reply_markup: kb } : undefined);

  if (cmd === '/qarzlar') {
    const debtsSnap = await db.collection('debts').get();
    const active = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid).sort((a, b) => debtRemaining(b) - debtRemaining(a)).slice(0, 15);
    if (!active.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q.");
    let text = `📋 <b>Faol qarzlar</b> (eng kattadan)\n\n`;
    active.forEach((d) => { text += `• ${esc(d.debtorName || d.org || '?')} — ${fmt(debtRemaining(d))} so'm\n  ID: <code>${esc(d.id)}</code>\n`; });
    text += `\nTo'lov qo'shish: <code>/tolov ID summa</code>`;
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/qarz') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Qidiruv uchun ism yoki telefon kiriting: /qarz Aziz");
    const debtsSnap = await db.collection('debts').get();
    const found = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid && ((d.debtorName || '').toLowerCase().includes(q) || (d.org || '').toLowerCase().includes(q) || (d.phone || '').includes(q)));
    if (!found.length) return sendMessage(token, chatId, "Hech narsa topilmadi.");
    const total = found.reduce((a, d) => a + debtRemaining(d), 0);
    let text = `🔎 "${esc(argStr.trim())}" bo'yicha: <b>${fmt(total)} so'm</b>\n\n`;
    found.slice(0, 15).forEach((d) => { text += `• ${new Date(d.date).toLocaleDateString('uz-UZ')} — ${fmt(debtRemaining(d))} so'm (ID: <code>${esc(d.id)}</code>)\n`; });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/tolov') {
    const parts = argStr.trim().split(/\s+/);
    const idPart = parts[0];
    const amount = parseFloat(parts[1]);
    if (!idPart || isNaN(amount) || amount <= 0) return sendMessage(token, chatId, "Foydalanish: /tolov ID summa\nMasalan: /tolov ab12cd 50000");
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
    const patch = { paidAmount: admin.firestore.FieldValue.increment(applied), payments: admin.firestore.FieldValue.arrayUnion(payment) };
    if (isFullyPaid) { patch.paid = true; patch.paidDate = payment.date; }
    await debtDoc.ref.update(patch);
    await sendMessage(token, chatId, `✅ ${fmt(applied)} so'm to'lov qabul qilindi: ${esc(d.debtorName || d.org || '')}${isFullyPaid ? '\n🎉 Qarz to\'liq yopildi!' : `\nQoldiq: ${fmt(remaining - applied)} so'm`}`);
    if (d.debtorId) {
      const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
      const cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
      if (cid) await sendMessage(token, cid, `💵 <b>${esc(shopName)}</b>\n\nSizning ${fmt(applied)} so'm to'lovingiz qabul qilindi.${isFullyPaid ? "\n🎉 Qarzingiz to'liq yopildi!" : `\nQolgan qarz: ${fmt(remaining - applied)} so'm`}`);
    }
    return;
  }

  if (cmd === '/qarz_qoshish') {
    const parts = argStr.split(';').map((s) => s.trim());
    const [name, phone, amountStr, note] = parts;
    const amount = parseFloat(amountStr);
    if (!name || isNaN(amount) || amount <= 0) return sendMessage(token, chatId, "Foydalanish: /qarz_qoshish Ism; Telefon; Summa; Izoh\nMasalan: /qarz_qoshish Aziz Karimov; +998901234567; 50000; noutbuk narxi");
    const now = new Date().toISOString();
    const debtorsSnap = await db.collection('debtors').get();
    const debtor = debtorsSnap.docs.find((d) => d.data().name === name && !d.data().org);
    const debtorId = debtor ? debtor.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!debtor) await db.collection('debtors').doc(debtorId).set({ id: debtorId, name, org: '', phone: phone || '', login: '', password: '', createdAt: now });
    const debtId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const debt = { id: debtId, debtorId, debtorName: name, org: '', phone: phone || '', items: [], total: amount, paid: false, paidDate: null, date: now, note: note || 'Telegram bot orqali qo\'shildi', seller: 'Telegram admin', type: 'person' };
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
    return sendMessage(token, chatId, `📊 <b>Bugungi hisobot</b> — ${esc(shopName)}\n\n🧾 Savdolar: ${todaySales.length} ta\n💰 Tushum: ${fmt(revenue)} so'm\n📈 Foyda: ${fmt(profit)} so'm`);
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
    found.slice(0, 15).forEach((p) => { text += `• ${esc(p.name)} — ${fmt(p.price)} so'm, qoldiq: ${p.stock} ta\n`; });
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
    if (found.length > 1) return sendMessage(token, chatId, `Bir nechta tovar topildi, aniqroq nom kiriting:\n${found.slice(0, 10).map((d) => '• ' + esc(d.data().name)).join('\n')}`);
    await found[0].ref.update({ price: newPrice });
    return sendMessage(token, chatId, `✅ "${esc(found[0].data().name)}" narxi ${fmt(newPrice)} so'mga yangilandi.`);
  }

  if (cmd === '/adminlar') {
    if (!admins.length) return sendMessage(token, chatId, "Hali admin qo'shilmagan.");
    let text = `👤 <b>Adminlar</b>\n\n`;
    admins.forEach((a) => {
      if (a.chatId) text += `• ✅ ${esc(a.name || 'Admin')} — Chat ID: <code>${esc(a.chatId)}</code>\n`;
      else { const via = a.username ? `@${esc(a.username)}` : a.phone ? esc(a.phone) : '—'; text += `• ⏳ ${esc(a.name || 'Admin')} — kutmoqda (${via})\n`; }
    });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/admin_qoshish') {
    const parts = argStr.trim().split(/\s+/);
    const idArg = parts[0];
    const name = parts.slice(1).join(' ') || 'Admin';
    if (!idArg) return sendMessage(token, chatId, "Foydalanish:\n/admin_qoshish 123456789 Ism — Chat ID bilan\n/admin_qoshish +998901234567 Ism — telefon raqami bilan\n/admin_qoshish @username Ism — username bilan");
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
      await setAdminMenuButton(token, newAdmin.chatId, req).catch(() => {});
      await sendMessage(token, newAdmin.chatId, `👋 Siz "${esc(shopName)}" do'konining Telegram admini etib tayinlandingiz. /yordam yozib buyruqlar ro'yxatini ko'ring.`).catch(() => {});
    } else {
      await sendMessage(token, chatId, `✅ ${esc(name)} "kutayotgan admin" sifatida qo'shildi.\nU botga birinchi marta yozganda (yoki telefon raqamini yuborganda) avtomatik faollashadi.`);
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

// Bitta kelgan update'ni (Telegram webhook'dan) qayta ishlaydi.
// Eski polling (telegram-bot.js) dagi for-loop tanasi bilan bir xil mantiq —
// farqi shu yerda faqat BITTA update keladi, offset/state boshqarish shart emas.
async function processUpdate(db, token, settingsRef, admins, upd, req) {
  const msg = upd.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  let isAdmin = isAdminChat(admins, chatId);
  const kbAdmin = miniAppKeyboard(req, true);
  const kbDebtor = miniAppKeyboard(req, false);
  const kb = isAdmin ? kbAdmin : kbDebtor;

  if (!isAdmin && msg.from && msg.from.username) {
    const idx = findPendingAdminIndex(admins, { username: msg.from.username });
    if (idx !== -1) {
      const name = admins[idx].name || 'Admin';
      await linkPendingAdmin(settingsRef, admins, idx, chatId);
      await setAdminMenuButton(token, chatId, req);
      await sendMessage(token, chatId, `✅ Xush kelibsiz, <b>${esc(name)}</b>! Siz admin sifatida tanildingiz va endi botni to'liq boshqarishingiz mumkin.\n\n` + helpText(true), kbAdmin ? { reply_markup: kbAdmin } : undefined);
      return;
    }
  }

  // Eslatma: telefon-tugmasi (request_contact) endi hech qayerda
  // ko'rsatilmaydi. Agar shunga qaramay kimdir kontakt yuborsa (masalan,
  // eski xabar tugmasidan), moslik bo'lsa baribir ishlaydi — lekin bu
  // endi asosiy oqim emas.
  if (msg.contact) {
    const linkedAsAdmin = await tryLinkAdminByContact(token, settingsRef, admins, msg, kbAdmin);
    if (linkedAsAdmin) { await setAdminMenuButton(token, chatId, req); return; }
    await handleCustomerContact(db, token, msg, kbDebtor);
    return;
  }

  // MUHIM TUZATISH: avval faqat "/start" yozilganda tekshirilardi — shu
  // sabab admin qarzdorni ro'yxatga qo'shsa ham, odam botga /start o'rniga
  // boshqa narsa ("salom" va h.k.) yozsa, hech qachon avtomatik tanib
  // olinmasdi. Endi bu tekshiruv ADMIN BO'LMAGAN va hali ulanmagan har bir
  // kishining BIRINCHI xabarida (matn turidan qat'i nazar) ishlaydi.
  // Faqat HALI ULANMAGAN chatlar uchun urinamiz — aks holda allaqachon
  // ro'yxatdan o'tgan qarzdor har safar yozganda qayta-qayta "xush
  // kelibsiz" xabarini olib, boshqa hech qanday buyruqqa javob ololmay
  // qolardi.
  let isKnownDebtor = false;
  if (!isAdmin) {
    const alreadyLinkedSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).limit(1).get();
    isKnownDebtor = !alreadyLinkedSnap.empty;
    if (!isKnownDebtor) {
      const linkedByUsername = await tryLinkCustomerByUsername(db, token, msg, kbDebtor);
      if (linkedByUsername) return;
      const linkedById = await tryLinkCustomerByTelegramId(db, token, msg, kbDebtor);
      if (linkedById) return;
    }
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start') {
    if (!isAdmin) {
      // Avvaldan ulangan (telegramChatId saqlangan) bo'lsa oddiy salomlashuv,
      // aks holda administratorga berish uchun ID/username ko'rsatiladi.
      if (isKnownDebtor) {
        await sendMessage(token, chatId, helpText(false), { reply_markup: kbDebtor || { remove_keyboard: true } });
        return;
      }
      await sendNotRecognizedNotice(token, msg, kbDebtor);
      return;
    }
    await setAdminMenuButton(token, chatId, req);
    await sendMessage(token, chatId, helpText(isAdmin), kbAdmin ? { reply_markup: kbAdmin } : undefined);
    return;
  }
  if (text === '/qarzim' && !isAdmin) { await handleCustomerMyDebts(db, token, chatId); return; }
  if (!isAdmin && !isKnownDebtor && !text.startsWith('/')) {
    // Hali tanilmagan (ro'yxatdan o'tmagan) kishi /start dan boshqa narsa
    // yozdi — umumiy yordam matni o'rniga, uni tanib olish uchun kerakli
    // ID/username ma'lumotini yana bir bor eslatib qo'yamiz.
    await sendNotRecognizedNotice(token, msg, kbDebtor);
    return;
  }
  if (text === '/ilova' || text === '/app') {
    if (!kb) { await sendMessage(token, chatId, "Mini-ilova manzili aniqlanmadi."); return; }
    await sendMessage(token, chatId, isAdmin ? "🖥 Quyidagi tugma orqali boshqaruv panelini oching:" : "📱 Quyidagi tugma orqali ilovani oching:", { reply_markup: kb });
    return;
  }

  if (text.startsWith('/')) {
    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
    const argStr = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);
    if (!isAdmin) { await sendMessage(token, chatId, "Bu buyruq faqat do'kon adminlari uchun. /start yozib ro'yxatdan o'ting yoki /qarzim orqali qarzingizni ko'ring."); return; }
    await handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr, kb, req);
    return;
  }
  await sendMessage(token, chatId, helpText(isAdmin));
}

module.exports = async (req, res) => {
  // Faqat Telegram'dan (to'g'ri "maxfiy token" header bilan) kelgan so'rovlarni
  // qabul qilamiz - boshqa hech kim bu manzilni chaqirib, botni boshqara olmasin.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== expectedSecret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  if (req.method !== 'POST') { res.status(200).json({ ok: true, info: 'Telegram webhook is up' }); return; }

  try {
    const db = getDb();
    const settingsRef = db.collection('dokon').doc('settings');
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) { res.status(200).json({ ok: true }); return; }
    const s = settingsSnap.data();
    const token = (s.telegramBotToken || '').trim();
    if (!token) { res.status(200).json({ ok: true }); return; }
    const admins = Array.isArray(s.telegramAdmins) ? s.telegramAdmins : [];

    const upd = req.body;
    await processUpdate(db, token, settingsRef, admins, upd, req);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook xatolik:', e);
    // Telegram'ga 200 qaytaramiz - aks holda u qayta-qayta shu xato bergan
    // update'ni takror yuborishga urinaveradi. Xato konsolga (Vercel loglariga) yoziladi.
    res.status(200).json({ ok: false, error: String(e) });
  }
};
