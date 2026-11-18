// api/_audit.js
// ----------------------------------------------------------------------------
// YANGI (Xavfsizlik/rollar kengaytmasi): "Amallar jurnali" (audit log).
// Do'konda bir nechta admin/xodim ishlaganda, kim nima qilganini keyinroq
// bilish uchun har bir muhim (o'zgartiruvchi/o'chiruvchi) amal shu yerda
// bitta umumiy 'actionLogs' to'plamiga yoziladi — Telegram bot orqali
// bo'ladimi, Mini App admin panelidan bo'ladimi yoki asosiy index.html
// panelidan bo'ladimi, farqi yo'q, hammasi bir joyda ko'rinadi.
//
// Har bir yozuv: { id, ts (ISO), source ('bot'|'miniapp'|'panel'),
//   actorName, actorChatId, action, detail }
//
// Log yozish HECH QACHON asosiy amalni to'xtatmasligi kerak — shuning
// uchun har doim try/catch bilan, xatolik bo'lsa faqat konsolga chiqariladi.
// ----------------------------------------------------------------------------

function uid() { return Date.now().toString(36) + require('crypto').randomBytes(5).toString('hex'); }

async function logAction(db, { source, actorName, actorChatId, action, detail }) {
  try {
    const entry = {
      id: uid(),
      ts: new Date().toISOString(),
      source: source || 'panel',
      actorName: actorName || 'Noma\'lum',
      actorChatId: actorChatId ? String(actorChatId) : '',
      action: action || '',
      detail: detail || '',
    };
    await db.collection('actionLogs').doc(entry.id).set(entry);
    return entry;
  } catch (e) {
    console.error('Amallar jurnaliga yozishda xatolik (amalning o\'ziga ta\'sir qilmaydi):', e);
    return null;
  }
}

module.exports = { logAction };
