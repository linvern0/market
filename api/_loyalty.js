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

module.exports = { defaultLoyaltyTiers, getLoyaltyTiers, computeCustomerTier };
