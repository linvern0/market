// api/_firebase.js
// ----------------------------------------------------------------------------
// Barcha serverless funksiyalar (telegram-webhook, miniapp-data, miniapp-action,
// notify-cron) uchun UMUMIY Firebase Admin ulanish nuqtasi. Ilgari har bir
// fayl o'zining getDb() funksiyasiga ega edi va Firebase'ga ulanolmasa,
// sababi noaniq ("FIREBASE_SERVICE_ACCOUNT env var topilmadi") bo'lardi.
// Endi bitta joyda - aniqroq xatolik xabarlari va eng ko'p uchraydigan
// muammoni (private_key ichidagi "\n" larning noto'g'ri formatlanishi)
// avtomatik tuzatish bilan.
// ----------------------------------------------------------------------------

const admin = require('firebase-admin');

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT env var topilmadi. Yechim: Vercel -> loyihangiz -> " +
      "Settings -> Environment Variables bo'limiga FIREBASE_SERVICE_ACCOUNT nomi bilan " +
      "Firebase xizmat hisobi (service account) JSON faylining TO'LIQ mazmunini qo'shing " +
      "(Firebase konsoli -> Project Settings -> Service accounts -> Generate new private key), " +
      "keyin Deployments bo'limidan loyihani QAYTA deploy qiling (Redeploy) - env var qo'shilgach " +
      "avtomatik yangilanmaydi."
    );
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT JSON formatida xato: ' + e.message + '. Firebase konsolidan ' +
      "yuklab olingan .json faylning TO'LIQ va O'ZGARTIRILMAGAN mazmunini (boshidagi { dan " +
      'oxirgi } gacha, hech narsa qo\'shmasdan/kesmasdan) Vercel env var qiymati sifatida joylashtiring.'
    );
  }
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT JSON to'liq emas (project_id / private_key / client_email " +
      'maydonlaridan biri topilmadi). Firebase konsoli -> Project Settings -> Service accounts -> ' +
      '"Generate new private key" orqali olingan faylni qaytadan (to\'liq holda) joylashtiring.'
    );
  }
  // Eng ko'p uchraydigan xato: private_key ichidagi "\n" qator ko'chirish
  // belgilari ba'zi joylarda (masalan qo'lda nusxalashda) ekranlanmagan
  // ("\\n" emas, oddiy matn "\n") holda qolib ketadi va Firebase kalitni
  // noto'g'ri PEM deb topadi. Shu holatni avtomatik tuzatamiz.
  if (serviceAccount.private_key.includes('\\n') && !serviceAccount.private_key.includes('\n')) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  return serviceAccount;
}

let firebaseApp = null;
function getDb() {
  if (!firebaseApp) {
    firebaseApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()) });
  }
  return admin.firestore();
}

// ----------------------------------------------------------------------------
// TEZLASHTIRISH / FIRESTORE YUKINI KAMAYTIRISH: 'dokon/settings' hujjati
// deyarli HAR BIR so'rovda (bot xabari, Mini App ochilishi, admin amali)
// kamida bir marta, ba'zan bitta so'rov ichida BIR NECHA MARTA o'qilardi
// (masalan telegram-webhook.js'da eng tepada bir marta, keyin ba'zi yordamchi
// funksiyalar ichida yana bir marta). Bundan tashqari, Vercel serverless
// funksiyasi "issiq" (warm) qolganda (qisqa vaqt ichida ketma-ket so'rovlar
// kelganda — masalan bir nechta xabar tez-tez yozilganda) har safar qayta
// o'qilardi, garchi qiymat deyarli hech qachon shu qisqa vaqt ichida
// o'zgarmasa ham.
//
// Yechim: 15 soniyalik juda qisqa muddatli xotira-keshi (in-memory cache).
// Bu muddat shu qadar qisqaki, admin sozlamani o'zgartirgandan keyin ham
// amaliy jihatdan sezilarli kechikish bo'lmaydi — ustiga, quyidagi
// invalidateSettingsCache() har bir yozishdan (settingsRef.set/update) keyin
// chaqirilib, keshni darhol eskirgan deb belgilaydi, shunda o'zgarish
// KEYINGI o'qishda darhol (15 soniyani kutmasdan) qo'llanadi.
let settingsCache = null; // { data, fetchedAt }
const SETTINGS_CACHE_TTL_MS = 15000;

async function getSettings(db, opts) {
  const force = opts && opts.force;
  const now = Date.now();
  if (!force && settingsCache && (now - settingsCache.fetchedAt) < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.data;
  }
  const snap = await db.collection('dokon').doc('settings').get();
  const data = snap.exists ? snap.data() : null;
  settingsCache = { data, fetchedAt: now };
  return data;
}
function invalidateSettingsCache() { settingsCache = null; }

// ----------------------------------------------------------------------------
// YANGI (Firestore usage'ni yanada kamaytirish): 'products' va 'debtors'
// kolleksiyalari ko'p bot buyruqlarida va Mini App har bir ochilishida
// BUTUNLIGICHA (getDocs/`.get()`, filtrsiz) o'qiladi — masalan bot
// buyruqlari (/ombor, /mahsulot, /tovar_narx, /eslatma, mijozni telefon/
// username bo'yicha izlash) va Mini App'ning asosiy ma'lumot so'rovi HAR
// SAFAR shu ikki kolleksiyani to'liq qayta o'qiydi, garchi ular odatda
// FAQAT admin tovar/mijoz qo'shganda, tahrirlaganda yoki narx/zaxirani
// o'zgartirganda o'zgarsa ham.
//
// 'settings' keshi bilan BIR XIL mantiq: juda qisqa muddatli (15 soniyalik)
// xotira-kesh + har bir yozishdan (create/update/delete) keyin darhol
// eskirgan deb belgilash — shunda admin o'zi qilgan o'zgarish HECH QACHON
// 15 soniyaga ham kechikmaydi, faqat qisqa vaqt ichida ketma-ket kelgan
// so'rovlar (bot xabarlari, Mini App tez-tez ochilishi) Firestore'dan
// qayta-qayta emas, xotiradan o'qiladi.
//
// MUHIM: 'customers' kolleksiyasi ATAYLAB shu keshga KIRITILMAGAN — u har
// bir sotuvda (ball/coin yangilanganda) yoziladi, shuning uchun keshlash
// amaliy foyda bermaydi va mijozga eskirgan ball ko'rsatish xavfini oshiradi.
function makeCollectionCache(collectionName, ttlMs) {
  let cache = null; // { docs, fetchedAt }
  async function get(db, opts) {
    const force = opts && opts.force;
    const now = Date.now();
    if (!force && cache && (now - cache.fetchedAt) < ttlMs) {
      return { docs: cache.docs, empty: cache.docs.length === 0, size: cache.docs.length };
    }
    const snap = await db.collection(collectionName).get();
    cache = { docs: snap.docs, fetchedAt: now };
    return snap;
  }
  function invalidate() { cache = null; }
  return { get, invalidate };
}

const PRODUCTS_CACHE_TTL_MS = 15000;
const DEBTORS_CACHE_TTL_MS = 15000;
const productsCache = makeCollectionCache('products', PRODUCTS_CACHE_TTL_MS);
const debtorsCache = makeCollectionCache('debtors', DEBTORS_CACHE_TTL_MS);

async function getProductsSnapshot(db, opts) { return productsCache.get(db, opts); }
function invalidateProductsCache() { productsCache.invalidate(); }
async function getDebtorsSnapshot(db, opts) { return debtorsCache.get(db, opts); }
function invalidateDebtorsCache() { debtorsCache.invalidate(); }

module.exports = {
  getDb, admin, getSettings, invalidateSettingsCache,
  getProductsSnapshot, invalidateProductsCache,
  getDebtorsSnapshot, invalidateDebtorsCache,
};
