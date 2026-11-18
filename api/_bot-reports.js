// api/_bot-reports.js
// Telegram bot hisobotlari uchun sof (Firebase'ga bog'liq bo'lmagan) yordamchilar.
// Barcha sanalar DO'KON VAQT ZONASIDA (settings.timezone, standart Asia/Tashkent)
// hisoblanadi — ilgari bot UTC bo'yicha hisoblardi va tungi savdolar noto'g'ri
// kunga tushib qolardi.
'use strict';

const DEFAULT_TZ = 'Asia/Tashkent';
const PAY_LABELS = { cash: '💵 Naqd', card: '💳 Karta', click: '📱 Click', payme: '📱 Payme', uzum: '📱 Uzum', transfer: "🏦 O'tkazma" };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (n) => { const v = Math.round(Number(n) || 0); return (v === 0 ? 0 : v).toLocaleString('ru-RU').replace(/,/g, ' '); };

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ }); return tz || DEFAULT_TZ; } catch (e) { return DEFAULT_TZ; }
}
// ISO vaqt (yoki YYYY-MM-DD) -> do'kon zonasidagi YYYY-MM-DD
function tzDate(value, tz) {
  const s = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: safeTz(tz) });
}
function tzTime(value, tz) {
  const d = new Date(String(value || ''));
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('en-GB', { timeZone: safeTz(tz), hour: '2-digit', minute: '2-digit', hour12: false });
}
function todayStr(tz, now) { return tzDate((now || new Date()).toISOString(), tz); }
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function monthStart(dateStr) { return dateStr.slice(0, 8) + '01'; }
function prevMonthRange(dateStr) {
  const first = monthStart(dateStr);
  const to = addDays(first, -1);
  return { from: monthStart(to), to };
}
// kind: 'day' | 'week' | 'month'
function periodRange(kind, tz, now) {
  const today = todayStr(tz, now);
  if (kind === 'week') {
    return { from: addDays(today, -6), prevFrom: addDays(today, -13), prevTo: addDays(today, -7), to: today, label: 'Oxirgi 7 kunlik hisobot', vs: 'oldingi haftaga nisbatan' };
  }
  if (kind === 'month') {
    const pm = prevMonthRange(today);
    return { from: monthStart(today), prevFrom: pm.from, prevTo: pm.to, to: today, label: 'Joriy oy hisoboti', vs: 'oldingi oyga nisbatan' };
  }
  const y = addDays(today, -1);
  return { from: today, prevFrom: y, prevTo: y, to: today, label: 'Bugungi hisobot', vs: 'kechagiga nisbatan' };
}
const inRange = (s, from, to, tz) => { const d = tzDate(s.date, tz); return d >= from && d <= to; };
const live = (sales) => (sales || []).filter((s) => s && !s.reverted);
const lineProfit = (s) => ((Number(s.price) || 0) - (Number(s.cost) || 0)) * (Number(s.qty) || 0);

// Sotuv qatorlarini cheklar (receiptId) bo'yicha guruhlash
function groupReceipts(sales) {
  const map = new Map();
  for (const s of live(sales)) {
    const key = s.receiptId || s.id;
    if (!map.has(key)) map.set(key, { id: key, date: s.date, seller: s.seller || '—', payMethod: s.payMethod || 'cash', isDebt: !!s.isDebt, debtorName: s.debtorName || '', total: 0, profit: 0, items: [] });
    const r = map.get(key);
    r.total += Number(s.total) || 0; r.profit += lineProfit(s);
    r.items.push({ name: s.productName || '?', qty: Number(s.qty) || 0 });
    if (s.date && (!r.date || s.date < r.date)) r.date = s.date;
  }
  return [...map.values()];
}

// /kassa — bir kunlik pul oqimi va sotuvchilar kesimi
function summarizeDay(sales, day, tz) {
  const rows = live(sales).filter((s) => tzDate(s.date, tz) === day);
  const receipts = groupReceipts(rows);
  const cash = receipts.filter((r) => !r.isDebt), debt = receipts.filter((r) => r.isDebt);
  const sum = (a, k) => a.reduce((t, r) => t + r[k], 0);
  const bySeller = new Map();
  for (const r of receipts) {
    const b = bySeller.get(r.seller) || { seller: r.seller, count: 0, total: 0, profit: 0 };
    b.count += 1; b.total += r.total; b.profit += r.profit; bySeller.set(r.seller, b);
  }
  const byMethod = new Map();
  for (const r of cash) { const m = r.payMethod || 'cash'; const b = byMethod.get(m) || { method: m, count: 0, total: 0 }; b.count += 1; b.total += r.total; byMethod.set(m, b); }
  return {
    byMethod: [...byMethod.values()].sort((a, b) => b.total - a.total),
    day, receiptCount: receipts.length,
    cashCount: cash.length, cashTotal: sum(cash, 'total'),
    debtCount: debt.length, debtTotal: sum(debt, 'total'),
    total: sum(receipts, 'total'), profit: sum(receipts, 'profit'),
    avg: receipts.length ? sum(receipts, 'total') / receipts.length : 0,
    sellers: [...bySeller.values()].sort((a, b) => b.total - a.total),
  };
}

function topProducts(sales, limit) {
  const map = new Map();
  for (const s of live(sales)) {
    const k = s.productId || s.productName || '?';
    const p = map.get(k) || { name: s.productName || '?', qty: 0, revenue: 0, profit: 0 };
    p.qty += Number(s.qty) || 0; p.revenue += Number(s.total) || 0; p.profit += lineProfit(s); map.set(k, p);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit || 10);
}

function kassaText(sum, shopName, tz) {
  let t = `💵 <b>Kassa — ${esc(shopName)}</b>\n📅 ${esc(sum.day)}\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
  if (!sum.receiptCount) return t + 'Bugun hali savdo bo\'lmagan.';
  t += `🧾 Cheklar: <b>${sum.receiptCount} ta</b>  (o'rtacha ${fmt(sum.avg)} so'm)\n`;
  t += `💰 Jami savdo: <b>${fmt(sum.total)} so'm</b>\n`;
  t += `   ├ ✅ To'langan: ${fmt(sum.cashTotal)} so'm (${sum.cashCount} ta)\n`;
  t += `   └ 📝 Nasiyaga: ${fmt(sum.debtTotal)} so'm (${sum.debtCount} ta)\n`;
  if (sum.byMethod && sum.byMethod.length) {
    t += `\n💳 <b>To'lov turlari</b>\n`;
    sum.byMethod.forEach((m) => { t += `${PAY_LABELS[m.method] || esc(m.method)} — ${fmt(m.total)} so'm (${m.count} ta)\n`; });
  }
  t += `📈 Foyda: <b>${fmt(sum.profit)} so'm</b>\n`;
  if (sum.sellers.length) {
    t += `\n👤 <b>Sotuvchilar</b>\n`;
    sum.sellers.forEach((s, i) => { t += `${i + 1}. ${esc(s.seller)} — ${fmt(s.total)} so'm (${s.count} ta chek)\n`; });
  }
  return t.trimEnd();
}
function receiptsText(receipts, shopName, tz, limit) {
  const list = receipts.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit || 10);
  let t = `🧾 <b>So'nggi sotuvlar — ${esc(shopName)}</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
  if (!list.length) return t + 'Bugun hali savdo bo\'lmagan.';
  for (const r of list) {
    const names = r.items.slice(0, 3).map((i) => `${esc(i.name)} ×${i.qty}`).join(', ') + (r.items.length > 3 ? ` +${r.items.length - 3}` : '');
    t += `🕒 ${tzTime(r.date, tz)} · ${esc(r.seller)}${r.isDebt ? ' · 📝 ' + esc(r.debtorName || 'nasiya') : ' · ' + (PAY_LABELS[r.payMethod] || '💵 Naqd')}\n   ${names}\n   <b>${fmt(r.total)} so'm</b>\n\n`;
  }
  return t.trimEnd();
}
function topProductsText(list, days, shopName) {
  let t = `🏆 <b>TOP tovarlar — ${days} kun</b> (${esc(shopName)})\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n`;
  if (!list.length) return t + 'Bu davrda savdo bo\'lmagan.';
  const medals = ['🥇', '🥈', '🥉'];
  list.forEach((p, i) => { t += `${medals[i] || (i + 1) + '.'} ${esc(p.name)}\n    ${p.qty} dona · ${fmt(p.revenue)} so'm · foyda ${fmt(p.profit)}\n`; });
  return t.trimEnd();
}

module.exports = { DEFAULT_TZ, esc, fmt, safeTz, tzDate, tzTime, todayStr, addDays, periodRange, inRange, live, lineProfit, groupReceipts, summarizeDay, topProducts, kassaText, receiptsText, topProductsText };
