# Upgrade v8

## Algoritmlar
- `isThisWeek`: hafta haqiqatan dushanbadan boshlanadi (v7 hujjatida bor edi, kodda yo'q edi).
- `smartSearchProducts`: kirill/lotin, `o'`/`g'` tenglashtirish, ko'p so'zli AND qidiruv, tartiblangan natija, ombordagi tovar yuqorida.
- Sotuv qidiruvi: Enter eng mos tovarni qo'shadi; gridni qayta chizish 110 ms debounce.
- Qarz to'lovi (`fbApplyDebtPayment`) tekshirildi: tranzaksiya ichida, o'zgartirilmadi.

## Kompyuter UI/UX (>=1100px)
- Chap yon panel (Ctrl+B bilan yig'iladi), Alt+1..9 navigatsiya va yorliq belgilari.
- Sticky sarlavha va jadval boshi, hover effektlari, keng modal, dashboard 1.5fr/1fr, 1700px+ da kengroq maydon.
- Telefon/planshet ko'rinishi o'zgarmagan.

## Boshqa
- `sw.js` kesh versiyasi v8.

## Sinalmagan
Brauzerda vizual tekshiruv va haqiqiy Firebase oqimi. Avval test do'konda sinang.

## Qo'shimcha (3-bosqich)
- Tovarlar sahifasi va Qarzlar (ro'yxat + ikkinchi filtr) qidiruvi: kirill/lotin, `o'`/`g'` va ko'p so'zli moslik (`smartSearchProducts`, `smartTextMatch`). Tovarlar tartibi o'zgarmaydi.
- F2 — sotuv sahifasiga o'tib, qidiruv maydoniga fokus.
- PIN brute-force: mijoz tomonida blokirovka avvaldan bor (`getLoginLockState`), serverda hali yo'q.
