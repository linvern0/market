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
const { computeCustomerTier, getCoinSettings, productCoinCost, isCoinEnabled } = require('./_loyalty');
// YANGI (Xavfsizlik/rollar kengaytmasi): batafsil huquqlar tekshiruvi va
// amallar jurnali — miniapp-action.js'da ishlatilgan BIR XIL modullar,
// shunda bot va Mini App bir xil qoidalar bilan ishlaydi.
const { hasPermission } = require('./_permissions');
const { logAction } = require('./_audit');

let firebaseApp = null;
function getDb() { return require('./_firebase').getDb(); }
const { getSettings, invalidateSettingsCache, getProductsSnapshot, invalidateProductsCache, getDebtorsSnapshot, invalidateDebtorsCache } = require('./_firebase');

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function phoneKey(phone) { return String(phone || '').replace(/\D/g, '').slice(-9); }
function usernameKey(u) { return String(u || '').replace(/^@/, '').trim().toLowerCase(); }
function debtRemaining(d) { const rem = (d.total || 0) - (d.paidAmount || 0); return rem > 0.5 ? rem : 0; }
// Kun vaqtiga qarab iliqroq salomlashish (Toshkent vaqti, UTC+5) — /start
// xabarini shunchaki quruq buyruqlar ro'yxati emas, biroz "jonli" qiladi.
function greetingWord() {
  const h = (new Date().getUTCHours() + 5) % 24;
  if (h >= 5 && h < 11) return 'Xayrli tong';
  if (h >= 11 && h < 17) return 'Xayrli kun';
  if (h >= 17 && h < 22) return 'Xayrli kech';
  return 'Xayrli tun';
}
// ============ YANGI: ISH VAQTI TASHQARISIDA AVTOMATIK OGOHLANTIRISH ============
// index.html > Sozlamalar > "⏰ Ish vaqti" jadvali allaqachon mavjud edi,
// lekin bot bundan bexabar edi. Admin "Ish vaqti tashqarisida mijozlarga
// avtomatik ogohlantirish" tugmasini yoqsa — /start yozgan mijoz/qarzdorga
// hozir do'kon yopiqligi va qachon ochilishi haqida qo'shimcha qator
// ko'rsatiladi. Toshkent vaqti (UTC+5) asosida hisoblanadi.
const WORK_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WORK_DAY_LABELS = { sun: 'Yakshanba', mon: 'Dushanba', tue: 'Seshanba', wed: 'Chorshanba', thu: 'Payshanba', fri: 'Juma', sat: 'Shanba' };
function outsideWorkScheduleNote(settings) {
  if (!settings || !settings.telegramAutoReplyOutsideHours || !settings.workSchedule) return '';
  const now = new Date();
  const tashkent = new Date(now.getTime() + (5 * 60 - now.getTimezoneOffset()) * 60000);
  const dayKey = WORK_DAY_KEYS[tashkent.getUTCDay()];
  const s = settings.workSchedule[dayKey];
  if (!s) return '';
  const curMin = tashkent.getUTCHours() * 60 + tashkent.getUTCMinutes();
  if (s.open) {
    const [fh, fm] = (s.from || '09:00').split(':').map(Number);
    const [th, tm] = (s.to || '20:00').split(':').map(Number);
    if (curMin >= (fh * 60 + fm) && curMin <= (th * 60 + tm)) return ''; // hozir ochiq
  }
  return `\n\n⏰ <i>Hozir do'kon ish vaqti tashqarisida (${WORK_DAY_LABELS[dayKey]}${s.open ? `, ish vaqti ${s.from}–${s.to}` : ' — dam olish kuni'}). Xabaringiz albatta ko'rib chiqiladi.</i>`;
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
    { command: 'menu', description: "🗂 Tugmali menyu (buyruq yozmasdan)" },
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
    { command: 'admin_rol', description: "Admin rolini o'zgartirish (owner/admin)" },
    { command: 'adminlar', description: 'Admin ro\'yxati' },
    { command: 'yordam', description: 'Yordam' },
  ];
  const debtorCommands = [
    { command: 'menu', description: "🗂 Tugmali menyu (buyruq yozmasdan)" },
    { command: 'qarzim', description: "Joriy qarzim (tashkilot bo'lsa — barcha xodimlar bo'yicha)" },
    { command: 'tarix', description: "To'lovlar tarixim" },
    { command: 'coinlarim', description: "Sodiqlik dasturi coin holatim" },
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
function miniAppKeyboard(req, isAdmin, settings) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return undefined;
  const lbl = (settings && settings.telegramButtonLabels && typeof settings.telegramButtonLabels === 'object') ? settings.telegramButtonLabels : {};
  if (!isAdmin) {
    return { inline_keyboard: [[{ text: lbl.miniapp || '📱 Mini-ilovani ochish', web_app: { url: `https://${host}/miniapp.html` } }]] };
  }
  // YANGI: mini-ilova (miniapp.html) endi TO'LIQ boshqaruv imkoniyatiga
  // ega bo'lgani uchun (sotish, qarzlar, tovarlar, hisobot, mijozlar,
  // xodimlar, sozlamalar) — admin ikkalasidan birini tanlashi mumkin:
  // kompyuter uchun to'liq panel yoki telefon uchun tezkor mini-ilova.
  return {
    inline_keyboard: [
      [{ text: '🖥 Boshqaruv panelini ochish', web_app: { url: `https://${host}/index.html` } }],
      [{ text: '📱 Mobil mini-ilova (tezkor)', web_app: { url: `https://${host}/miniapp.html` } }],
    ],
  };
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

// ============ YANGI: SOTUVCHI (XODIM) UCHUN MINI APP ============
// Ilgari Telegram bot faqat ADMIN va QARZDOR/mijozni tanirdi — oddiy
// sotuvchi (xodim) botga yozsa, "mijoz" deb ro'yxatga olinib qolardi.
// Endi sotuvchilar ham (index.html'dagi "Sotuvchilar" bo'limida Telegram
// username kiritilgan bo'lsa) tanib olinadi va ularga to'liq savdo
// panelini (index.html, seller sifatida, PIN'siz avtomatik kirish bilan)
// ochuvchi tugma beriladi.
function usernameKeyLocal(u) { return String(u || '').replace(/^@/, '').trim().toLowerCase(); }
function findSellerByChat(sellers, chatId) { return sellers.find((s) => String(s.telegramChatId || '').trim() === String(chatId).trim()); }
function findPendingSellerIndex(sellers, username) {
  const uKey = usernameKeyLocal(username);
  if (!uKey) return -1;
  return sellers.findIndex((s) => !s.telegramChatId && usernameKeyLocal(s.telegramUsername) === uKey);
}
async function linkPendingSeller(settingsRef, sellers, idx, chatId) {
  sellers[idx] = { ...sellers[idx], telegramChatId: String(chatId) };
  await settingsRef.set({ sellers }, { merge: true });
  invalidateSettingsCache();
}
function sellerAppKeyboard(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return undefined;
  const url = `https://${host}/index.html`;
  return { inline_keyboard: [[{ text: '🛒 Sotuvchi panelini ochish', web_app: { url } }]] };
}
async function setSellerMenuButton(token, chatId, req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!host) return;
  const url = `https://${host}/index.html`;
  try {
    await tgCall(token, 'setChatMenuButton', { chat_id: chatId, menu_button: { type: 'web_app', text: 'Sotuvchi paneli', web_app: { url } } });
  } catch (e) { console.error('setChatMenuButton (sotuvchi) xatolik:', e); }
}
function sellerHelpText(name) {
  return `🤖 <b>Do'kon boti</b>\n\n👋 Xush kelibsiz, <b>${esc(name || 'Sotuvchi')}</b>!\n\n` +
    `🛒 Pastdagi tugma orqali to'liq savdo panelini oching — PIN kiritmasdan, ` +
    `to'g'ridan-to'g'ri o'z hisobingiz bilan kirasiz va sotuv qila olasiz.\n\n` +
    `/ilova — panelni qayta ochish`;
}

function isAdminChat(admins, chatId) { return admins.some((a) => String(a.chatId).trim() === String(chatId).trim()); }
// ============ YANGI: ADMIN ROLLARI (owner / admin) ============
// "owner" (bosh admin) — barcha buyruqlarga, jumladan admin qo'shish/
// o'chirish va broadcast'ga ruxsati bor. "admin" (oddiy admin/sotuvchi) —
// kundalik ishlar (qarzlar, to'lov, statistika, ombor va h.k.) uchun to'liq
// ruxsatli, lekin admin boshqaruvi va ommaviy xabar yubora olmaydi. Eski
// (role maydoni saqlanmagan) adminlar orqaga moslik uchun "owner" deb
// hisoblanadi — hech kimning huquqi kutilmaganda kamaymaydi.
function adminRole(admins, chatId) {
  const a = admins.find((x) => String(x.chatId).trim() === String(chatId).trim());
  return (a && a.role) || 'owner';
}
function isOwnerChat(admins, chatId) { return adminRole(admins, chatId) === 'owner'; }
function findAdminEntry(admins, chatId) { return admins.find((a) => String(a.chatId).trim() === String(chatId).trim()); }
// YANGI: OLDIN faqat "owner/admin" ikki darajali tekshiruv bor edi (pastdagi
// OWNER_ONLY_COMMANDS). Endi har bir buyruq kerakli BATAFSIL huquq (8 tadan
// biri, api/_permissions.js) bilan bog'langan — owner har doim hammasiga
// ruxsatli, oddiy admin esa faqat unga aniq berilgan huquqlar doirasida.
// Buyruq shu ro'yxatda bo'lmasa — hech qanday alohida huquq talab qilinmaydi
// (masalan /qarzlar, /statistika, /ombor kabi faqat KO'RISH buyruqlari).
const COMMAND_PERMISSIONS = {
  '/tolov': 'manageDebts',
  '/qarz_qoshish': 'manageDebts',
  '/tovar_narx': 'manageProducts',
  '/broadcast': 'broadcast',
  '/admin_qoshish': 'manageAdmins',
  '/admin_ochirish': 'manageAdmins',
  '/admin_rol': 'manageAdmins',
  '/admin_huquq': 'manageAdmins',
};

// ============ YANGI: TELEGRAM BUYRUQLARINI ADMIN PANELDAN YOQISH/O'CHIRISH ============
// Admin index.html > "🤖 Telegram buyruqlari" oynasidan HAR BIR buyruqni
// alohida yoqib/o'chirib qo'yishi mumkin (masalan /broadcast yoki
// /export'ni butunlay o'chirib qo'yish). Sozlama settings.telegramCommandsConfig
// ({ '/buyruq': false, ... }) sifatida saqlanadi — faqat "aniq false"
// bo'lgan buyruqlar o'chirilgan hisoblanadi, shu sabab eski do'konlarda bu
// maydon umuman bo'lmasa ham HAMMA buyruq avvalgidek ishlayveradi.
// /start, /menu, /menyu, /ilova, /app kabi navigatsiya buyruqlari — botning
// o'zini "qulflab qo'ymaslik" uchun bu yerda umuman ishtirok etmaydi.
function isTelegramCommandEnabled(settings, cmd) {
  const cfg = settings && settings.telegramCommandsConfig;
  if (!cfg || typeof cfg !== 'object') return true;
  return cfg[cmd] !== false;
}

// ============ YANGI: TUGMALI (INLINE) MENYU ============
// Endi admin va mijoz buyruqlarni qo'lda yozmasdan, to'g'ridan-to'g'ri
// tugmalar orqali ham bajarishi mumkin — /menu (yoki /menyu) buyrug'i,
// shuningdek /start xabaridagi menyu shu tugmalar bilan keladi. Har bir
// tugma "cmd:/buyruq" callback_data yuboradi, handleCallbackQuery esa buni
// xuddi matn buyruq kelgandek qayta ishlaydi — mantiq ikki joyda
// takrorlanmaydi.
function adminMenuKeyboard(req) {
  const rows = [
    [{ text: '📋 Qarzlar', callback_data: 'cmd:/qarzlar' }, { text: '🗓 Muddatlar', callback_data: 'cmd:/muddatlar' }],
    [{ text: '🏆 TOP qarzdorlar', callback_data: 'cmd:/top' }],
    [{ text: '📊 Bugungi', callback_data: 'cmd:/statistika' }, { text: '📆 Haftalik', callback_data: 'cmd:/haftalik' }, { text: '🗓 Oylik', callback_data: 'cmd:/oylik' }],
    [{ text: '📦 Ombor holati', callback_data: 'cmd:/ombor' }, { text: '📄 Export (CSV)', callback_data: 'cmd:/export' }],
    [{ text: '👤 Adminlar', callback_data: 'cmd:/adminlar' }],
  ];
  const mini = miniAppKeyboard(req, true);
  if (mini) rows.push(...mini.inline_keyboard);
  return { inline_keyboard: rows };
}
function debtorMenuKeyboard(req, settings) {
  // YANGI: admin index.html > Telegram sozlamalarida menyu tugmalari
  // matnini o'zgartirgan bo'lsa — shu matnlar ishlatiladi (masalan
  // boshqa tilga yoki qisqaroq nomga moslash uchun).
  const lbl = (settings && settings.telegramButtonLabels && typeof settings.telegramButtonLabels === 'object') ? settings.telegramButtonLabels : {};
  const rows = [
    [{ text: lbl.debt || '💰 Mening qarzim', callback_data: 'cmd:/qarzim' }],
    [{ text: lbl.history || "🧾 To'lovlar tarixi", callback_data: 'cmd:/tarix' }],
  ];
  // YANGI: COIN funksiyasi o'chirilgan bo'lsa — "Coinlarim" tugmasi
  // mijoz menyusida umuman ko'rinmaydi (settings berilmagan hollarda,
  // orqaga moslik uchun, standart holat — ko'rinadi).
  if (isCoinEnabled(settings)) rows.push([{ text: lbl.coin || '🪙 Coinlarim', callback_data: 'cmd:/ballarim' }]);
  const mini = miniAppKeyboard(req, false, settings);
  if (mini) rows.push(...mini.inline_keyboard);
  return { inline_keyboard: rows };
}
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
  invalidateSettingsCache();
}
function helpText(isAdmin) {
  let t = `🤖 <b>Do'kon boti</b>\n\n`;
  if (isAdmin) {
    t += `✅ Endi deyarli hamma narsani buyruq yozmasdan, to'g'ridan-to'g'ri ` +
      `<b>boshqaruv panelida</b> qilishingiz mumkin — u veb-saytdagi (brauzerdagi) ` +
      `bilan AYNAN BIR XIL panel, faqat shu bot ichida ochiladi:\n\n` +
      `🖥 /ilova — Boshqaruv panelini ochish (qarzlar, tovarlar, sotish, hisobotlar, xarajatlar, mijozlar — hammasi shu yerda)\n` +
      `🗂 /menu — Tugmali tezkor menyu (qarzlar, statistika, ombor va h.k. — hech narsa yozmasdan, bosish bilan)\n\n` +
      `Buyruqlar ixtiyoriy, tezkor holatlar uchun hamon mavjud:\n` +
      `/qarzlar — faol (to'lanmagan) qarzlar ro'yxati\n` +
      `/muddatlar — muddati yaqinlashgan/o'tgan qarzlar ro'yxati (dueDate belgilanganlar)\n` +
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
      `/adminlar — admin ro'yxati (rollari bilan)\n` +
      `/admin_qoshish &lt;chatId/@username/tel&gt; &lt;Ism&gt; [owner] — yangi admin qo'shish 👑\n` +
      `/admin_ochirish &lt;chatId/@username/tel&gt; — adminni o'chirish 👑\n` +
      `/admin_rol &lt;chatId/@username/tel&gt; &lt;owner|admin&gt; — admin rolini o'zgartirish 👑\n` +
      `/admin_huquq &lt;chatId/@username/tel&gt; &lt;huquq&gt; &lt;yes|off&gt; — bitta admin huquqini yoqish/o'chirish 👑\n\n` +
      `🛒 <b>Sotuvchilarni ham botga ulash mumkin:</b> Boshqaruv paneli -> Sozlamalar -> ` +
      `Sotuvchilar bo'limida sotuvchining Telegram username'ini kiriting — u botga ` +
      `/start yozganda, PIN kiritmasdan avtomatik o'z hisobi bilan savdo panelini ocha oladi.\n\n` +
      `💡 /qarzlar va /qarz natijalarida endi har bir qarz ostida ` +
      `"✅ To'liq to'landi" tugmasi bor — bosilsa, qo'lda summa yozmasdan ` +
      `bir zumda to'liq yopiladi.\n\n` +
      `👑 belgili buyruqlar standart holatda faqat <b>bosh admin (owner)</b> ` +
      `uchun ishlaydi. Oddiy adminlar (sotuvchilar) kundalik buyruqlarni ` +
      `to'liq ishlata oladi, lekin bosh admin ularga aniq huquq bermagan ` +
      `bo'lsa, admin qo'shish/o'chirish va ommaviy xabar (/broadcast) kabi ` +
      `amallarni bajara olmaydi (huquqlar boshqaruv panelidagi "🔐 Adminlar ` +
      `va huquqlar" oynasidan sozlanadi).`;
  } else {
    t += `Bu bot orqali qarzingiz va to'lovlaringiz haqida xabar olasiz.\n\n` +
      `✅ Hech qanday tugma bosish shart emas — do'kon administratori sizni ` +
      `Telegram username yoki Telegram ID orqali oldindan ro'yxatga qo'shgan bo'lsa, ` +
      `siz shunchaki shu botga <b>/start</b> yozishingiz bilan avtomatik tanilasiz.\n\n` +
      `🗂 /menu — Tugmali menyu (buyruq yozmasdan, bosish bilan)\n` +
      `/qarzim — joriy qarzingizni ko'rish (agar tashkilot vakili bo'lsangiz — ` +
      `tashkilotdagi HAR BIR xodimning qarzi alohida-alohida, batafsil ko'rsatiladi)\n` +
      `/tarix — so'nggi to'lovlaringiz tarixi\n` +
      `/coinlarim — sodiqlik dasturi coin va chegirma holatingiz (agar ulangan bo'lsangiz)\n` +
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
  const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
  const names = [...new Set(matches.map((d) => d.data().name))];
  let text = `✅ Ro'yxatdan o'tdingiz: <b>${esc(names.join(', '))}</b>\n\nEndi qarz va to'lovlaringiz haqida shu yerga xabar keladi.\n\n`;
  const org = matches.find((d) => d.data().org)?.data().org || '';
  const isOrgViewer = !!org && matches.some((d) => d.data().org === org && d.data().viewScope === 'org');
  const debtorIds = matches.map((d) => d.id);
  const allDebts = debtsSnap.docs.map((d) => d.data());
  const myDebts = isOrgViewer
    ? allDebts.filter((d) => d.org === org)
    : allDebts.filter((d) => debtorIds.includes(d.debtorId));
  if (myDebts.length) {
    const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
    text += `💰 Joriy qarzingiz: <b>${fmt(total)} so'm</b> (${myDebts.length} ta yozuv)`;
  } else {
    text += `Hozircha faol qarzingiz yo'q. 👍`;
  }
  text += `\n\n📱 Qarzingizni istalgan vaqt to'liq (nima uchun qarzdorligingiz bilan birga) ko'rish uchun pastdagi tugmalardan foydalaning.`;
  await setCommandsForChat(token, chatId, false).catch(() => {});
  if (req) await setMenuButtonFor(token, chatId, req, false).catch(() => {});
  await sendMessage(token, chatId, text, { reply_markup: debtorMenuKeyboard(req) || kb || { remove_keyboard: true } });
}

async function handleCustomerContact(db, token, msg, kb, req) {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  const key = phoneKey(phone);
  if (!key) { await sendMessage(token, chatId, "Telefon raqami o'qilmadi, qaytadan urinib ko'ring."); return true; }
  const debtorsSnap = await getDebtorsSnapshot(db);
  const matches = debtorsSnap.docs.filter((d) => phoneKey(d.data().phone) === key);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
  return true;
}

async function tryLinkCustomerByUsername(db, token, msg, kb, req, debtorsSnap) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const snap = debtorsSnap || (await getDebtorsSnapshot(db));
  const matches = snap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
  return true;
}

// Telegram username bo'lmasa ham (yoki mos kelmasa) ishlaydigan ikkinchi
// avtomatik usul: admin qarzdorni ro'yxatga qo'shayotganda uning haqiqiy
// Telegram ID'sini (raqam) kiritgan bo'lsa, shu orqali ham hech qanday
// tugmasiz avtomatik tanib olamiz — chunki Telegram ID har doim, hatto
// username bo'lmasa ham, har bir xabarda botga avtomatik keladi.
async function tryLinkCustomerByTelegramId(db, token, msg, kb, req, debtorsSnap) {
  const chatId = msg.chat.id;
  const idKey = String((msg.from && msg.from.id) || '').trim();
  if (!idKey) return false;
  const snap = debtorsSnap || (await getDebtorsSnapshot(db));
  const matches = snap.docs.filter((d) => String(d.data().telegramUserId || '').trim() === idKey);
  if (!matches.length) return false;
  await sendDebtorLinkedWelcome(db, token, chatId, matches, kb, req);
  return true;
}

// ============ YANGI: OCHIQ RO'YXATDAN O'TISH (ADMINSIZ) ============
// Endi admin hech kimni qo'lda "mijoz" sifatida qo'shishi shart emas —
// botga /start bosgan HAR QANDAY kishi avtomatik ravishda "customers"
// (sodiqlik dasturi) kolleksiyasiga yoziladi va shu zahoti mijoz sifatida
// tanilib, Mini-ilovadan (tovarlar katalogi) foydalana oladi.
async function autoRegisterCustomer(db, token, msg, kb, welcomeText) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    || (from.username ? '@' + from.username : `Mijoz ${chatId}`);
  const data = {
    name,
    telegramChatId: String(chatId),
    telegramUserId: String(from.id || ''),
    telegramUsername: from.username || '',
    phone: '',
    points: 0,
    totalSpent: 0,
    purchaseCount: 0,
    autoRegistered: true,
    createdAt: new Date().toISOString(),
  };
  await db.collection('customers').add(data);
  // YANGI: admin Sozlamalar > Telegram bo'limida o'zining maxsus xush
  // kelibsiz matnini kiritgan bo'lsa, u standart matnning ustiga (nomdan
  // keyin, "ro'yxatdan o'tdingiz" xabaridan OLDIN) alohida qator sifatida
  // qo'shiladi. Bo'sh bo'lsa xatti-harakat avvalgidek qoladi.
  const customLine = (welcomeText && String(welcomeText).trim()) ? `${esc(String(welcomeText).trim())}\n\n` : '';
  const text = `👋 Xush kelibsiz, <b>${esc(name)}</b>!\n\n` + customLine +
    `✅ Siz do'konning sodiqlik dasturiga avtomatik ro'yxatdan o'tdingiz.\n\n` +
    `🏆 Daraja: ${await customerTierName(db, 0)}\n🪙 Coin: <b>0</b>\n\n` +
    `📱 Tovarlar katalogini ko'rish va o'z ma'lumotlaringizni kuzatish uchun pastdagi "Mini-ilovani ochish" tugmasidan foydalaning.\n` +
    `🪙 Coin holatingizni istalgan vaqt /coinlarim buyrug'i orqali ko'rishingiz mumkin.`;
  await setCommandsForChat(token, chatId, false).catch(() => {});
  await sendMessage(token, chatId, text, { reply_markup: kb || { remove_keyboard: true } });
  return data;
}

// ============ YANGI: MIJOZLAR (SODIQLIK DASTURI) BOTGA BIRIKTIRISH ============
// "debtors" (qarzdorlar) bilan bir xil mantiq, lekin alohida "customers"
// (ball/chegirma) kolleksiyasi uchun. Bir kishi ham qarzdor, ham sodiqlik
// mijozi bo'lishi mumkin — ikkisi mustaqil ishlaydi.
// TUZATILDI: bu funksiya ilgari Bronza/Kumush/Oltin va ularning
// chegaralarini (500,000/2,000,000) QATTIQ yozilgan holda hisoblardi —
// admin panelida ("🏆 Darajalarni sozlash") admin bu chegaralarni
// o'zgartirsa ham, bot xabarlarida ESKI daraja ko'rsatilardi. Endi
// hammasi BIR XIL manbadan (Firebase'dagi dokon/settings > loyaltyTiers,
// api/_loyalty.js orqali) hisoblanadi.
async function customerTierName(db, totalSpent, override, presetSettings) {
  const settingsData = presetSettings || await getSettings(db);
  return computeCustomerTier(totalSpent, override, settingsData).label;
}
async function sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb) {
  const batch = db.batch();
  matches.forEach((c) => batch.set(c.ref, { telegramChatId: String(chatId) }, { merge: true }));
  await batch.commit();
  const c = matches[0].data();
  const text = `✅ Ro'yxatdan o'tdingiz: <b>${esc(c.name)}</b>\n\n` +
    `🏆 Daraja: ${await customerTierName(db, c.totalSpent, c.tierOverride)}\n` +
    `🪙 Coin: <b>${c.points || 0}</b>\n` +
    `💳 Jami xarid: <b>${fmt(c.totalSpent || 0)} so'm</b>\n\n` +
    `Coin holatingizni istalgan vaqt /coinlarim buyrug'i orqali ko'rishingiz mumkin.`;
  await sendMessage(token, chatId, text, { reply_markup: kb || { remove_keyboard: true } });
}
async function tryLinkLoyaltyCustomerByUsername(db, token, msg, kb, customersSnap) {
  const chatId = msg.chat.id;
  const uKey = usernameKey(msg.from && msg.from.username);
  if (!uKey) return false;
  const snap = customersSnap || (await db.collection('customers').get());
  const matches = snap.docs.filter((d) => usernameKey(d.data().telegramUsername) === uKey);
  if (!matches.length) return false;
  await sendLoyaltyLinkedWelcome(db, token, chatId, matches, kb);
  return true;
}
async function tryLinkLoyaltyCustomerByTelegramId(db, token, msg, kb, customersSnap) {
  const chatId = msg.chat.id;
  const idKey = String((msg.from && msg.from.id) || '').trim();
  if (!idKey) return false;
  const snap = customersSnap || (await db.collection('customers').get());
  const matches = snap.docs.filter((d) => String(d.data().telegramUserId || '').trim() === idKey);
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
// ============ YANGI: BIR MARTALIK HAVOLA ORQALI BOTGA ULASH ============
// Admin (veb-panel/Mini-ilova > "Mijozlar va sodiqlik dasturi" > "Botga
// ulash") mijoz uchun noyob token yaratadi va shu token bilan
// "https://t.me/<bot>?start=cl_<token>" havolasini chiqaradi. Mijoz shu
// havolani (Telegram, SMS yoki boshqa kanal orqali) ochib botni ishga
// tushirsa — quyidagi funksiya tokenni "customers" kolleksiyasidan topib,
// o'sha mijozni DARHOL joriy chatId'ga bog'laydi (username/ID/telefon
// kiritishga hojat qolmaydi). Xavfsizlik uchun token muvaffaqiyatli
// ishlatilgach FIELD sifatida o'chirib tashlanadi — shu bilan havola
// FAQAT BIR MARTA ishlaydi, qayta ochilsa "eskirgan" deb javob beriladi.
async function handleCustomerLinkClaim(db, token, chatId, msg, req) {
  const text = (msg.text || '').trim();
  const m = /^\/start\s+cl_(.+)$/.exec(text);
  if (!m) return false;
  const linkToken = m[1].trim();
  const kb = miniAppKeyboard(req, false);
  let snap;
  try {
    snap = await db.collection('customers').where('linkToken', '==', linkToken).limit(1).get();
  } catch (e) {
    console.error('Bir martalik havolani tekshirishda xatolik:', e);
    await sendMessage(token, chatId, "⚠️ Xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return true;
  }
  if (snap.empty) {
    await sendMessage(token, chatId, "❌ Bu havola eskirgan yoki allaqachon ishlatilgan. Do'kon administratoridan yangi havola so'rang.");
    return true;
  }
  const custRef = snap.docs[0].ref;
  const from = msg.from || {};
  await custRef.set({
    telegramChatId: String(chatId),
    telegramUserId: String(from.id || ''),
    telegramUsername: from.username || snap.docs[0].data().telegramUsername || '',
    linkToken: admin.firestore.FieldValue.delete(),
    linkTokenCreatedAt: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  const freshSnap = await custRef.get();
  await setCommandsForChat(token, chatId, false).catch(() => {});
  await setMenuButtonFor(token, chatId, req, false).catch(() => {});
  await sendLoyaltyLinkedWelcome(db, token, chatId, [freshSnap], kb);
  return true;
}

// ============ YANGI: CHEKNI SKANERLAB AVTOMATIK BALL YIG'ISH ============
// Har bir chekdagi QR kod (agar Sozlamalarda bot username kiritilgan
// bo'lsa) botni "/start r_<receiptId>" deep-link orqali ochadi. Mijoz
// shunchaki QR'ni skanerlashi bilan — agar savdo paytida sotuvchi
// mijozni oldindan tanlamagan bo'lsa — xarid summasiga mos ball
// avtomatik hisobiga qo'shiladi. Bitta chek FAQAT BIR MARTA ball
// berishi mumkin (qayta skanerlashda "allaqachon olingan" ko'rsatiladi),
// shu bilan birga agar sotuvchi checkoutda mijozni allaqachon tanlagan
// bo'lsa (receiptData.pointsAwarded), bu yerda IKKINCHI marta ball
// berilmaydi.
// Chek summasiga mos umumiy ballni ("earned") chekdagi har bir tovar
// ulushiga qarab taqsimlaydi — shunda admin "qaysi mahsulotdan qancha
// ball to'plandi" degan savolga aniq javob ola oladi. Yig'indi aynan
// "earned" ga teng chiqishi uchun oxirgi tovarga qoldiq beriladi.
function splitPointsByItems(items, total, earned) {
  const list = Array.isArray(items) ? items.filter((i) => i && (i.total || 0) > 0) : [];
  if (!list.length || !total || earned <= 0) return [];
  let assigned = 0;
  const out = list.map((it, idx) => {
    let pts;
    if (idx === list.length - 1) {
      pts = earned - assigned;
    } else {
      pts = Math.round((it.total / total) * earned);
      assigned += pts;
    }
    return { name: it.name || "Noma'lum tovar", amount: it.total || 0, points: Math.max(0, pts) };
  });
  return out;
}

// ============ YANGI: TOVARGA QARAB BALL (ADMIN NAZORATI) ============
// Ilgari chek uchun ball HAR DOIM "umumiy summa / 10000" formulasi bilan
// hisoblanib, keyin tovarlar orasida SUMMASIGA QARAB (proporsional)
// taqsimlanardi — admin bironta ham tovarga alohida ball belgilay olmasdi.
// Endi: agar admin "products" bo'limida biror tovarga aniq ball (1 dona
// uchun) belgilagan bo'lsa — chekda ham AYNAN o'sha ball ishlatiladi.
// Belgilanmagan tovarlar uchun eski formulaga (narx/10000) qaytiladi.
// Chekdagi tovar nomi bo'yicha (productId chekda saqlanmaydi) moslashtiriladi.
async function computeReceiptPoints(db, items, settingsData) {
  const list = Array.isArray(items) ? items.filter((i) => i && (i.total || 0) > 0) : [];
  if (!list.length) return { earned: 0, breakdown: [] };
  let productsByName = {};
  try {
    const snap = await getProductsSnapshot(db);
    snap.docs.forEach((d) => {
      const p = d.data();
      const key = String(p.name || '').trim().toLowerCase();
      if (key) productsByName[key] = p;
    });
  } catch (e) { /* jim: mahsulotlarni o'qib bo'lmasa, eski formulaga tushamiz */ }
  // TUZATILDI: "narx/10000" nisbati endi qattiq yozilmagan — admin buni
  // sozlashlardan (necha so'mlik xariddan 1 COIN) o'zgartira oladi.
  const { earnPerAmount } = getCoinSettings(settingsData);

  let earned = 0;
  const breakdown = list.map((it) => {
    const qty = it.qty || 1;
    const prod = productsByName[String(it.name || '').trim().toLowerCase()];
    let unitPoints;
    if (prod && (prod.points || prod.points === 0)) unitPoints = Math.max(0, parseInt(prod.points, 10) || 0);
    else unitPoints = Math.floor((it.price || (it.total / qty) || 0) / earnPerAmount);
    const linePoints = Math.max(0, unitPoints * qty);
    earned += linePoints;
    return { name: it.name || "Noma'lum tovar", amount: it.total || 0, points: linePoints };
  });
  return { earned, breakdown };
}

// Mijozning "pointsByProduct" xaritasini (mahsulot nomi -> jami to'plangan
// coin) yangi taqsimot bilan qo'shib chiqadi. Admin panelida mijoz
// kartochkasida va umumiy coin hisobotida shu xaritadan foydalaniladi.
function mergePointsByProduct(existingMap, breakdown) {
  const out = Object.assign({}, existingMap || {});
  breakdown.forEach((b) => { out[b.name] = (out[b.name] || 0) + b.points; });
  return out;
}

// Chekka mos coinni (allaqachon ma'lum yoki hozirgina ro'yxatdan o'tgan)
// mijozga yozadi va tasdiq xabarini yuboradi. `customerRef`/`customerData`
// mavjud mijoz YOKI endigina yaratilgan (ism+telefon bilan) yangi mijozga
// tegishli bo'lishi mumkin — ikkala holatda ham mantiq bir xil.
async function finalizeReceiptAward(db, token, chatId, msg, req, receiptId, r, customerRef, customerData, isNewRegistration) {
  const kb = miniAppKeyboard(req, false);
  const receiptRef = db.collection('receipts').doc(receiptId);
  const total = r.total || 0;
  const settingsData = await getSettings(db);
  const { earned, breakdown } = await computeReceiptPoints(db, r.items, settingsData);
  const { redeemValuePerCoin } = getCoinSettings(settingsData);

  const newPoints = (customerData.points || 0) + earned;
  const newTotalSpent = (customerData.totalSpent || 0) + total;
  const newPurchaseCount = (customerData.purchaseCount || 0) + 1;
  const nowIso = new Date().toISOString();
  const purchaseEntry = { date: nowIso, amount: total, receiptId, pointsEarned: earned, items: breakdown };
  const purchases = [purchaseEntry, ...(Array.isArray(customerData.purchases) ? customerData.purchases : [])].slice(0, 50);
  const pointsByProduct = mergePointsByProduct(customerData.pointsByProduct, breakdown);

  try {
    await customerRef.set({
      ...customerData,
      points: newPoints,
      totalSpent: newTotalSpent,
      purchaseCount: newPurchaseCount,
      lastPurchaseAt: nowIso,
      purchases,
      pointsByProduct,
      telegramChatId: String(chatId),
      telegramUserId: String((msg.from && msg.from.id) || customerData.telegramUserId || ''),
    }, { merge: true });
    await receiptRef.set({ pointsClaimed: true, pointsClaimedBy: String(chatId), pointsClaimedAt: nowIso, pointsEarned: earned }, { merge: true });
  } catch (e) {
    console.error('Coin yozishda xatolik:', e);
    await sendMessage(token, chatId, "⚠️ Coin yozishda xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }

  await setCommandsForChat(token, chatId, false).catch(() => {});
  await setMenuButtonFor(token, chatId, req, false).catch(() => {});
  const text2 = (isNewRegistration ? `✅ <b>Ro'yxatdan muvaffaqiyatli o'tdingiz!</b>\n\n` : `🎉 <b>Chek qabul qilindi!</b>\n\n`) +
    `🧾 Xarid: <b>${fmt(total)} so'm</b>\n` +
    `🪙 Siz to'pladingiz: <b>+${earned} coin</b>\n` +
    `💳 Jami coin: <b>${newPoints}</b>\n` +
    `🏆 Daraja: ${await customerTierName(db, newTotalSpent, customerData.tierOverride, settingsData)}\n\n` +
    (newPoints >= 100
      ? `🎁 ${Math.floor(newPoints / 100) * 100} coinni ${fmt(Math.floor(newPoints / 100) * redeemValuePerCoin)} so'm chegirmaga almashtirishingiz mumkin — do'konda aytsangiz bo'ldi. Yoki mini-ilova katalogidan biror tovarni to'g'ridan-to'g'ri coinga sotib olishingiz mumkin.`
      : `Har ${fmt(getCoinSettings(settingsData).earnPerAmount)} so'm xariddan 1 coin, 100 coin = ${fmt(redeemValuePerCoin * 100)} so'm chegirma.`);
  // Mumkin bo'lsa, mini-ilova tugmasi ustiga "chekni to'liq ko'rish" tugmasi
  // ham qo'shiladi — mijoz tovarlar ro'yxatini, chek dizaynini ko'ra oladi.
  let replyMarkup = kb || debtorMenuKeyboard(req);
  try {
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    if (host) {
      const receiptUrl = `https://${host}/receipt.html?id=${encodeURIComponent(receiptId)}`;
      const extraRow = [{ text: '🧾 Chekni to\'liq ko\'rish', url: receiptUrl }];
      const baseRows = (replyMarkup && replyMarkup.inline_keyboard) ? replyMarkup.inline_keyboard : [];
      replyMarkup = { inline_keyboard: [extraRow, ...baseRows] };
    }
  } catch (e) { /* jim: tugma qo'shilmasa ham asosiy xabar baribir boradi */ }
  await sendMessage(token, chatId, text2, { reply_markup: replyMarkup });
}

// ============ YANGI: CHEKDAN RO'YXATDAN O'TISH (ISM VA TELEFON — MATN) ============
// Mijoz botga birinchi marta chek havolasidan kirsa (hali "customers"
// to'plamida yo'q), unga darhol Telegram profilidagi ism bilan avtomatik
// hisob ochish O'RNIGA — avval ISMINI, keyin TELEFON RAQAMINI oddiy matn
// ko'rinishida so'raymiz. Ikkalasi ham kiritilgandan keyingina mijoz
// ro'yxatga olinadi va chekka mos ball avtomatik yoziladi. Kutilayotgan
// holat "pendingRegistrations/<chatId>" hujjatida saqlanadi.
async function startReceiptRegistration(db, token, chatId, receiptId) {
  await db.collection('pendingRegistrations').doc(String(chatId)).set({
    step: 'name', receiptId, createdAt: new Date().toISOString(),
  });
  await sendMessage(token, chatId,
    `👋 Xush kelibsiz!\n\nBu chek uchun coin yozish va sodiqlik dasturidan foydalanish uchun avval ro'yxatdan o'tishingiz kerak.\n\n✍️ Ismingizni yozib yuboring:`);
}

// Mijoz ism/telefon savoliga matn bilan javob berayotganda ishlaydi.
// `true` qaytarsa — xabar shu yerda to'liq qayta ishlangan (boshqa hech
// qanday keyingi handler ishlamasligi kerak).
async function handlePendingRegistrationText(db, token, chatId, msg, req) {
  const pendRef = db.collection('pendingRegistrations').doc(String(chatId));
  const pendSnap = await pendRef.get();
  if (!pendSnap.exists) return false;
  const pend = pendSnap.data();
  const text = (msg.text || '').trim();
  if (!text) { await sendMessage(token, chatId, "Iltimos, matn ko'rinishida javob yozing."); return true; }

  if (pend.step === 'name') {
    if (text.length < 2 || text.startsWith('/')) {
      await sendMessage(token, chatId, "Iltimos, to'liq ismingizni oddiy matn ko'rinishida yozing (kamida 2 ta harf).");
      return true;
    }
    await pendRef.set({ step: 'phone', name: text }, { merge: true });
    await sendMessage(token, chatId, `Rahmat, <b>${esc(text)}</b>! ✅\n\n📱 Endi telefon raqamingizni yozing (masalan: +998901234567):`);
    return true;
  }

  if (pend.step === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 7) {
      await sendMessage(token, chatId, "Telefon raqami noto'g'ri ko'rinmoqda. Iltimos, to'g'ri raqam yozing (masalan: +998901234567):");
      return true;
    }
    const name = pend.name || 'Mijoz';
    const receiptId = pend.receiptId;
    await pendRef.delete();
    await completeReceiptRegistration(db, token, chatId, msg, req, receiptId, name, text);
    return true;
  }
  return false;
}

// Ism va telefon kiritilgach chaqiriladi: yangi "customers" hujjati
// yaratiladi va shu darhol (agar chek hali band bo'lmagan bo'lsa) mos
// ball yoziladi.
async function completeReceiptRegistration(db, token, chatId, msg, req, receiptId, name, phone) {
  let r;
  try {
    const receiptSnap = await db.collection('receipts').doc(receiptId).get();
    if (!receiptSnap.exists) { await sendMessage(token, chatId, "❌ Bu chek topilmadi (eskirgan yoki noto'g'ri havola bo'lishi mumkin)."); return; }
    r = receiptSnap.data();
  } catch (e) {
    console.error('Chekni o\'qishda xatolik (registratsiya):', e);
    await sendMessage(token, chatId, "⚠️ Xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return;
  }
  const customerRef = db.collection('customers').doc();
  const customerData = {
    id: customerRef.id, name, phone, points: 0, totalSpent: 0, purchaseCount: 0,
    telegramUsername: (msg.from && msg.from.username) || '',
    autoRegistered: false,
    createdAt: new Date().toISOString(),
  };
  const total = r.total || 0;
  const { earned } = await computeReceiptPoints(db, r.items);
  if (r.pointsAwarded || r.pointsClaimed || earned <= 0) {
    // Ro'yxatdan o'tish baribir yakunlanadi (mijoz endi bazada bor va
    // botga ulangan), faqat shu aniq chek uchun ball qo'shilmaydi (allaqachon
    // hisoblangan yoki xarid summasi yetarli emas).
    await customerRef.set({ ...customerData, telegramChatId: String(chatId), telegramUserId: String((msg.from && msg.from.id) || '') });
    await sendMessage(token, chatId, `✅ Ro'yxatdan o'tdingiz, <b>${esc(name)}</b>! Endi keyingi xaridlaringiz uchun coin to'play olasiz.\n🪙 Coin holatingizni /coinlarim orqali ko'rishingiz mumkin.`, { reply_markup: miniAppKeyboard(req, false) });
    return;
  }
  await finalizeReceiptAward(db, token, chatId, msg, req, receiptId, r, customerRef, customerData, true);
}

async function handleReceiptClaim(db, token, chatId, msg, req) {
  const text = (msg.text || '').trim();
  const m = /^\/start\s+r_(.+)$/.exec(text);
  if (!m) return false;
  const receiptId = m[1].trim();
  const kb = miniAppKeyboard(req, false);
  let r;
  try {
    const receiptSnap = await db.collection('receipts').doc(receiptId).get();
    if (!receiptSnap.exists) { await sendMessage(token, chatId, "❌ Bu chek topilmadi (eskirgan yoki noto'g'ri havola bo'lishi mumkin)."); return true; }
    r = receiptSnap.data();
  } catch (e) {
    console.error('Chekni o\'qishda xatolik:', e);
    await sendMessage(token, chatId, "⚠️ Xatolik yuz berdi, birozdan so'ng qayta urinib ko'ring.");
    return true;
  }

  if (r.pointsAwarded) {
    await sendMessage(token, chatId, `🧾 Bu xarid uchun coin savdo vaqtida allaqachon hisoblangan. Joriy coin holatingizni /coinlarim orqali ko'rishingiz mumkin.`, { reply_markup: kb });
    return true;
  }
  if (r.pointsClaimed) {
    let balanceLine = '';
    if (r.pointsClaimedBy) {
      const cSnap = await db.collection('customers').where('telegramChatId', '==', String(r.pointsClaimedBy)).limit(1).get();
      if (!cSnap.empty) balanceLine = `\n🪙 Joriy coin: <b>${cSnap.docs[0].data().points || 0}</b>`;
    }
    await sendMessage(token, chatId, `ℹ️ Bu chek uchun coin allaqachon hisoblangan (+${r.pointsEarned || 0} coin).${balanceLine}`, { reply_markup: kb });
    return true;
  }

  const total = r.total || 0;
  const { earned } = await computeReceiptPoints(db, r.items);
  if (earned <= 0) {
    await sendMessage(token, chatId, `🧾 Chek qabul qilindi (${fmt(total)} so'm), lekin coin berish uchun xarid summasi yetarli emas yoki bu tovarlarga coin belgilanmagan.`, { reply_markup: kb });
    return true;
  }

  // Mijozni telegramChatId bo'yicha qidiramiz. Topilsa — ball darhol
  // yoziladi. Topilmasa — endi Telegram profilidan avtomatik hisob OCHISH
  // O'RNIGA, avval ism va telefon raqamini matn orqali so'raymiz (pastga
  // qarang: startReceiptRegistration / handlePendingRegistrationText).
  const existingSnap = await db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get();
  if (existingSnap.empty) {
    await startReceiptRegistration(db, token, chatId, receiptId);
    return true;
  }
  const customerRef = existingSnap.docs[0].ref;
  const customerData = existingSnap.docs[0].data();
  await finalizeReceiptAward(db, token, chatId, msg, req, receiptId, r, customerRef, customerData, false);
  return true;
}
async function handleLoyaltyPoints(db, token, chatId, req) {
  const settingsData = await getSettings(db);
  // YANGI: COIN funksiyasi admin tomonidan o'chirilgan bo'lsa — mijozga
  // tushunarli xabar qaytariladi, ma'lumot bazasiga umuman murojaat
  // qilinmaydi.
  if (!isCoinEnabled(settingsData)) {
    await sendMessage(token, chatId, "🪙 Coin dasturi hozircha o'chirilgan. Batafsil ma'lumot uchun do'kon administratoriga murojaat qiling.", { reply_markup: debtorMenuKeyboard(req, settingsData) });
    return;
  }
  const customersSnap = await db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get();
  if (customersSnap.empty) { await sendMessage(token, chatId, "Siz sodiqlik dasturiga hali ulanmagansiz. Do'kon administratoridan ulashini so'rang, keyin /start yozing."); return; }
  const c = customersSnap.docs[0].data();
  const { earnPerAmount, redeemValuePerCoin } = getCoinSettings(settingsData);
  const text = `🏆 Daraja: ${await customerTierName(db, c.totalSpent, c.tierOverride, settingsData)}\n` +
    `🪙 Coin: <b>${c.points || 0}</b>\n` +
    `💳 Jami xarid: <b>${fmt(c.totalSpent || 0)} so'm</b> (${c.purchaseCount || 0} marta)\n` +
    (c.points >= 100 ? `\n🎁 ${Math.floor(c.points / 100) * 100} coinni ${fmt(Math.floor(c.points / 100) * redeemValuePerCoin)} so'm chegirmaga almashtirishingiz mumkin — do'konda aytsangiz bo'ldi. Yoki mini-ilova katalogidan biror tovarni to'g'ridan-to'g'ri coinga sotib olishingiz mumkin.` : `\nHar ${fmt(earnPerAmount)} so'm xariddan 1 coin, 100 coin = ${fmt(redeemValuePerCoin * 100)} so'm chegirma.`);
  await sendMessage(token, chatId, text, { reply_markup: debtorMenuKeyboard(req, settingsData) });
}

// Bitta qarz uchun "nima uchun qarzdorligi" batafsil matnini quradi: tovar
// nomlari, miqdori va narxi bilan (agar shu ma'lumot saqlangan bo'lsa).
function debtDetailText(d) {
  const remaining = debtRemaining(d);
  const paid = d.paidAmount || 0;
  let text;
  if (paid > 0) {
    // Qisman to'langan qarz — asl summa, to'langan va qoldiq alohida-alohida
    // ko'rsatiladi, shunda mijoz nima uchun aynan shu qoldiq qolganini aniq ko'radi.
    text = `📅 ${new Date(d.date).toLocaleDateString('uz-UZ')} — asl summa <b>${fmt(d.total || 0)} so'm</b>, to'langan <b>${fmt(paid)} so'm</b>, qoldiq <b>${fmt(remaining)} so'm</b>\n`;
  } else {
    text = `📅 ${new Date(d.date).toLocaleDateString('uz-UZ')} — <b>${fmt(remaining)} so'm</b>\n`;
  }
  if (Array.isArray(d.items) && d.items.length) {
    d.items.forEach((it) => {
      text += `   • ${esc(it.productName)} — ${it.qty} ta × ${fmt(it.price)} = ${fmt(it.subtotal || it.qty * it.price)} so'm\n`;
    });
  }
  if (d.note) text += `   📝 Izoh: ${esc(d.note)}\n`;
  return text;
}

async function handleCustomerMyDebts(db, token, chatId, req) {
  const debtorsSnap = await db.collection('debtors').where('telegramChatId', '==', String(chatId)).get();
  if (debtorsSnap.empty) { await sendMessage(token, chatId, "Siz hali ro'yxatdan o'tmagansiz. /start yozib qayta urinib ko'ring."); return; }
  const debtorDocs = debtorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const org = debtorDocs.find((d) => d.org)?.org || '';
  const isOrgViewer = !!org && debtorDocs.some((d) => d.org === org && d.viewScope === 'org');
  // TEZLIK: butun "debts" kolleksiyasini o'qish o'rniga faqat kerakli
  // qarzlarnigina to'g'ridan-to'g'ri so'raymiz (do'kon kattalashganda ham tez ishlaydi).
  let allDebts, allDebtsEver;
  if (isOrgViewer) {
    const [snap, snapEver] = await Promise.all([
      db.collection('debts').where('org', '==', org).where('paid', '==', false).get(),
      db.collection('debts').where('org', '==', org).get(),
    ]);
    allDebts = snap.docs.map((d) => d.data());
    allDebtsEver = snapEver.docs.map((d) => d.data());
  } else {
    const ids = debtorDocs.map((x) => x.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    const [snaps, snapsEver] = await Promise.all([
      Promise.all(chunks.map((c) => db.collection('debts').where('debtorId', 'in', c).where('paid', '==', false).get())),
      Promise.all(chunks.map((c) => db.collection('debts').where('debtorId', 'in', c).get())),
    ]);
    allDebts = snaps.flatMap((s) => s.docs.map((d) => d.data()));
    allDebtsEver = snapsEver.flatMap((s) => s.docs.map((d) => d.data()));
  }
  const myDebts = allDebts;
  // YANGI: umr bo'yi (barcha, hozir yopilgan qarzlar bilan birga) statistika —
  // mijoz shu do'kondan JAMI qancha qarzga olgani va JAMI qancha to'lagani
  // haqida ham TO'LIQ ma'lumot olishi uchun.
  const everCount = allDebtsEver.length;
  const everTotalDebt = allDebtsEver.reduce((a, d) => a + (d.total || 0), 0);
  const everTotalPaid = allDebtsEver.reduce((a, d) => a + (d.paidAmount || 0), 0);
  const closedCount = allDebtsEver.filter((d) => d.paid).length;

  if (!myDebts.length) {
    let doneMsg = isOrgViewer ? `✅ "${esc(org)}" tashkilotining faol qarzi yo'q. 👍` : "✅ Faol qarzingiz yo'q. 👍";
    if (everCount > 0) {
      doneMsg += `\n\n📜 Umumiy tarix: jami <b>${everCount} ta</b> qarz yozuvi bo'lgan, hammasi (<b>${fmt(everTotalPaid)} so'm</b>) to'liq to'langan.`;
    }
    await sendMessage(token, chatId, doneMsg, { reply_markup: debtorMenuKeyboard(req) });
    return;
  }
  const total = myDebts.reduce((a, d) => a + debtRemaining(d), 0);
  let text;
  const LIST_CAP = 15;
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
    text = `🏢 <b>${esc(org)}</b> — tashkilot umumiy qarzi (qolgan): <b>${fmt(total)} so'm</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
    text += `👥 <b>Xodimlar bo'yicha taqsimot</b> (${sortedPeople.length} kishi):\n`;
    sortedPeople.forEach((p) => { text += `• ${esc(p.name)} — <b>${fmt(p.total)} so'm</b> (${p.count} ta yozuv)\n`; });
    text += `\n📝 <b>Faol qarzlar (batafsil)</b> — ${myDebts.length} ta:\n\n`;
    const sortedDebts = myDebts.sort((a, b) => new Date(b.date) - new Date(a.date));
    sortedDebts.slice(0, LIST_CAP).forEach((d) => {
      text += `👤 ${esc(d.debtorName || '')}\n` + debtDetailText(d) + '\n';
    });
    if (sortedDebts.length > LIST_CAP) text += `… va yana <b>${sortedDebts.length - LIST_CAP} ta</b> faol yozuv bor.\n`;
  } else {
    text = `💰 Joriy qarzingiz (qolgan): <b>${fmt(total)} so'm</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
    text += `📝 <b>Faol qarzlar</b> — ${myDebts.length} ta:\n\n`;
    const sortedDebts = myDebts.sort((a, b) => new Date(b.date) - new Date(a.date));
    sortedDebts.slice(0, LIST_CAP).forEach((d) => {
      text += debtDetailText(d) + '\n';
    });
    if (sortedDebts.length > LIST_CAP) text += `… va yana <b>${sortedDebts.length - LIST_CAP} ta</b> faol yozuv bor — to'liq ro'yxat uchun Mini-ilovadan foydalaning.\n\n`;
  }
  // YANGI: qisqacha umumiy (lifetime) statistika — nafaqat hozirgi qolgan
  // qarz, balki shu do'kondan UMUMAN qancha marta va qancha summaga qarzga
  // olingani hamda qanchasi allaqachon to'langani.
  text += `\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n📜 <b>Umumiy tarix</b>: jami ${everCount} ta qarz yozuvi (shundan ${closedCount} tasi to'liq yopilgan)\n`;
  text += `💵 Jami qarzga olingan: <b>${fmt(everTotalDebt)} so'm</b> · Jami to'langan: <b>${fmt(everTotalPaid)} so'm</b>\n`;
  text += `\n📱 Batafsil (jadval, grafik, to'lovlar tarixi bilan) ko'rish uchun "Mening qarzim" tugmasidan (Mini-ilova) foydalaning.`;
  await sendMessage(token, chatId, text, { reply_markup: debtorMenuKeyboard(req) });
}

// Tashkilot vakili yoki oddiy mijoz — so'nggi to'lovlar tarixini
// ko'rsatadi (mini-ilovadagi "payments" bilan bir xil manba).
async function handleCustomerPaymentHistory(db, token, chatId, req) {
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
  if (!payments.length) { await sendMessage(token, chatId, "Hali to'lov tarixi yo'q.", { reply_markup: debtorMenuKeyboard(req) }); return; }
  let text = `🧾 <b>So'nggi to'lovlar</b>\n\n`;
  payments.forEach((p) => {
    text += `• ${new Date(p.date).toLocaleDateString('uz-UZ')} — <b>${fmt(p.amount)} so'm</b>` + (isOrgViewer ? ` (${esc(p.debtorName || '')})` : '') + `\n`;
  });
  text += `\n📱 To'liq tarix uchun Mini-ilovadan foydalaning.`;
  await sendMessage(token, chatId, text, { reply_markup: debtorMenuKeyboard(req) });
}

async function handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr, kb, req) {
  const settingsData0 = await getSettings(db);
  const shopName = settingsData0?.shopName || "Do'kon";

  // YANGI: admin panelidan o'chirilgan buyruqlar bu yerda to'xtatiladi.
  if (!isTelegramCommandEnabled(settingsData0, cmd)) {
    return sendMessage(token, chatId, "⛔ Bu buyruq administrator tomonidan o'chirilgan.");
  }

  // YANGI: batafsil huquq tekshiruvi (owner har doim ruxsatli, oddiy admin
  // faqat unga aniq berilgan huquqlar doirasida) — avvalgi ikki darajali
  // (OWNER_ONLY_COMMANDS) tekshiruv o'rniga.
  const adminEntry = findAdminEntry(admins, chatId);
  const requiredPerm = COMMAND_PERMISSIONS[cmd];
  if (requiredPerm && !hasPermission(adminEntry, requiredPerm)) {
    return sendMessage(token, chatId, `⛔ Bu buyruq uchun sizda ruxsat yo'q (kerakli huquq: ${requiredPerm}). Ruxsat kerak bo'lsa, bosh administratorga murojaat qiling.`);
  }

  if (cmd === '/menu' || cmd === '/menyu') {
    return sendMessage(token, chatId, "🗂 <b>Tezkor menyu</b> — kerakli bo'limni tanlang:", { reply_markup: adminMenuKeyboard(req) });
  }

  if (cmd === '/yordam' || cmd === '/start' || cmd === '/help') return sendMessage(token, chatId, helpText(true), kb ? { reply_markup: kb } : undefined);

  if (cmd === '/qarzlar') {
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const active = debtsSnap.docs.map((d) => d.data()).sort((a, b) => debtRemaining(b) - debtRemaining(a)).slice(0, 15);
    if (!active.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q.");
    let text = `📋 <b>Faol qarzlar</b> (eng kattadan)\n\n`;
    active.forEach((d) => { text += `• ${esc(d.debtorName || d.org || '?')} — ${fmt(debtRemaining(d))} so'm\n  ID: <code>${esc(d.id)}</code>\n`; });
    text += `\nQisman to'lov: <code>/tolov ID summa</code>\nYoki pastdagi tugma orqali bir zumda to'liq yoping:`;
    const keyboard = { inline_keyboard: active.map((d) => [{ text: `✅ ${(d.debtorName || d.org || '?').slice(0, 20)} — ${fmt(debtRemaining(d))} so'm to'landi`, callback_data: `pay_full:${d.id}` }]) };
    return sendMessage(token, chatId, text, { reply_markup: keyboard });
  }

  // YANGI: muddati belgilangan (dueDate) qarzlar ro'yxati — muddatdan
  // o'tganlar tepada (🔴), so'ng eng yaqin muddatlilar (🟡), muddat
  // bo'yicha o'sish tartibida.
  if (cmd === '/muddatlar') {
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const withDue = debtsSnap.docs.map((d) => d.data()).filter((d) => d.dueDate);
    if (!withDue.length) return sendMessage(token, chatId, "✅ Muddati belgilangan faol qarz yo'q.");
    const todayStr = new Date().toISOString().slice(0, 10);
    withDue.sort((a, b) => a.dueDate.slice(0, 10).localeCompare(b.dueDate.slice(0, 10)));
    let text = `🗓 <b>Muddati belgilangan qarzlar</b> (${withDue.length} ta)\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
    const shown = withDue.slice(0, 20);
    shown.forEach((d) => {
      const dueStr = d.dueDate.slice(0, 10);
      const badge = dueStr < todayStr ? '🔴 o\'tgan' : dueStr === todayStr ? '🟠 bugun' : '🟡 kutilmoqda';
      text += `${badge} — <b>${esc(d.debtorName || d.org || '?')}</b> — ${fmt(debtRemaining(d))} so'm\n  Muddat: ${new Date(dueStr).toLocaleDateString('uz-UZ')} · ID: <code>${esc(d.id)}</code>\n`;
    });
    if (withDue.length > shown.length) text += `\n… va yana ${withDue.length - shown.length} ta. To'liq ro'yxat uchun boshqaruv panelidagi "🗓 Muddat kalendari"dan foydalaning.`;
    const keyboard = { inline_keyboard: shown.map((d) => [{ text: `✅ ${(d.debtorName || d.org || '?').slice(0, 20)} — ${fmt(debtRemaining(d))} so'm to'landi`, callback_data: `pay_full:${d.id}` }]) };
    return sendMessage(token, chatId, text, { reply_markup: keyboard });
  }

  if (cmd === '/qarz') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Qidiruv uchun ism yoki telefon kiriting: /qarz Aziz");
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const found = debtsSnap.docs.map((d) => d.data()).filter((d) => (d.debtorName || '').toLowerCase().includes(q) || (d.org || '').toLowerCase().includes(q) || (d.phone || '').includes(q));
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
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'debt_payment', detail: `${d.debtorName || d.org || '?'} — ${applied} so'm (/tolov)` });
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
    const debtorsSnap = await getDebtorsSnapshot(db);
    const debtor = debtorsSnap.docs.find((d) => d.data().name === name && !d.data().org);
    const debtorId = debtor ? debtor.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!debtor) { await db.collection('debtors').doc(debtorId).set({ id: debtorId, name, org: '', phone: phone || '', login: '', password: '', createdAt: now }); invalidateDebtorsCache(); }
    const debtId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const debt = { id: debtId, debtorId, debtorName: name, org: '', phone: phone || '', items: [], total: amount, paid: false, paidDate: null, date: now, note: note || 'Telegram bot orqali qo\'shildi', seller: 'Telegram admin', type: 'person' };
    await db.collection('debts').doc(debtId).set(debt);
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'debt_create', detail: `${name} — ${amount} so'm (/qarz_qoshish)` });
    await sendMessage(token, chatId, `✅ Yangi qarz yozildi: ${esc(name)} — ${fmt(amount)} so'm`);
    return;
  }

  if (cmd === '/statistika' || cmd === '/haftalik' || cmd === '/oylik') {
    const now = new Date();
    let fromStr, prevFromStr, prevToStr, label;
    if (cmd === '/statistika') {
      fromStr = now.toISOString().slice(0, 10); label = 'Bugungi hisobot';
      const y = new Date(now); y.setDate(y.getDate() - 1);
      prevFromStr = y.toISOString().slice(0, 10); prevToStr = prevFromStr;
    } else if (cmd === '/haftalik') {
      const from = new Date(now); from.setDate(from.getDate() - 6); fromStr = from.toISOString().slice(0, 10); label = "Oxirgi 7 kunlik hisobot";
      const pf = new Date(now); pf.setDate(pf.getDate() - 13); prevFromStr = pf.toISOString().slice(0, 10);
      const pt = new Date(now); pt.setDate(pt.getDate() - 7); prevToStr = pt.toISOString().slice(0, 10);
    } else {
      fromStr = now.toISOString().slice(0, 8) + '01'; label = "Joriy oy hisoboti";
      const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevFromStr = pm.toISOString().slice(0, 10);
      prevToStr = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
    }
    // TEZLASHTIRISH: butun savdo/qarz tarixini o'qish o'rniga, faqat shu
    // hisobot uchun kerakli sana oralig'i (joriy + solishtiriladigan
    // oldingi davr) o'qiladi — bu tarix yillar davomida to'plansa ham
    // hisobot tezligini bir xil saqlaydi.
    const [salesSnap, debtsSnap] = await Promise.all([
      db.collection('sales').where('date', '>=', prevFromStr).get(),
      db.collection('debts').where('date', '>=', fromStr).get(),
    ]);
    const allSales = salesSnap.docs.map((d) => d.data()).filter((s) => !s.reverted);
    const periodSales = allSales.filter((s) => (s.date || '').slice(0, 10) >= fromStr);
    const prevSales = allSales.filter((s) => { const d = (s.date || '').slice(0, 10); return d >= prevFromStr && d <= prevToStr; });
    const revenue = periodSales.reduce((a, s) => a + (s.total || 0), 0);
    const profit = periodSales.reduce((a, s) => a + (s.price - (s.cost || 0)) * s.qty, 0);
    const prevRevenue = prevSales.reduce((a, s) => a + (s.total || 0), 0);
    const newDebts = debtsSnap.docs.map((d) => d.data());
    const newDebtTotal = newDebts.reduce((a, d) => a + (d.total || 0), 0);
    const avgCheck = periodSales.length ? revenue / periodSales.length : 0;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    // O'tgan davrga nisbatan o'zgarish foizi (▲/▼ bilan)
    let trendLine = '';
    if (prevRevenue > 0) {
      const change = ((revenue - prevRevenue) / prevRevenue) * 100;
      const arrow = change >= 0 ? '▲' : '▼';
      const trendLabel = cmd === '/statistika' ? "kechagiga nisbatan" : cmd === '/haftalik' ? "oldingi haftaga nisbatan" : "oldingi oyga nisbatan";
      trendLine = `${arrow} ${change >= 0 ? '+' : ''}${change.toFixed(1)}% (${trendLabel})\n`;
    } else if (revenue > 0) {
      trendLine = `🆕 oldingi davrda savdo bo'lmagan\n`;
    }

    // Foyda marjasi uchun oddiy matnli progress-bar (0–100%)
    const barLen = 10;
    const filled = Math.max(0, Math.min(barLen, Math.round((margin / 100) * barLen)));
    const bar = '▓'.repeat(filled) + '░'.repeat(barLen - filled);

    let text = `📊 <b>${label}</b> — ${esc(shopName)}\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
    text += `🧾 Savdolar: <b>${periodSales.length} ta</b>\n`;
    text += `💰 Tushum: <b>${fmt(revenue)} so'm</b>\n`;
    if (trendLine) text += trendLine;
    text += `📈 Foyda: <b>${fmt(profit)} so'm</b>  (marja ${margin.toFixed(1)}%)\n`;
    text += `<code>${bar}</code>\n`;
    if (periodSales.length) text += `🧮 O'rtacha chek: ${fmt(avgCheck)} so'm\n`;
    text += `📝 Yangi qarzga sotish: ${newDebts.length} ta (${fmt(newDebtTotal)} so'm)`;
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/top') {
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const active = debtsSnap.docs.map((d) => d.data());
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
    const medals = ['🥇', '🥈', '🥉'];
    let text = `🏆 <b>Eng katta 10 ta qarzdor</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
    top.forEach((p, i) => { const rank = medals[i] || `${i + 1}.`; text += `${rank} ${esc(p.name)} — <b>${fmt(p.total)} so'm</b> (${p.ids.length} ta yozuv)\n`; });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/eslatma') {
    const q = argStr.trim().toLowerCase();
    if (!q) return sendMessage(token, chatId, "Foydalanish: /eslatma Aziz (ism yoki telefon)");
    const debtorsSnap = await getDebtorsSnapshot(db);
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
    const debtorsSnap = await db.collection('debtors').where('telegramChatId', '!=', '').get().catch(() => getDebtorsSnapshot(db));
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
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'broadcast', detail: `${sent}/${targets.length} ta mijozga: "${text.slice(0, 80)}"` });
    return sendMessage(token, chatId, `✅ Xabar ${sent}/${targets.length} ta mijozga yetkazildi.`);
  }

  if (cmd === '/export') {
    const debtsSnap = await db.collection('debts').where('paid', '==', false).get();
    const active = debtsSnap.docs.map((d) => d.data()).sort((a, b) => debtRemaining(b) - debtRemaining(a));
    if (!active.length) return sendMessage(token, chatId, "✅ Faol qarz yo'q, eksport qilinadigan narsa yo'q.");
    const rows = [['Ism/Tashkilot', 'Telefon', 'Sana', 'Jami', "To'langan", 'Qoldiq', 'ID']];
    active.forEach((d) => rows.push([d.debtorName || d.org || '', d.phone || '', (d.date || '').slice(0, 10), d.total || 0, d.paidAmount || 0, debtRemaining(d), d.id]));
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    await sendDocument(token, chatId, `qarzlar-${new Date().toISOString().slice(0, 10)}.csv`, csv, `📄 Faol qarzlar (${active.length} ta)`);
    return;
  }

  if (cmd === '/ombor') {
    const productsSnap = await getProductsSnapshot(db);
    const products = productsSnap.docs.map((d) => d.data());
    const threshold = (await getSettings(db))?.lowStockThreshold || 5;
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
    const productsSnap = await getProductsSnapshot(db);
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
    const productsSnap = await getProductsSnapshot(db);
    const found = productsSnap.docs.filter((d) => (d.data().name || '').toLowerCase().includes(q));
    if (!found.length) return sendMessage(token, chatId, "Tovar topilmadi.");
    if (found.length > 1) return sendMessage(token, chatId, `Bir nechta tovar topildi, aniqroq nom kiriting:\n${found.slice(0, 10).map((d) => '• ' + esc(d.data().name)).join('\n')}`);
    const oldPrice = found[0].data().price;
    await found[0].ref.update({ price: newPrice });
    invalidateProductsCache();
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'product_price_update', detail: `${found[0].data().name}: ${oldPrice} → ${newPrice} so'm (/tovar_narx)` });
    return sendMessage(token, chatId, `✅ "${esc(found[0].data().name)}" narxi ${fmt(newPrice)} so'mga yangilandi.`);
  }

  if (cmd === '/adminlar') {
    if (!admins.length) return sendMessage(token, chatId, "Hali admin qo'shilmagan.");
    let text = `👤 <b>Adminlar</b>\n\n`;
    admins.forEach((a) => {
      const roleBadge = (a.role || 'owner') === 'owner' ? '👑 owner' : '🧑‍💼 admin';
      if (a.chatId) text += `• ✅ ${esc(a.name || 'Admin')} — ${roleBadge} — Chat ID: <code>${esc(a.chatId)}</code>\n`;
      else { const via = a.username ? `@${esc(a.username)}` : a.phone ? esc(a.phone) : '—'; text += `• ⏳ ${esc(a.name || 'Admin')} — ${roleBadge} — kutmoqda (${via})\n`; }
    });
    return sendMessage(token, chatId, text);
  }

  if (cmd === '/admin_qoshish') {
    const rawParts = argStr.trim().split(/\s+/);
    // YANGI: oxirgi so'z "owner" yoki "admin" bo'lsa, rol sifatida olinadi.
    // Ko'rsatilmasa, xavfsizlik uchun standart rol — cheklangan "admin".
    let role = 'admin';
    if (rawParts.length > 1 && (rawParts[rawParts.length - 1] === 'owner' || rawParts[rawParts.length - 1] === 'admin')) {
      role = rawParts.pop();
    }
    const parts = rawParts;
    const idArg = parts[0];
    const name = parts.slice(1).join(' ') || 'Admin';
    if (!idArg) return sendMessage(token, chatId, "Foydalanish:\n/admin_qoshish 123456789 Ism [owner] — Chat ID bilan\n/admin_qoshish +998901234567 Ism [owner] — telefon raqami bilan\n/admin_qoshish @username Ism [owner] — username bilan\n\nOxiriga \"owner\" qo'shsangiz, u bosh admin sifatida qo'shiladi. Ko'rsatmasangiz, standart holatda cheklangan \"admin\" bo'ladi (admin qo'sha/o'chira va broadcast qila olmaydi).");
    const isNumericChatId = /^-?\d{5,}$/.test(idArg) && !idArg.startsWith('+');
    const isUsername = idArg.startsWith('@');
    const newAdmin = { id: 'tg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, chatId: '', phone: '', username: '', role };
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
    invalidateSettingsCache();
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'admin_add', detail: `${name} — ${role} (/admin_qoshish)` });
    const roleLabel = role === 'owner' ? '👑 owner (bosh admin)' : '🧑‍💼 admin (cheklangan)';
    if (newAdmin.chatId) {
      await sendMessage(token, chatId, `✅ Yangi admin qo'shildi: ${esc(name)} (${esc(newAdmin.chatId)}) — ${roleLabel}`);
      await setAdminMenuButton(token, newAdmin.chatId, req).catch(() => {});
      await setCommandsForChat(token, newAdmin.chatId, true).catch(() => {});
      await sendMessage(token, newAdmin.chatId, `👋 Siz "${esc(shopName)}" do'konining Telegram admini (${roleLabel}) etib tayinlandingiz. /menu yozib tugmali menyuni yoki /yordam yozib buyruqlar ro'yxatini ko'ring.`).catch(() => {});
    } else {
      await sendMessage(token, chatId, `✅ ${esc(name)} "kutayotgan admin" sifatida qo'shildi — ${roleLabel}.\nU botga birinchi marta yozganda (yoki telefon raqamini yuborganda) avtomatik faollashadi.`);
    }
    return;
  }

  if (cmd === '/admin_ochirish') {
    const target = argStr.trim();
    if (!target) return sendMessage(token, chatId, "Foydalanish: /admin_ochirish 123456789 (yoki telefon/@username)");
    const uKey = usernameKey(target);
    const pKey = phoneKey(target);
    const targetAdmin = admins.find((a) => String(a.chatId) === target || (target.startsWith('@') && usernameKey(a.username) === uKey) || (pKey && phoneKey(a.phone) === pKey));
    if (!targetAdmin) return sendMessage(token, chatId, "Bunday admin topilmadi.");
    // Xavfsizlik: oxirgi owner'ni o'chirib bo'lmaydi — aks holda hech kim
    // admin boshqaruvi qila olmay qoladigan holatga tushib qolish mumkin.
    const remainingOwners = admins.filter((a) => a !== targetAdmin && (a.role || 'owner') === 'owner');
    if ((targetAdmin.role || 'owner') === 'owner' && remainingOwners.length === 0) {
      return sendMessage(token, chatId, "⛔ Bu yagona bosh admin (owner) — uni o'chirib bo'lmaydi. Avval boshqa birortasini owner qiling (/admin_rol).");
    }
    const remaining = admins.filter((a) => a !== targetAdmin);
    await settingsRef.set({ telegramAdmins: remaining }, { merge: true });
    invalidateSettingsCache();
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'admin_remove', detail: `${targetAdmin.name || target} (/admin_ochirish)` });
    return sendMessage(token, chatId, `✅ Admin o'chirildi (${esc(targetAdmin.name || target)}).`);
  }

  // YANGI: bitta huquqni yoqish/o'chirish — Mini App/panel'dagi
  // "update_admin_permissions" amali bilan bir xil natija, botdan ham.
  if (cmd === '/admin_huquq') {
    const parts = argStr.trim().split(/\s+/);
    const target = parts[0];
    const permKey = parts[1];
    const val = parts[2];
    const { PERMISSION_KEYS, defaultPermissionsForRole } = require('./_permissions');
    const validKeys = PERMISSION_KEYS.map((p) => p.key);
    if (!target || !validKeys.includes(permKey) || (val !== 'yes' && val !== 'off')) {
      return sendMessage(token, chatId, `Foydalanish: /admin_huquq <chatId/@username/tel> <huquq> <yes|off>\nHuquqlar: ${validKeys.join(', ')}`);
    }
    const uKey = usernameKey(target);
    const pKey = phoneKey(target);
    const targetAdmin = admins.find((a) => String(a.chatId) === target || (target.startsWith('@') && usernameKey(a.username) === uKey) || (pKey && phoneKey(a.phone) === pKey));
    if (!targetAdmin) return sendMessage(token, chatId, "Bunday admin topilmadi.");
    if ((targetAdmin.role || 'owner') === 'owner') return sendMessage(token, chatId, "👑 Owner har doim barcha huquqlarga ega — cheklab bo'lmaydi.");
    const perms = targetAdmin.permissions && typeof targetAdmin.permissions === 'object' ? { ...targetAdmin.permissions } : defaultPermissionsForRole('admin');
    perms[permKey] = val === 'yes';
    targetAdmin.permissions = perms;
    await settingsRef.set({ telegramAdmins: admins }, { merge: true });
    invalidateSettingsCache();
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'admin_permission_update', detail: `${targetAdmin.name || target}: ${permKey} → ${val} (/admin_huquq)` });
    await sendMessage(token, chatId, `✅ ${esc(targetAdmin.name || target)} uchun "${permKey}" huquqi ${val === 'yes' ? 'YOQILDI' : "O'CHIRILDI"}.`);
    if (targetAdmin.chatId) await sendMessage(token, targetAdmin.chatId, `ℹ️ Sizning "${permKey}" huquqingiz ${val === 'yes' ? 'yoqildi' : "o'chirildi"}.`).catch(() => {});
    return;
  }

  if (cmd === '/admin_rol') {
    const parts = argStr.trim().split(/\s+/);
    const target = parts[0];
    const newRole = parts[1];
    if (!target || (newRole !== 'owner' && newRole !== 'admin')) return sendMessage(token, chatId, "Foydalanish: /admin_rol <chatId yoki @username yoki telefon> <owner|admin>\nMasalan: /admin_rol @aziz owner");
    const uKey = usernameKey(target);
    const pKey = phoneKey(target);
    const targetAdmin = admins.find((a) => String(a.chatId) === target || (target.startsWith('@') && usernameKey(a.username) === uKey) || (pKey && phoneKey(a.phone) === pKey));
    if (!targetAdmin) return sendMessage(token, chatId, "Bunday admin topilmadi.");
    const remainingOwners = admins.filter((a) => a !== targetAdmin && (a.role || 'owner') === 'owner');
    if ((targetAdmin.role || 'owner') === 'owner' && newRole === 'admin' && remainingOwners.length === 0) {
      return sendMessage(token, chatId, "⛔ Bu yagona bosh admin (owner) — uning rolini pasaytirib bo'lmaydi. Avval boshqa birortasini owner qiling.");
    }
    targetAdmin.role = newRole;
    await settingsRef.set({ telegramAdmins: admins }, { merge: true });
    invalidateSettingsCache();
    await logAction(db, { source: 'bot', actorName: adminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'admin_role_update', detail: `${targetAdmin.name || target} → ${newRole} (/admin_rol)` });
    await sendMessage(token, chatId, `✅ ${esc(targetAdmin.name || target)} roli — ${newRole === 'owner' ? '👑 owner' : '🧑‍💼 admin'} qilib o'zgartirildi.`);
    if (targetAdmin.chatId) await sendMessage(token, targetAdmin.chatId, `ℹ️ Sizning admin rolingiz ${newRole === 'owner' ? '👑 owner (bosh admin)' : '🧑‍💼 admin (cheklangan)'} ga o'zgartirildi.`).catch(() => {});
    return;
  }

  return sendMessage(token, chatId, "Noma'lum buyruq. /yordam yozing yoki /menu orqali tugmali menyuni oching.");
}

// "✅ To'landi" inline tugmasi bosilganda ishlaydi (callback_query).
// Faqat admin bosgan taqdirdagina ishlaydi — boshqa hech kim (hatto o'sha
// xabarni ko'rgan bo'lsa ham) qarzni yopa olmaydi.
// YANGI: tugmali menyudan bosilgan buyruqlar shu yerda "cmd:/buyruq" ko'rinishida
// keladi. Admin buyruqlari uchun handleAdminCommand'ni, mijoz (qarzdor)
// buyruqlari uchun mos handler funksiyani chaqiramiz — mantiq matn buyruq
// bilan AYNAN bir xil, faqat ikkinchi marta yozilmaydi.
const ADMIN_MENU_COMMANDS = new Set(['/qarzlar', '/muddatlar', '/top', '/statistika', '/haftalik', '/oylik', '/ombor', '/export', '/adminlar', '/menu']);
const DEBTOR_MENU_COMMANDS = new Set(['/qarzim', '/tarix', '/ballarim', '/coinlarim']);

// ============ YANGI: MIJOZ BUYURTMASI — TASDIQLASH / BEKOR QILISH ============
// Mijoz mini-ilova katalogidan "Sotib olish" bosganda yaratilgan
// "orders" hujjatini admin shu yerda (bot xabaridagi tugma orqali)
// tasdiqlaydi yoki bekor qiladi. Tasdiqlansa — tovar avtomatik SOTILADI
// (ombordan yechiladi, "sales" yozuvi yaratiladi) va mijozga ball
// yoziladi (agar ball bilan to'langan bo'lsa — ishlatilgan ball ayiriladi).
async function handleOrderDecision(db, token, settingsRef, cq, orderId, isConfirm, req) {
  const adminChatId = cq.message && cq.message.chat && cq.message.chat.id;
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) { await answerCallbackQuery(token, cq.id, "Bu buyurtma topilmadi.", true); return; }
  const order = orderSnap.data();
  if (order.status !== 'pending') {
    await answerCallbackQuery(token, cq.id, order.status === 'confirmed' ? "Bu buyurtma allaqachon tasdiqlangan." : "Bu buyurtma allaqachon bekor qilingan.", true);
    return;
  }
  const settingsDataOD = await getSettings(db);
  const shopName = settingsDataOD?.shopName || "Do'kon";
  const currencySymbol = settingsDataOD?.currencySymbol || "so'm";
  const items = Array.isArray(order.items) ? order.items : [];

  if (!isConfirm) {
    await orderRef.update({ status: 'cancelled', decidedAt: new Date().toISOString(), decidedBy: String(adminChatId) });
    await answerCallbackQuery(token, cq.id, "❌ Buyurtma bekor qilindi.");
    if (cq.message && cq.message.text) {
      await editMessageText(token, adminChatId, cq.message.message_id, cq.message.text + `\n\n❌ <b>Bekor qilindi.</b>`).catch(() => {});
    }
    if (order.customerChatId) {
      await sendMessage(token, order.customerChatId, `❌ <b>${esc(shopName)}</b>\n\nAfsuski, buyurtmangiz bekor qilindi. Savolingiz bo'lsa do'konga murojaat qiling.`).catch(() => {});
    }
    return;
  }

  // Tasdiqlashdan oldin zaxirani qayta tekshiramiz (buyurtma berilgandan
  // beri boshqa savdo bo'lgan bo'lishi mumkin).
  const productRefs = items.map((it) => db.collection('products').doc(it.productId));
  const productSnaps = await Promise.all(productRefs.map((r) => r.get()));
  for (let i = 0; i < items.length; i++) {
    const snap = productSnaps[i];
    if (!snap.exists || (snap.data().stock || 0) < items[i].qty) {
      await answerCallbackQuery(token, cq.id, `⚠️ "${items[i].name}" omborda yetarli emas. Buyurtmani bekor qiling yoki avval omborni to'ldiring.`, true);
      return;
    }
  }

  const now = new Date().toISOString();
  await Promise.all(productSnaps.map((snap, i) => snap.ref.update({ stock: admin.firestore.FieldValue.increment(-items[i].qty) })));
  invalidateProductsCache();
  await Promise.all(productSnaps.map((snap, i) => db.collection('sales').doc(uid()).set({
    id: uid(), productId: snap.id, productName: items[i].name, volume: snap.data().volume || '', qty: items[i].qty,
    price: items[i].price, cost: snap.data().cost || 0, total: items[i].subtotal, seller: `Mijoz buyurtmasi (${order.customerName || ''})`,
    date: now, reverted: false, isDebt: false,
  })));

  // Mijozga: sarflangan ballarni ayirish va yangi to'plangan ballarni qo'shish.
  if (order.customerId) {
    const customerRef = db.collection('customers').doc(order.customerId);
    const patch = {
      points: admin.firestore.FieldValue.increment((order.totalPoints || 0) - (order.pointsUsed || 0)),
      totalSpent: admin.firestore.FieldValue.increment(order.total || 0),
      purchaseCount: admin.firestore.FieldValue.increment(1),
      lastPurchaseAt: now,
    };
    await customerRef.set(patch, { merge: true }).catch(() => {});
  }

  await orderRef.update({ status: 'confirmed', decidedAt: now, decidedBy: String(adminChatId) });
  await answerCallbackQuery(token, cq.id, "✅ Buyurtma tasdiqlandi, tovar sotildi!");
  if (cq.message && cq.message.text) {
    await editMessageText(token, adminChatId, cq.message.message_id, cq.message.text + `\n\n✅ <b>Tasdiqlandi — sotildi.</b>`).catch(() => {});
  }
  if (order.customerChatId) {
    let text = `✅ <b>${esc(shopName)}</b>\n\n🎉 Buyurtmangiz tasdiqlandi!\n\n`;
    items.forEach((it) => { text += `• ${esc(it.name)} — ${it.qty} ta\n`; });
    text += `\n💰 Jami: <b>${fmt(order.total)} ${esc(currencySymbol)}</b>\n`;
    if (order.pointsUsed > 0) text += `🪙 Ishlatilgan coin: <b>${order.pointsUsed}</b>\n`;
    if (order.cashDue > 0) text += `💵 Do'konda to'lanadigan naqd: <b>${fmt(order.cashDue)} ${esc(currencySymbol)}</b>\n`;
    if ((order.totalPoints || 0) > 0) text += `🎁 Yangi to'plangan coin: <b>+${order.totalPoints}</b>\n`;
    text += `\n📦 Tovaringizni do'kondan olishingiz mumkin.`;
    await sendMessage(token, order.customerChatId, text).catch(() => {});
  }
}

// ============ YANGI: COIN EVAZIGA SOTIB OLISH — TASDIQLASH / BEKOR QILISH ============
// Mijoz mini-ilova katalogidan bitta tovarni FAQAT COIN evaziga (naqd
// pulsiz) sotib olish so'rovi yuborganda yaratiladi ("coinOrders"
// hujjati). Bu yerda admin bot xabaridagi tugma orqali tasdiqlaydi yoki
// bekor qiladi. Tasdiqlansa: tovar ombordan yechiladi, mijozning
// coin (points) balansidan mos summa ayiriladi VA bu "sales" (naqd
// savdo) to'plamiga YOZILMAYDI — chunki pul emas, coin bilan to'landi;
// aks holda kunlik tushum/foyda hisobotlari noto'g'ri bo'lib qolardi.
// O'rniga mijozning o'z tarixiga (customers/{id}.redemptions) yoziladi.
async function handleCoinOrderDecision(db, token, settingsRef, cq, coinOrderId, isConfirm, req) {
  const adminChatId = cq.message && cq.message.chat && cq.message.chat.id;
  const orderRef = db.collection('coinOrders').doc(coinOrderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) { await answerCallbackQuery(token, cq.id, "Bu so'rov topilmadi.", true); return; }
  const order = orderSnap.data();
  if (order.status !== 'pending') {
    await answerCallbackQuery(token, cq.id, order.status === 'confirmed' ? "Bu so'rov allaqachon tasdiqlangan." : "Bu so'rov allaqachon bekor qilingan.", true);
    return;
  }
  const settingsDataCOD = await getSettings(db);
  const shopName = settingsDataCOD?.shopName || "Do'kon";

  if (!isConfirm) {
    await orderRef.update({ status: 'cancelled', decidedAt: new Date().toISOString(), decidedBy: String(adminChatId) });
    await answerCallbackQuery(token, cq.id, "❌ So'rov bekor qilindi.");
    if (cq.message && cq.message.text) {
      await editMessageText(token, adminChatId, cq.message.message_id, cq.message.text + `\n\n❌ <b>Bekor qilindi.</b>`).catch(() => {});
    }
    if (order.customerChatId) {
      await sendMessage(token, order.customerChatId, `❌ <b>${esc(shopName)}</b>\n\nAfsuski, "${esc(order.productName)}" ni coinga sotib olish so'rovingiz bekor qilindi. Coiningiz o'zgarishsiz qoladi.`).catch(() => {});
    }
    return;
  }

  // Tasdiqlashdan oldin zaxira va coin balansini qayta tekshiramiz
  // (so'rov berilgandan beri boshqa savdo/so'rov bo'lgan bo'lishi mumkin).
  const productRef = db.collection('products').doc(order.productId);
  const productSnap = await productRef.get();
  if (!productSnap.exists || (productSnap.data().stock || 0) < order.qty) {
    await answerCallbackQuery(token, cq.id, `⚠️ "${order.productName}" omborda yetarli emas.`, true);
    return;
  }
  let customerData = null;
  if (order.customerId) {
    const customerSnap = await db.collection('customers').doc(order.customerId).get();
    customerData = customerSnap.exists ? customerSnap.data() : null;
  }
  if (!customerData || (customerData.points || 0) < order.totalCoinCost) {
    await answerCallbackQuery(token, cq.id, `⚠️ Mijozning coini endi yetarli emas.`, true);
    return;
  }

  const now = new Date().toISOString();
  await productRef.update({ stock: admin.firestore.FieldValue.increment(-order.qty) });
  invalidateProductsCache();
  if (order.customerId) {
    await db.collection('customers').doc(order.customerId).set({
      points: admin.firestore.FieldValue.increment(-order.totalCoinCost),
      redemptions: admin.firestore.FieldValue.arrayUnion({
        date: now, pointsUsed: order.totalCoinCost, discount: 0,
        productName: order.productName, qty: order.qty,
      }),
    }, { merge: true }).catch(() => {});
  }

  await orderRef.update({ status: 'confirmed', decidedAt: now, decidedBy: String(adminChatId) });
  await answerCallbackQuery(token, cq.id, "✅ Tasdiqlandi — tovar coinga berildi!");
  if (cq.message && cq.message.text) {
    await editMessageText(token, adminChatId, cq.message.message_id, cq.message.text + `\n\n✅ <b>Tasdiqlandi — berildi.</b>`).catch(() => {});
  }
  if (order.customerChatId) {
    const text = `✅ <b>${esc(shopName)}</b>\n\n🎉 "${esc(order.productName)}" (${order.qty} ta) coin evaziga sotib olindi!\n\n🪙 Sarflangan coin: <b>${order.totalCoinCost}</b>\n📦 Tovaringizni do'kondan olishingiz mumkin.`;
    await sendMessage(token, order.customerChatId, text).catch(() => {});
  }
}

async function handleCallbackQuery(db, token, settingsRef, admins, cq, req) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  if (!chatId) { await answerCallbackQuery(token, cq.id); return; }
  const isAdmin = isAdminChat(admins, chatId);

  if (data.startsWith('cmd:')) {
    const cmd = data.slice('cmd:'.length);
    if (ADMIN_MENU_COMMANDS.has(cmd)) {
      if (!isAdmin) { await answerCallbackQuery(token, cq.id, "Bu amal faqat admin uchun.", true); return; }
      await answerCallbackQuery(token, cq.id);
      try {
        await handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, '', miniAppKeyboard(req, true), req);
      } catch (e) {
        console.error('Menyu buyrug\'i xatosi:', cmd, e);
        await sendMessage(token, chatId, "⚠️ Xatolik yuz berdi. Qaytadan urinib ko'ring.").catch(() => {});
      }
      return;
    }
    if (DEBTOR_MENU_COMMANDS.has(cmd)) {
      await answerCallbackQuery(token, cq.id);
      try {
        // YANGI: /qarzim, /tarix kabi mijoz buyruqlari ham admin panelidan
        // o'chirilgan bo'lishi mumkin (COIN'dan tashqari — u alohida
        // isCoinEnabled orqali handleLoyaltyPoints ichida tekshiriladi).
        if (cmd !== '/ballarim' && cmd !== '/coinlarim') {
          const s = await getSettings(db);
          if (!isTelegramCommandEnabled(s, cmd)) {
            await sendMessage(token, chatId, "⛔ Bu bo'lim hozircha o'chirilgan.");
            return;
          }
        }
        if (cmd === '/qarzim') await handleCustomerMyDebts(db, token, chatId, req);
        else if (cmd === '/tarix') await handleCustomerPaymentHistory(db, token, chatId, req);
        else if (cmd === '/ballarim' || cmd === '/coinlarim') await handleLoyaltyPoints(db, token, chatId, req);
      } catch (e) {
        console.error('Mijoz menyusi xatosi:', cmd, e);
        await sendMessage(token, chatId, "⚠️ Xatolik yuz berdi. Qaytadan urinib ko'ring.").catch(() => {});
      }
      return;
    }
    await answerCallbackQuery(token, cq.id);
    return;
  }

  if (!isAdmin) {
    await answerCallbackQuery(token, cq.id, "Bu amal faqat admin uchun.", true);
    return;
  }

  // ============ YANGI: MIJOZ BUYURTMASI — TASDIQLASH / BEKOR QILISH ============
  if (data.startsWith('order_confirm:') || data.startsWith('order_cancel:')) {
    const isConfirm = data.startsWith('order_confirm:');
    const orderId = data.slice(data.indexOf(':') + 1);
    await handleOrderDecision(db, token, settingsRef, cq, orderId, isConfirm, req);
    return;
  }

  // ============ YANGI: COIN EVAZIGA SOTIB OLISH — TASDIQLASH / BEKOR QILISH ============
  if (data.startsWith('coinorder_confirm:') || data.startsWith('coinorder_cancel:')) {
    const isConfirm = data.startsWith('coinorder_confirm:');
    const coinOrderId = data.slice(data.indexOf(':') + 1);
    await handleCoinOrderDecision(db, token, settingsRef, cq, coinOrderId, isConfirm, req);
    return;
  }

  if (!data.startsWith('pay_full:')) { await answerCallbackQuery(token, cq.id); return; }
  // YANGI: qarzni to'lash "manageDebts" huquqini talab qiladi — owner har
  // doim ruxsatli, cheklangan admin esa faqat shu huquq berilgan bo'lsa.
  const cqAdminEntry = findAdminEntry(admins, chatId);
  if (!hasPermission(cqAdminEntry, 'manageDebts')) { await answerCallbackQuery(token, cq.id, "⛔ Sizda qarzlarni boshqarish huquqi yo'q.", true); return; }
  const debtId = data.slice('pay_full:'.length);
  const debtRef = db.collection('debts').doc(debtId);
  const debtSnap = await debtRef.get();
  if (!debtSnap.exists) { await answerCallbackQuery(token, cq.id, "Bu qarz topilmadi (o'chirilgan bo'lishi mumkin).", true); return; }
  const d = debtSnap.data();
  const remaining = debtRemaining(d);
  if (remaining <= 0) { await answerCallbackQuery(token, cq.id, "Bu qarz allaqachon to'liq to'langan."); return; }
  const shopName = (await getSettings(db))?.shopName || "Do'kon";
  const payment = { amount: remaining, date: new Date().toISOString(), note: "Telegram bot orqali (tez tugma)", by: 'Telegram admin' };
  await debtRef.update({
    paidAmount: admin.firestore.FieldValue.increment(remaining),
    payments: admin.firestore.FieldValue.arrayUnion(payment),
    paid: true,
    paidDate: payment.date,
  });
  await logAction(db, { source: 'bot', actorName: cqAdminEntry?.name || 'Telegram admin', actorChatId: chatId, action: 'debt_payment', detail: `${d.debtorName || d.org || '?'} — ${remaining} so'm (tez tugma to'liq to'lov)` });
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
async function processUpdate(db, token, settingsRef, admins, sellers, upd, req, settingsData) {
  const welcomeText = settingsData && settingsData.telegramWelcomeText;
  if (upd.callback_query) { await handleCallbackQuery(db, token, settingsRef, admins, upd.callback_query, req); return; }
  const msg = upd.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  let isAdmin = isAdminChat(admins, chatId);
  const kbAdmin = miniAppKeyboard(req, true);
  const kbDebtor = miniAppKeyboard(req, false);
  const kb = isAdmin ? kbAdmin : kbDebtor;

  // YANGI: agar bu mijoz hozir chekdan ro'yxatdan o'tish jarayonida bo'lsa
  // (ism yoki telefon so'ralgan bo'lsa), keyingi matn xabari — hatto u
  // "/start" kabi ko'rinsa ham emas, oddiy javob — shu yerda ustuvor tarzda
  // qayta ishlanadi. Bu boshqa HAMMA narsadan (admin/sotuvchi/qarzdor
  // aniqlashdan, /start dan) OLDIN tekshiriladi.
  if (!isAdmin && await handlePendingRegistrationText(db, token, chatId, msg, req)) return;

  // Chek QR orqali "/start r_<receiptId>" deep-link kelgan bo'lsa — bu
  // boshqa hamma narsadan OLDIN, mustaqil ravishda qayta ishlanadi (admin/
  // sotuvchi/qarzdor rolidan qat'i nazar — birinchi marta yozayotgan yangi
  // mijoz ham, allaqachon tanilgan mijoz ham bo'lishi mumkin).
  if (await handleReceiptClaim(db, token, chatId, msg, req)) return;

  // Mijozni "bir martalik havola" (/start cl_<token>) orqali ulash — bu
  // ham chek claim kabi, boshqa hamma narsadan OLDIN, mustaqil tekshiriladi.
  if (await handleCustomerLinkClaim(db, token, chatId, msg, req)) return;

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

  // YANGI: SOTUVCHI (xodim) sifatida tanish. Admin bo'lmagan har bir kishi
  // ilgari to'g'ridan-to'g'ri "qarzdor/mijoz" oqimiga tushib qolardi — endi
  // avval sotuvchilar ro'yxatida (chatId yoki oldindan kiritilgan Telegram
  // username orqali) qidiramiz. Topilsa, alohida (soddalashtirilgan) oqim
  // bilan javob berib, boshqa hech qanday qarzdor/mijoz ro'yxatiga
  // yozilmasdan chiqamiz.
  if (!isAdmin) {
    let sellerRec = findSellerByChat(sellers, chatId);
    if (!sellerRec && msg.from && msg.from.username) {
      const sIdx = findPendingSellerIndex(sellers, msg.from.username);
      if (sIdx !== -1) {
        await linkPendingSeller(settingsRef, sellers, sIdx, chatId);
        sellerRec = sellers[sIdx];
      }
    }
    if (sellerRec) {
      const text0 = (msg.text || '').trim();
      if (text0 === '/menu' || text0 === '/menyu') {
        await sendMessage(token, chatId, "🛒 Savdo panelini quyidagi tugma orqali oching:", { reply_markup: sellerAppKeyboard(req) });
        return;
      }
      await setSellerMenuButton(token, chatId, req).catch(() => {});
      await sendMessage(token, chatId, sellerHelpText(sellerRec.name), { reply_markup: sellerAppKeyboard(req) });
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
    const [alreadyLinkedSnap, alreadyLoyaltySnap] = await Promise.all([
      db.collection('debtors').where('telegramChatId', '==', String(chatId)).limit(1).get(),
      db.collection('customers').where('telegramChatId', '==', String(chatId)).limit(1).get(),
    ]);
    isKnownDebtor = !alreadyLinkedSnap.empty;
    isKnownLoyalty = !alreadyLoyaltySnap.empty;
    // TUZATILDI — SEKINLIK: ilgari quyidagi 4 ta funksiya (username/ID
    // bo'yicha qarzdor va sodiqlik mijozini izlash) HAR BIRI o'zicha
    // butun 'debtors' yoki 'customers' kolleksiyasini QAYTA-QAYTA (jami
    // 4 marta, ketma-ket) o'qirdi — bu har bir ulanmagan foydalanuvchi
    // yozgan HAR BIR xabarda sezilarli kechikishga sabab bo'lardi,
    // ayniqsa mijozlar/qarzdorlar soni ko'p bo'lgan do'konlarda. Endi:
    // kerakli kolleksiyalar FAQAT BIR MARTA, PARALLEL o'qiladi va
    // natija ikkala (username + telegram ID) tekshiruvga qayta ishlatiladi.
    const [debtorsSnap, customersSnap] = await Promise.all([
      !isKnownDebtor ? getDebtorsSnapshot(db) : Promise.resolve(null),
      !isKnownLoyalty ? db.collection('customers').get() : Promise.resolve(null),
    ]);
    if (!isKnownDebtor) {
      const linkedByUsername = await tryLinkCustomerByUsername(db, token, msg, kbDebtor, req, debtorsSnap);
      if (linkedByUsername) return;
      const linkedById = await tryLinkCustomerByTelegramId(db, token, msg, kbDebtor, req, debtorsSnap);
      if (linkedById) return;
    }
    if (!isKnownLoyalty) {
      const linkedLoyaltyByUsername = await tryLinkLoyaltyCustomerByUsername(db, token, msg, kbDebtor, customersSnap);
      if (linkedLoyaltyByUsername) return;
      const linkedLoyaltyById = await tryLinkLoyaltyCustomerByTelegramId(db, token, msg, kbDebtor, customersSnap);
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
        const customLine0 = (welcomeText && String(welcomeText).trim()) ? `${esc(String(welcomeText).trim())}\n\n` : '';
        await sendMessage(token, chatId, `👋 ${greetingWord()}!\n\n` + customLine0 + helpText(false) + outsideWorkScheduleNote(settingsData), { reply_markup: debtorMenuKeyboard(req, settingsData) || kbDebtor || { remove_keyboard: true } });
        return;
      }
      // Hali hech qanday ro'yxatda (qarzdor yoki mijoz) topilmadi — admin
      // kutmasdan, shu zahoti avtomatik "mijoz" sifatida ro'yxatga olamiz.
      await autoRegisterCustomer(db, token, msg, kbDebtor, welcomeText);
      await setMenuButtonFor(token, chatId, req, false).catch(() => {});
      return;
    }
    await setAdminMenuButton(token, chatId, req);
    await setCommandsForChat(token, chatId, true).catch(() => {});
    {
      const customLine0 = (welcomeText && String(welcomeText).trim()) ? `${esc(String(welcomeText).trim())}\n\n` : '';
      await sendMessage(token, chatId, `👋 ${greetingWord()}!\n\n` + customLine0 + helpText(isAdmin) + outsideWorkScheduleNote(settingsData), { reply_markup: adminMenuKeyboard(req) || kbAdmin });
    }
    return;
  }
  if (text === '/menu' || text === '/menyu') {
    if (!isAdmin) { await sendMessage(token, chatId, "🗂 Menyu — kerakli bo'limni tanlang:", { reply_markup: debtorMenuKeyboard(req, settingsData) }); return; }
    // isAdmin holatida /menu quyida handleAdminCommand orqali ham ishlaydi,
    // lekin shu yerda ham tezkor javob beramiz.
  }
  if (text === '/qarzim' && !isAdmin) {
    if (!isTelegramCommandEnabled(settingsData, '/qarzim')) { await sendMessage(token, chatId, "⛔ Bu bo'lim hozircha o'chirilgan."); return; }
    await handleCustomerMyDebts(db, token, chatId, req); return;
  }
  if (text === '/tarix' && !isAdmin) {
    if (!isTelegramCommandEnabled(settingsData, '/tarix')) { await sendMessage(token, chatId, "⛔ Bu bo'lim hozircha o'chirilgan."); return; }
    await handleCustomerPaymentHistory(db, token, chatId, req); return;
  }
  if ((text === '/ballarim' || text === '/coinlarim') && !isAdmin) { await handleLoyaltyPoints(db, token, chatId, req); return; }
  if (!isAdmin && !isKnownAny && !text.startsWith('/')) {
    // Hali tanilmagan (ro'yxatdan o'tmagan) kishi /start dan boshqa narsa
    // yozdi — bu ham birinchi murojaati hisoblanadi, shuning uchun uni
    // shu yerda ham avtomatik mijoz sifatida ro'yxatga olamiz.
    await autoRegisterCustomer(db, token, msg, kbDebtor, welcomeText);
    await setMenuButtonFor(token, chatId, req, false).catch(() => {});
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
    try {
      await handleAdminCommand(db, token, settingsRef, admins, chatId, cmd, argStr, kb, req);
    } catch (e) {
      // YANGI: bitta buyruqdagi kutilmagan xatolik butun webhook'ni
      // "yiqitmasin" va admin javobsiz qolib ketmasin — xatolik konsolga
      // (Vercel loglariga) yoziladi, admin esa tushunarli xabar oladi.
      console.error(`Admin buyrug'i xatosi (${cmd}):`, e);
      await sendMessage(token, chatId, "⚠️ Buyruqni bajarishda kutilmagan xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring. Xatolik davom etsa, ma'lumotlar formatini tekshiring.").catch(() => {});
    }
    return;
  }
  await sendMessage(token, chatId, helpText(isAdmin), isAdmin ? { reply_markup: adminMenuKeyboard(req) } : { reply_markup: debtorMenuKeyboard(req, settingsData) });
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
    // TEZLASHTIRISH: to'g'ridan-to'g'ri settingsRef.get() o'rniga qisqa
    // muddatli (15 soniyalik) xotira-keshidan foydalaniladi — bot tez-tez
    // xabar qabul qilganda (bir nechta admin/mijoz ketma-ket yozganda)
    // Firestore'dan bir xil hujjatni qayta-qayta o'qimaslik uchun.
    const s = await getSettings(db);
    if (!s) { res.status(200).json({ ok: true }); return; }
    const token = (s.telegramBotToken || '').trim();
    if (!token) { res.status(200).json({ ok: true }); return; }
    const admins = Array.isArray(s.telegramAdmins) ? s.telegramAdmins : [];
    const sellers = Array.isArray(s.sellers) ? s.sellers : [];

    const upd = req.body;

    // YANGI: TAKRORLANISHNI OLDINI OLISH (idempotentlik). Vercel funksiyasi
    // sekinlashib ketsa yoki vaqtinchalik xato bersa, Telegram O'SHA update'ni
    // qayta-qayta yuborishga urinadi — buni oldini olmasak, masalan bitta
    // to'lov ikki marta qo'shilib ketishi yoki bitta xabar ikki marta
    // yuborilishi mumkin. Har bir update_id faqat BIR MARTA qayta ishlanadi.
    const updateId = upd && upd.update_id;
    if (updateId != null) {
      const dedupeRef = db.collection('telegramProcessedUpdates').doc(String(updateId));
      const dedupeSnap = await dedupeRef.get();
      if (dedupeSnap.exists) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      // Firestore'da "expiresAt" maydoniga TTL siyosati o'rnatilsa (Firebase
      // konsolida, ixtiyoriy), bu yozuvlar avtomatik tozalanadi — bo'lmasa
      // ham hech qanday amaliy zarar yo'q, faqat bitta kichik kolleksiya
      // o'sib boradi.
      await dedupeRef.set({
        processedAt: new Date().toISOString(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
    }

    await processUpdate(db, token, settingsRef, admins, sellers, upd, req, s);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook xatolik:', e);
    // Telegram'ga 200 qaytaramiz - aks holda u qayta-qayta shu xato bergan
    // update'ni takror yuborishga urinaveradi. Xato konsolga (Vercel loglariga) yoziladi.
    res.status(200).json({ ok: false, error: String(e) });
  }
};
