// api/_permissions.js
// ----------------------------------------------------------------------------
// YANGI: batafsil admin huquqlari. Ilgari Telegram tomonda faqat 2 daraja
// bor edi — 'owner' (hamma narsaga ruxsat) va 'admin' (faqat bir nechta
// buyruq — OWNER_ONLY_COMMANDS — cheklangan), Mini App admin panelida esa
// (api/miniapp-action.js) BUTUNLAY farq yo'q edi: settings.telegramAdmins
// ro'yxatidagi HAR QANDAY odam (owner ham, admin ham) barcha amallarni
// (o'chirish, narx o'zgartirish, xodim boshqarish va h.k.) bemalol
// bajara olardi.
//
// Endi har bir telegramAdmins yozuvida ixtiyoriy `permissions` obyekti
// bo'lishi mumkin — agar bo'lmasa (yoki eski yozuv bo'lsa), rolga qarab
// standart ruxsatlar ishlatiladi (pastga qarang), shuning uchun ESKI
// ma'lumotlar bilan ham to'liq moslashuvchan.
//
// 'owner' har doim, hech qanday tekshiruvsiz — HAMMA narsaga ruxsatli.
// ----------------------------------------------------------------------------

// Har bir huquq kaliti va qisqa izohi — index.html'dagi sozlash oynasida
// ham xuddi shu ro'yxat ishlatiladi (checkboxlar uchun).
const PERMISSION_KEYS = [
  { key: 'manageProducts', label: 'Tovarlar (qo\'shish/tahrirlash/kirim)' },
  { key: 'manageDebts', label: 'Qarzlar (yozish/to\'lov qabul qilish)' },
  { key: 'manageCustomers', label: 'Mijozlar / COIN (tahrirlash, coin berish)' },
  { key: 'manageStaff', label: 'Xodimlar (sotuvchi qo\'shish/o\'chirish)' },
  { key: 'deleteRecords', label: 'O\'chirish (tovar, qarzdor, mijoz, xodim)' },
  { key: 'broadcast', label: 'Ommaviy xabarnoma yuborish' },
  { key: 'manageSettings', label: 'Sozlamalar (do\'kon, bildirishnoma, coin qoidasi)' },
  { key: 'manageAdmins', label: 'Adminlar ro\'yxatini boshqarish' },
];

// Oddiy 'admin' (owner emas) uchun standart ruxsatlar — kundalik ishni
// (sotish, qarz, mijoz) to'sib qo'ymaslik uchun ko'pchiligi yoqilgan,
// lekin xavfli/qaytarib bo'lmas amallar (o'chirish, admin boshqarish,
// ommaviy xabar) o'chirilgan holda keladi. Owner istalgan vaqt bularni
// index.html > "🔐 Adminlar va huquqlar" oynasidan o'zgartira oladi.
function defaultPermissionsForRole(role) {
  if (role === 'owner') {
    const all = {};
    PERMISSION_KEYS.forEach((p) => { all[p.key] = true; });
    return all;
  }
  return {
    manageProducts: true,
    manageDebts: true,
    manageCustomers: true,
    manageStaff: false,
    deleteRecords: false,
    broadcast: false,
    manageSettings: false,
    manageAdmins: false,
  };
}

// adminEntry — settings.telegramAdmins ichidagi bitta yozuv ({chatId, name,
// role, permissions?}). key — PERMISSION_KEYS dan biri.
function hasPermission(adminEntry, key) {
  if (!adminEntry) return false;
  const role = adminEntry.role || 'owner'; // eski yozuvlarda role bo'lmasa — owner deb hisoblanadi (avvalgi xatti-harakat)
  if (role === 'owner') return true;
  const perms = adminEntry.permissions && typeof adminEntry.permissions === 'object'
    ? adminEntry.permissions
    : defaultPermissionsForRole(role);
  if (Object.prototype.hasOwnProperty.call(perms, key)) return !!perms[key];
  return !!defaultPermissionsForRole(role)[key];
}

module.exports = { PERMISSION_KEYS, defaultPermissionsForRole, hasPermission };
