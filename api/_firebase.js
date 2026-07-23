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

module.exports = { getDb, admin };
