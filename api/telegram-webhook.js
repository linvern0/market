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
// Inline tugma bosilganda Telegram "soatcha" belgisini yo'qotish uchun
// javob berish shart (aks holda foydalanuvchi tugmasi "osilib qoladi").
async function answerCallbackQuery(token, callbackQueryId, text, showAlert) {
  return tgCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || undefined, show_alert: !!showAlert });
}
// Xabar matnini (masalan /qarzlar ro'yxatini) joyida, qayta yubormasdan
// yangilash uchun — "✅ to'landi" bosilgach ro'yxat darhol yangilanadi.
async function editMessageText(token, chatId, messageId, text, extra) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (extra) Object.assign(params, extra);
  return tgCall(token, 'editMessageText', params);
}
// CSV/matn faylni hujjat sifatida yuborish (masalan /export). Telegram
// sendDocument multipart/form-data talab qiladi, shuning uchun tgCall
// (JSON) o'rniga to'g'ridan-to'g'ri FormData ishlatamiz. Node 18+ da
// global FormData/Blob mavjud.
async function sendDocument(token, chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/csv;charset=utf-8' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) console.error(`Fayl yuborishda xatolik (chat_id=${chatId}):`, data.description || data);
  return data;
}
// Botning "/" tugmasi bosilganda chiqadigan buyruqlar ro'yxati — har bir
// chat (admin/qarzdor) uchun ALOHIDA sozlanadi, shunda odam tezroq va
// xatosiz buyruq tanlay oladi (yozib xato qilmaydi).
async function setCommandsForChat(token, chatId, isAdmin) {
  const adminCommands = [
    { command: 'ilova', description: "Boshqaruv panelini ochish" },
    { command: 'qarzlar', description: 'Faol qarzlar ro\'yxati' },
    { command: 'qarz', description: 'Mijoz bo\'yicha qarz qidirish' },
    { command: 'tolov', description: 'Qarzga to\'lov qo\'shish' },
    { command: 'qarz_qoshish', description: 'Yangi qarz yozish' },
    { command: 'top', description: 'Eng katta qarzdorlar' },
    { command: 'statistika', description: 'Bugungi savdo hisoboti' },
    { command: 'haftalik', description: 'Haftalik hisobot' },
    { command: 'oylik', description: 'Oylik hisobot' },
    { command: 'ombor', description: "Kam qolgan/tugagan tovarlar" },
    { command: 'mahsulot', description: 'Tovar narxi va qoldig\'i' },
    { command: 'tovar_narx', description: 'Tovar narxini yangilash' },
    { command: 'eslatma', description: 'Bitta mijozga qo\'lda eslatma' },
    { command: 'broadcast', description: 'Barcha mijozlarga xabar' },
    { command: 'export', description: 'Faol qarzlarni CSV qilib olish' },
    { command: 'adminlar', description: 'Admin ro\'yxati' },
    { command: 'yordam', description: 'Yordam' },
  ];
  const debtorCommands = [
    { command: 'qarzim', description: "Joriy qarzim (tashkilot bo'lsa — barcha xodimlar bo'yicha)" },
    { command: 'tarix', description: "To'lovlar tarixim" },
    { command: 'ballarim', description: "Sodiqlik dasturi ball holatim" },
    { command: 'ilova', description: 'Mini-ilovada batafsil ko\'rish' },
    { command: 'yordam', description: 'Yordam' },
  ];
  try {
    await tgCall(token, 'setMyCommands', {
      commands: isAdmin ? adminCommands : debtorCommands,
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (e) { console.error('setMyCommands xatolik:', e); }
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
async function setAdminMenuButton(token, chatId, req) { return setMenuButtonFor(token, chatId, req, true); }
// Endi debtor (qarzdor) uchun ham xuddi shunday DOIMIY menyu tugmasi
// o'rnatiladi (avval faqat admin uchun bor edi — shu sabab qarzdor
// tomonida menyu "yetarli emas" ko'rinardi). Debtor uchun tugma
// index.html (to'liq boshqaruv paneli) emas, balki yengil miniapp.html
// ga olib boradi.
async function setMenuButtonFor(token, chatId, req, isAdmin) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return;
  const file = isAdmin ? 'index.html' : 'miniapp.html';
  const text = isAdmin ? 'Boshqaruv paneli' : 'Mening qarzim';
  const url = `https://${host}/${file}`;
  try {
    await tgCall(token, 'setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text, web_app: { url } },
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
      `/haftalik — oxirgi 7 kunlik hisobot\n` +
      `/oylik — joriy oy hisoboti\n` +
      `/top — eng katta 10 ta qarzdor (tezkor to'lov tugmasi bilan)\n` +
      `/ombor — kam qolgan/tugagan tovarlar\n` +
      `/mahsulot &lt;nom&gt; — tovar narxi va qoldig'ini ko'rish\n` +
      `/tovar_narx &lt;nom&gt; &lt;yangi narx&gt; — tovar narxini yangilash\n` +
      `/eslatma &lt;ism yoki telefon&gt; — bitta mijozga qo'lda eslatma yuborish\n` +
      `/broadcast &lt;matn&gt; — bog'langan barcha mijozlarga xabar yuborish\n` +
      `/export — faol qarzlar ro'yxatini CSV fayl qilib olish\n` +
      `/adminlar — admin ro'yxati\n` +
      `/admin_qoshish &lt;chatId&gt; &lt;Ism&gt; — yangi admin qo'shish\n` +
      `/admin_ochirish &lt;chatId&gt; — adminni o'chirish\n\n` +
      `💡 /qarzlar va /qarz natijalarida endi har bir qarz ostida ` +
      `"✅ To'liq to'landi" tugmasi bor — bosilsa, qo'lda summa yozmasdan ` +
      `bir zumda to'liq yopiladi.`;
  } else {
    t += `Bu bot orqali qarzingiz va to'lovlaringiz haqida xabar olasiz.\n\n` +
      `✅ Hech qanday tugma bosish shart emas — do'kon administratori sizni ` +
      `Telegram username yoki Telegram ID orqali oldindan ro'yxatga qo'shgan bo'lsa, ` +
      `siz shunchaki shu botga <b>/start</b> yozishingiz bilan avtomatik tanilasiz.\n\n` +
      `/qarzim — joriy qarzingizni ko'rish (agar tashkilot vakili bo'lsangiz — ` +
      `tashkilotdagi HAR BIR xodimning qarzi alohida-alohida, batafsil ko'rsatiladi)\n` +
      `/tarix — so'nggi to'lovlaringiz tarixi\n` +
      `/ballarim — sodiqlik dasturi ball va chegirma holatingiz (agar ulangan bo'lsangiz)\n` +
      `/ilova — Mini-ilovada qarzingizni to'liq (grafik, tarix, har bir qarz nima uchunligi bilan) ko'rish\n\n` +
      `📌 Pastdagi (chap pastki burchakdagi) "Mening qarzim" menyu tugmasi orqali ham istalgan payt Mini-ilovani ochishingiz mumkin.`;
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
  await setCommandsForChat(token, chatId, true).catch(() => {});
  await sendMessage(token, chatId,
    `✅ Xush kelibsiz, <b>${esc(name)}</b>! Siz admin sifatida tanildingiz va endi botni to'liq boshqarishingiz mumkin.\n\n` + helpText(true),
    { reply_markup: kb || { remove_keyboard: true } });
  return true;
}

async function sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req) {
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
  await setCommandsForChat(token, chatId, false).catch(() => {});
  if (req) await setMenuButtonFor(token, chatId, req, false).catch(() => {});
  await sendMessage(token, chatId, text, { reply_markup: kb || { remove_keyboard: true } });
}

async function handleCustomerContact(db, token, msg, kb, req) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  const key = phoneKey(phone);
  if (!key) { await sendMessage(token, chatId, "Telefon raqami o'qilmadi, qaytadan urinib ko'ring."); return true; }
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => phoneKey(d.data().phone) === key);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
  return true;
}

async function tryLinkCustomerByUsername(db, token, msg, kb, req) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
  return true;
}

// Telegram username bo'lmasa ham (yoki mos kelmasa) ishlaydigan ikkinchi
// avtomatik usul: admin qarzdorni ro'yxatga qo'shayotganda uning haqiqiy
// Telegram ID'sini (raqam) kiritgan bo'lsa, shu orqali ham hech qanday
// tugmasiz avtomatik tanib olamiz — chunki Telegram ID har doim, hatto
// username bo'lmasa ham, har bir xabarda botga avtomatik keladi.
async function tryLinkCustomerByTelegramId(db, token, msg, kb, req) {
  const chatId = msg.chat.id;
  const idKey = String((msg.from && msg.from.id) || '').trim();
  if (!idKey) return false;
  const debtorsSnap = await db.collection('debtors').get();
  const matches = debtorsSnap.docs.filter((d) => String(d.data().telegramUserId || '').trim() === idKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
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

// ============ YANGI: MIJOZLAR (SODIQLIK DASTURI) BOTGA BIRIKTIRISH ============
// "debtors" (qarzdorlar) bilan bir xil mantiq, lekin alohida "customers"
// (ball/chegirma) kolleksiyasi uchun. Bir kishi ham qarzdor, ham sodiqlik
// mijozi bo'lishi mumkin — ikkisi mustaqil ishlaydi.
function customerTierName(totalSpent) {
  const v = totalSpent || 0;
  if (v >= 2000000) return '🥇 Oltin';
  if (v >= 500000) return '🥈 Kumush';
  return '🥉 Bronza';
}
async function sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb) {
  const batch = db.batch();
  matches.forEach((c) => batch.set(c.ref, { telegramChatId: String(chatId) }, { merge: true }));
  await batch.commit();
  const c = matches[0].data();
  const text = `✅ Ro'yxatdan o'tdingiz: <b>${esc(c.name)}</b>\n\n` +
    `🏆 Daraja: ${customerTierName(c.totalSpent)}\n` +
    `⭐ Ball: <b>${c.points || 0}</b>\n` +
    `💳 Jami xarid: <b>${fmt(c.totalSpent || 0)} so'm</b>\n\n` +
    `Ball holatingizni istalgan vaqt /ballarim buyrug'i orqali ko'rishingiz mumkin.`;
  await sendMessage(token, chatId, text, { reply_markup: kb || { remove_keyboard: true } });
}
async function tryLinkLoyaltyCustomerByUsername(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const customersSnap = await db.collection('customers').get();
  const matches = customersSnap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}
async function tryLinkLoyaltyCustomerByTelegramId(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const idKey = String((msg.from && msg.from.id) || '').trim();
  if (!idKey) return false;
  const customersSnap = await db.collection('customers').get();
  const matches = customersSnap.docs.filter((d) => String(d.data().telegramUserId || '').trim() === idKey);
  if (!matches.length) return false;
  await sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}
async function tryLinkLoyaltyCustomerByContact(db, token, msg, kb) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  const key = phoneKey(phone);
  if (!key) return false;
  const customersSnap = await db.collection('customers').get();
  const matches = customersSnap.docs.filter((d) => phoneKey(d.data().phone) === key);
  if (!matches.length) return false;
  await sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}
async function handleLoyaltyPoints(db, token, chatId) {
  const customersSnap = await db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get();
  if (customersSnap.empty) { await sendMessage(token, chatId, "Siz sodiqlik dasturiga hali ulanmagansiz. Do'kon administratoridan ulashini so'rang, keyin /start yozing."); return; }
  const c = customersSnap.docs[0].data();
  const text = `🏆 Daraja: ${customerTierName(c.totalSpent)}\n` +
    `⭐ Ball: <b>${c.points || 0}</b>\n` +
    `💳 Jami xarid: <b>${fmt(c.totalSpent || 0)} so'm</b> (${c.purchaseCount || 0} marta)\n` +
    (c.points >= 100 ? `\n🎁 ${Math.floor(c.points / 100) * 100} ballni ${fmt(Math.floor(c.points / 100) * 10000)} so'm chegirmaga almashtirishingiz mumkin — do'konda aytsangiz bo'ldi.` : `\nHar 10,000 so'm xariddan 1 ball, 100 ball = 10,000 so'm chegirma.`);
  await sendMessage(token, chatId, text);
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
  if (!myDebts.length) {
    await sendMessage(token, chatId, isOrgViewer ? `✅ "${esc(org)}" tashkilotining faol qarzi yo'q. 👍` : "Faol qarzingiz yo'q. 👍");
    return;
  }
  const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
  let text;
  if (isOrgViewer) {
    // Tashkilot vakili: avval HAR BIR xodim bo'yicha alohida yig'indi
    // (mini-ilovadagi "byPerson" bilan bir xil mantiq), keyin so'nggi
    // yozuvlar batafsil (nima uchun, qaysi tovar) ko'rsatiladi.
    const byPerson = {};
    myDebts.forEach((d) => {
      const key = d.debtorName || "Noma'lum";
      if (!byPerson[key]) byPerson[key] = { name: key, total: 0, count: 0 };
      byPerson[key].total += debtRemaining(d);
      byPerson[key].count += 1;
    });
    const sortedPeople = Object.values(byPerson).sort((a, b) => b.total - a.total);
    text = `🏢 <b>${esc(org)}</b> — tashkilot umumiy qarzi: <b>${fmt(total)} so'm</b>\n\n`;
    text += `👥 <b>Xodimlar bo'yicha taqsimot</b> (${sortedPeople.length} kishi):\n`;
    sortedPeople.forEach((p) => { text += `• ${esc(p.name)} — <b>${fmt(p.total)} so'm</b> (${p.count} ta yozuv)\n`; });
    text += `\n📝 <b>So'nggi yozuvlar (batafsil):</b>\n\n`;
    myDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8).forEach((d) => {
      text += `👤 ${esc(d.debtorName || '')}\n` + debtDetailText(d) + '\n';
    });
  } else {
    text = `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b>\n\n`;
    myDebts.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10).forEach((d) => {
      text += debtDetailText(d) + '\n';
    });
  }
  text += `\n📱 Batafsil (jadval, grafik, to'lovlar tarixi bilan) ko'rish uchun "Mening qarzim" tugmasidan (Mini-ilova) foydalaning.`;
  await sendMessage(token, chatId, text);
}

// Tashkilot vakili yoki oddiy mijoz — so'nggi to'lovlar tarixini
// ko'rsatadi (mini-ilovadagi "payments" bilan bir xil manba).
async function handleCustomerPaymentHistory(db, token, chatId) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) { await sendMessage(token, chatId, "Siz hali ro'yxatdan o'tmagansiz. /start yozib qayta urinib ko'ring."); return; }
  const debtorDocs = debtorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const org = debtorDocs.find((d) => d.org)?.org || '';
  const isOrgViewer = !!org && debtorDocs.some((d) => d.org === org && d.viewScope === 'org');
  let debts;
  if (isOrgViewer) {
    const snap = await db.collection('debts').where('org', '==', org).get();
    debts = snap.docs.map((d) => d.data());
  } else {
    const ids = debtorDocs.map((x) => x.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    const snaps = await Promise.all(chunks.map((c) => db.collection('debts').where('debtorId', 'in', c).get()));
    debts = snaps.flatMap((s) => s.docs.map((d) => d.data()));
  }
  const payments = debts
    .flatMap((d) => (Array.isArray(d.payments) ? d.payments.map((p) => ({ ...p, debtorName: d.debtorName || d.org })) : []))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 15);
  if (!payments.length) { await sendMessage(token, chatId, "Hali to'lov tarixi yo'q."); return; }
  let text = `🧾 <b>So'nggi to'lovlar</b>\n\n`;
  payments.forEach((p) => {
    text += `• ${new Date(p.date).toLocaleDateString('uz-UZ')} — <b>${fmt(p.amount)} so'm</b>` + (isOrgViewer ? ` (${esc(p.debtorName || '')})` : '') + `\n`;
  });
  text += `\n📱 To'liq tarix uchun Mini-ilovadan foydalaning.`;
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
    text += `\nQisman to'lov: <code>/tolov ID summa</code>\nYoki pastdagi tugma orqali bir zumda to'liq yoping:`;
    const keyboard = { inline_keyboard: active.map((d) => [{ text: `✅ ${(d.debtorName || d.org || '?').slice(0, 20)} — ${fmt(debtRemaining(d))} so'm to'landi`, callback_data: `pay_full:${d.id}` }]) };
    return sendMessage(token, chatId, text, { reply_markup: keyboard });
  }

  if (cmd === '/qarz') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Qidiruv uchun ism yoki telefon kiriting: /qarz Aziz");
    const debtsSnap = await db.collection('debts').get();
    const found = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid && ((d.debtorName || '').toLowerCase().includes(q) || (d.org || '').toLowerCase().includes(q) || (d.phone || '').includes(q)));
    if (!found.length) return sendMessage(token, chatId, "Hech narsa topilmadi.");
    const total = found.reduce((a, d) => a + debtRemaining(d), 0);
    let text = `🔎 "${esc(argStr.trim())}" bo'yicha: <b>${fmt(total)} so'm</b>\n\n`;
    const shown = found.slice(0, 15);
    shown.forEach((d) => { text += `• ${new Date(d.date).toLocaleDateString('uz-UZ')} — ${fmt(debtRemaining(d))} so'm (ID: <code>${esc(d.id)}</code>)\n`; });
    const keyboard = { inline_keyboard: shown.map((d) => [{ text: `✅ ${new Date(d.date).toLocaleDateString('uz-UZ')} — ${fmt(debtRemaining(d))} so'm to'landi`, callback_data: `pay_full:${d.id}` }]) };
    return sendMessage(token, chatId, text, { reply_markup: keyboard });
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

  if (cmd === '/statistika' || cmd === '/haftalik' || cmd === '/oylik') {
    const now = new Date();
    let fromStr, label;
    if (cmd === '/statistika') { fromStr = now.toISOString().slice(0, 10); label = 'Bugungi hisobot'; }
    else if (cmd === '/haftalik') { const from = new Date(now); from.setDate(from.getDate() - 6); fromStr = from.toISOString().slice(0, 10); label = "Oxirgi 7 kunlik hisobot"; }
    else { fromStr = now.toISOString().slice(0, 8) + '01'; label = "Joriy oy hisoboti"; }
    const salesSnap = await db.collection('sales').get();
    const periodSales = salesSnap.docs.map((d) => d.data()).filter((s) => !s.reverted && (s.date || '').slice(0, 10) >= fromStr);
    const revenue = periodSales.reduce((a, s) => a + (s.total || 0), 0);
    const profit = periodSales.reduce((a, s) => a + (s.price - (s.cost || 0)) * s.qty, 0);
    const debtsSnap = await db.collection('debts').get();
    const newDebts = debtsSnap.docs.map((d) => d.data()).filter((d) => (d.date || '').slice(0, 10) >= fromStr);
    const newDebtTotal = newDebts.reduce((a, d) => a + (d.total || 0), 0);
    return sendMessage(token, chatId, `📊 <b>${label}</b> — ${esc(shopName)}\n\n🧾 Savdolar: ${periodSales.length} ta\n💰 Tushum: ${fmt(revenue)} so'm\n📈 Foyda: ${fmt(profit)} so'm\n📝 Yangi qarzga sotish: ${newDebts.length} ta (${fmt(newDebtTotal)} so'm)`);
  }

  if (cmd === '/top') {
    const debtsSnap = await db.collection('debts').get();
    const active = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid);
    const byPerson = new Map();
    active.forEach((d) => {
      const key = d.debtorId || d.debtorName || d.org || '?';
      const cur = byPerson.get(key) || { name: d.debtorName || d.org || '?', total: 0, ids: [] };
      cur.total += debtRemaining(d);
      cur.ids.push(d.id);
      byPerson.set(key, cur);
    });
    const top = [...byPerson.values()].sort((a, b) => b.total - a.total).slice(0, 10);
    if (!top.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q.");
    let text = `🏆 <b>Eng katta 10 ta qarzdor</b>\n\n`;
    top.forEach((p, i) => { text += `${i + 1}. ${esc(p.name)} — <b>${fmt(p.total)} so'm</b> (${p.ids.length} ta yozuv)\n`; });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/eslatma') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Foydalanish: /eslatma Aziz (ism yoki telefon)");
    const debtorsSnap = await db.collection('debtors').get();
    const matches = debtorsSnap.docs.filter((d) => (d.data().name || '').toLowerCase().includes(q) || phoneKey(d.data().phone) === phoneKey(q));
    if (!matches.length) return sendMessage(token, chatId, "Bunday mijoz topilmadi.");
    if (matches.length > 1) return sendMessage(token, chatId, `Bir nechta mos keldi, aniqroq yozing:\n${matches.slice(0, 10).map((d) => '• ' + esc(d.data().name)).join('\n')}`);
    const debtor = matches[0].data();
    const cid = debtor.telegramChatId;
    if (!cid) return sendMessage(token, chatId, "Bu mijoz botga hali ulanmagan (Telegram username/ID kiritilmagan yoki hali /start yozmagan).");
    const debtsSnap = await db.collection('debts').where('debtorId', '==', matches[0].id).where('paid', '==', false).get();
    const myDebts = debtsSnap.docs.map((d) => d.data());
    const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
    if (total <= 0) return sendMessage(token, chatId, "Bu mijozning faol qarzi yo'q.");
    await sendMessage(token, cid, `🔔 <b>${esc(shopName)}</b>\n\nEslatma: sizning joriy qarzingiz — <b>${fmt(total)} so'm</b>.\nTo'lov uchun do'konga murojaat qiling. Batafsil: /qarzim`);
    return sendMessage(token, chatId, `✅ ${esc(debtor.name)}ga eslatma yuborildi (${fmt(total)} so'm).`);
  }

  if (cmd === '/broadcast') {
    const text = argStr.trim();
    if (!text) return sendMessage(token, chatId, "Foydalanish: /broadcast Xabar matni\nMasalan: /broadcast Ertaga do'kon dam olish kuni, ishlamaymiz.");
    const debtorsSnap = await db.collection('debtors').where('telegramChatId', '!=', '').get().catch(() => db.collection('debtors').get());
    const targets = [...new Set(debtorsSnap.docs.map((d) => d.data().telegramChatId).filter(Boolean))];
    if (!targets.length) return sendMessage(token, chatId, "Botga ulangan mijoz topilmadi.");
    await sendMessage(token, chatId, `⏳ ${targets.length} ta mijozga yuborilmoqda...`);
    let sent = 0;
    const CHUNK = 20;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      const results = await Promise.allSettled(chunk.map((cid) => sendMessage(token, cid, `📢 <b>${esc(shopName)}</b>\n\n${esc(text)}`)));
      sent += results.filter((r) => r.status === 'fulfilled' && r.value && r.value.ok).length;
    }
    return sendMessage(token, chatId, `✅ Xabar ${sent}/${targets.length} ta mijozga yetkazildi.`);
  }

  if (cmd === '/export') {
    const debtsSnap = await db.collection('debts').get();
    const active = debtsSnap.docs.map((d) => d.data()).filter((d) => !d.paid).sort((a, b) => debtRemaining(b) - debtRemaining(a));
    if (!active.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q, eksport qilinadigan narsa yo'q.");
    const rows = [['Ism/Tashkilot', 'Telefon', 'Sana', 'Jami', "To'langan", 'Qoldiq', 'ID']];
    active.forEach((d) => rows.push([d.debtorName || d.org || '', d.phone || '', (d.date || '').slice(0, 10), d.total || 0, d.paidAmount || 0, debtRemaining(d), d.id]));
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    await sendDocument(token, chatId, `qarzlar-${new Date().toISOString().slice(0, 10)}.csv`, csv, `📄 Faol qarzlar (${active.length} ta)`);
    return;
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
      await setCommandsForChat(token, newAdmin.chatId, true).catch(() => {});
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

// "✅ To'landi" inline tugmasi bosilganda ishlaydi (callback_query).
// Faqat admin bosgan taqdirdagina ishlaydi — boshqa hech kim (hatto o'sha
// xabarni ko'rgan bo'lsa ham) qarzni yopa olmaydi.
async function handleCallbackQuery(db, token, settingsRef, admins, cq, req) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  if (!chatId || !isAdminChat(admins, chatId)) {
    await answerCallbackQuery(token, cq.id, "Bu amal faqat admin uchun.", true);
    return;
  }
  if (!data.startsWith('pay_full:')) { await answerCallbackQuery(token, cq.id); return; }
  const debtId = data.slice('pay_full:'.length);
  const debtRef = db.collection('debts').doc(debtId);
  const debtSnap = await debtRef.get();
  if (!debtSnap.exists) { await answerCallbackQuery(token, cq.id, "Bu qarz topilmadi (o'chirilgan bo'lishi mumkin).", true); return; }
  const d = debtSnap.data();
  const remaining = debtRemaining(d);
  if (remaining <= 0) { await answerCallbackQuery(token, cq.id, "Bu qarz allaqachon to'liq to'langan."); return; }
  const shopName = (await settingsRef.get()).data()?.shopName || "Do'kon";
  const payment = { amount: remaining, date: new Date().toISOString(), note: "Telegram bot orqali (tez tugma)", by: 'Telegram admin' };
  await debtRef.update({
    paidAmount: admin.firestore.FieldValue.increment(remaining),
    payments: admin.firestore.FieldValue.arrayUnion(payment),
    paid: true,
    paidDate: payment.date,
  });
  await answerCallbackQuery(token, cq.id, `✅ ${fmt(remaining)} so'm — to'liq yopildi!`);
  if (cq.message && cq.message.text) {
    const newText = cq.message.text + `\n\n✅ <b>${esc(d.debtorName || d.org || '?')}</b> qarzi (${fmt(remaining)} so'm) hozir to'liq yopildi.`;
    await editMessageText(token, chatId, cq.message.message_id, newText).catch(() => {});
  }
  if (d.debtorId) {
    const debtorSnap = await db.collection('debtors').doc(d.debtorId).get();
    const cid = debtorSnap.exists ? debtorSnap.data().telegramChatId : null;
    if (cid) await sendMessage(token, cid, `💵 <b>${esc(shopName)}</b>\n\nSizning ${fmt(remaining)} so'm to'lovingiz qabul qilindi.\n🎉 Qarzingiz to'liq yopildi!`).catch(() => {});
  }
}

// Bitta kelgan update'ni (Telegram webhook'dan) qayta ishlaydi.
// Eski polling (telegram-bot.js) dagi for-loop tanasi bilan bir xil mantiq —
// farqi shu yerda faqat BITTA update keladi, offset/state boshqarish shart emas.
async function processUpdate(db, token, settingsRef, admins, upd, req) {
  if (upd.callback_query) { await handleCallbackQuery(db, token, settingsRef, admins, upd.callback_query, req); return; }
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
      await setCommandsForChat(token, chatId, true).catch(() => {});
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
    const linkedAsDebtor = await handleCustomerContact(db, token, msg, kbDebtor, req);
    if (linkedAsDebtor) return;
    const linkedAsLoyalty = await tryLinkLoyaltyCustomerByContact(db, token, msg, kbDebtor);
    if (linkedAsLoyalty) return;
    await sendMessage(token, chatId, "Bu raqam bo'yicha do'konda qarz yozuvi yoki sodiqlik dasturi a'zoligi topilmadi. Agar bu xato bo'lsa, do'kon administratoriga murojaat qiling.", { reply_markup: { remove_keyboard: true } });
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
  let isKnownLoyalty = false;
  if (!isAdmin) {
    const alreadyLinkedSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).limit(1).get();
    isKnownDebtor = !alreadyLinkedSnap.empty;
    const alreadyLoyaltySnap = await db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get();
    isKnownLoyalty = !alreadyLoyaltySnap.empty;
    if (!isKnownDebtor) {
      const linkedByUsername = await tryLinkCustomerByUsername(db, token, msg, kbDebtor, req);
      if (linkedByUsername) return;
      const linkedById = await tryLinkCustomerByTelegramId(db, token, msg, kbDebtor, req);
      if (linkedById) return;
    }
    if (!isKnownLoyalty) {
      const linkedLoyaltyByUsername = await tryLinkLoyaltyCustomerByUsername(db, token, msg, kbDebtor);
      if (linkedLoyaltyByUsername) return;
      const linkedLoyaltyById = await tryLinkLoyaltyCustomerByTelegramId(db, token, msg, kbDebtor);
      if (linkedLoyaltyById) return;
    }
  }
  const isKnownAny = isKnownDebtor || isKnownLoyalty;

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start') {
    if (!isAdmin) {
      // Avvaldan ulangan (telegramChatId saqlangan, qarzdor va/yoki
      // sodiqlik mijozi sifatida) bo'lsa oddiy salomlashuv, aks holda
      // administratorga berish uchun ID/username ko'rsatiladi.
      if (isKnownAny) {
        await setCommandsForChat(token, chatId, false).catch(() => {});
        await setMenuButtonFor(token, chatId, req, false).catch(() => {});
        await sendMessage(token, chatId, helpText(false), { reply_markup: kbDebtor || { remove_keyboard: true } });
        return;
      }
      await sendNotRecognizedNotice(token, msg, kbDebtor);
      return;
    }
    await setAdminMenuButton(token, chatId, req);
    await setCommandsForChat(token, chatId, true).catch(() => {});
    await sendMessage(token, chatId, helpText(isAdmin), kbAdmin ? { reply_markup: kbAdmin } : undefined);
    return;
  }
  if (text === '/qarzim' && !isAdmin) { await handleCustomerMyDebts(db, token, chatId); return; }
  if (text === '/tarix' && !isAdmin) { await handleCustomerPaymentHistory(db, token, chatId); return; }
  if (text === '/ballarim' && !isAdmin) { await handleLoyaltyPoints(db, token, chatId); return; }
  if (!isAdmin && !isKnownAny && !text.startsWith('/')) {
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
