// api/_loyalty.js
// ----------------------------------------------------------------------------
// Sodiqlik dasturi darajalari (Bronza/Kumush/Oltin va h.k.) bilan bog'liq
// umumiy yordamchi funksiyalar. index.html (brauzer/admin panel),
// miniapp.html (Telegram mini-ilova) va shu papkadagi boshqa API fayllari
// BIR XIL mantiqni ishlatishi uchun shu yerda markazlashtirilgan.
//
// Darajalar ro'yxati endi kodga QATTIQ yozilmagan — admin uni
// index.html'dagi "🏆 Darajalarni sozlash" oynasidan o'zi belgilaydi va
// Firebase'da (dokon/settings > loyaltyTiers) saqlanadi. Agar hali
// sozlanmagan bo'lsa (masalan eski do'konlar uchun), pastdagi standart
// ro'yxat ishlatiladi.
// ----------------------------------------------------------------------------

function defaultLoyaltyTiers() {
  return [
    { id: 'bronze', name: 'Bronza', emoji: '🥉', threshold: 0, color: '#16a34a' },
    { id: 'silver', name: 'Kumush', emoji: '🥈', threshold: 500000, color: '#2563eb' },
    { id: 'gold', name: 'Oltin', emoji: '🥇', threshold: 2000000, color: '#d97706' },
  ];
}

function getLoyaltyTiers(settings) {
  const tiers = settings && Array.isArray(settings.loyaltyTiers) ? settings.loyaltyTiers : [];
  return (tiers.length ? tiers : defaultLoyaltyTiers()).slice().sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
}

// `override` mijozning c.tierOverride qiymati (bo'sh bo'lsa — avtomatik,
// jami xariddan hisoblanadi). Natija: { id, label, idx } — idx darajalar
// ro'yxatidagi o'rni (past → yuqori), tier o'zgarishi yuqorilaganmi yoki
// pastlaganmi shu orqali aniqlanadi.
function computeCustomerTier(totalSpent, override, settingsOrTiers) {
  const tiers = Array.isArray(settingsOrTiers) ? (settingsOrTiers.length ? settingsOrTiers : defaultLoyaltyTiers()) : getLoyaltyTiers(settingsOrTiers);
  const sorted = tiers.slice().sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
  if (override) {
    const found = sorted.find((t) => t.id === override);
    if (found) return { id: found.id, label: `${found.emoji || ''} ${found.name || ''}`.trim(), idx: sorted.indexOf(found) };
  }
  let cur = sorted[0];
  sorted.forEach((t) => { if ((totalSpent || 0) >= (t.threshold || 0)) cur = t; });
  return { id: cur.id, label: `${cur.emoji || ''} ${cur.name || ''}`.trim(), idx: sorted.indexOf(cur) };
}

function defaultCoinSettings() {
  // earnPerAmount: necha so'mlik xariddan 1 COIN beriladi (mahsulotda
  // alohida belgilanmagan bo'lsa ishlatiladigan standart qoida).
  // redeemValuePerCoin: 1 COIN qancha so'mlik qiymatga teng (mahsulotda
  // "coinda sotib olish narxi" alohida belgilanmagan bo'lsa, standart
  // narx/redeemValuePerCoin formula bilan hisoblanadi).
  return { earnPerAmount: 10000, redeemValuePerCoin: 100 };
}

function getCoinSettings(settings) {
  const s = (settings && settings.coinSettings) || {};
  const def = defaultCoinSettings();
  const earnPerAmount = Number(s.earnPerAmount) > 0 ? Number(s.earnPerAmount) : def.earnPerAmount;
  const redeemValuePerCoin = Number(s.redeemValuePerCoin) > 0 ? Number(s.redeemValuePerCoin) : def.redeemValuePerCoin;
  return { earnPerAmount, redeemValuePerCoin };
}

// Bitta mahsulotni COIN evaziga sotib olish uchun kerakli COIN miqdorini
// hisoblaydi: agar mahsulotda alohida "coinCost" belgilangan bo'lsa — shuni
// ishlatadi, aks holda narxdan (settings.coinSettings.redeemValuePerCoin
// orqali) avtomatik hisoblaydi.
function productCoinCost(product, settings) {
  if (product && (product.coinCost || product.coinCost === 0) && Number(product.coinCost) > 0) {
    return Math.round(Number(product.coinCost));
  }
  const { redeemValuePerCoin } = getCoinSettings(settings);
  return Math.max(1, Math.ceil((product && product.price || 0) / redeemValuePerCoin));
}

// ============ YANGI: COIN FUNKSIYASINI GLOBAL YOQISH/O'CHIRISH ============
// Admin index.html > "🏆 Darajalarni sozlash" oynasidan bitta tugma bilan
// COIN dasturini butunlay o'chirib qo'yishi mumkin. O'chirilganda:
//  - index.html: coin bilan bog'liq maydonlar/panellar yashiriladi
//  - Telegram bot: /coinlarim, /ballarim buyruqlari va COINGA SOTIB OLISH
//    oqimi ishlamaydi, foydalanuvchiga tushunarli xabar qaytariladi
//  - Mini App: coin balans/coinga sotib olish bo'limi ko'rinmaydi va
//    create_coin_order kabi amallar rad etiladi
// Standart holat — YOQILGAN (true), orqaga moslik uchun (eski do'konlarda
// maydon umuman bo'lmaydi, shu sabab "aniq false" bo'lmasa yoqilgan deb
// hisoblanadi).
function isCoinEnabled(settings) {
  return !(settings && settings.coinEnabled === false);
}

module.exports = {
  defaultLoyaltyTiers, getLoyaltyTiers, computeCustomerTier,
  defaultCoinSettings, getCoinSettings, productCoinCost, isCoinEnabled,
};
