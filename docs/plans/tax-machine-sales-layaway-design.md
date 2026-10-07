# Tax holidays, shop-pays-the-tax sales, machine sales with warranty, layaway and financing: design

7 Oct 2026. **Owner, 7 Oct 2026: build it, every question answered as recommended (section 7).** Being built on
branch `sales-features` (off `scheduling-features`). Everything here ships **after the test month**
(launch first, HANDOFF item 19). Questions for the owner are in section 7; the recommended answer is listed first.

What exists today (so nothing is designed twice):
- Tax: one rate per shop (`Shop.taxRatePct`), a `taxable` flag per sale line, tax-exempt customers with a certificate
  (`src/lib/tax-exempt.ts`; the sale keeps `taxExemptId` and `taxRatePct`), a processor's own tax amount for online
  orders, and returns taxed as the original sale was (7 Oct fix). One rate per sale.
- Machines for sale: `StockUnit` (one row per serial: condition, cost, asking price, warranty months, who stands behind
  it, warranty end, registration with the maker, trade-in, return capped at what the buyer paid). **Only in the Vac
  Shop module** (`src/lib/vac/units.ts`, `/vac/units`, `requireModule(user, "vac")`).
- Customer credit: store credit and gift cards on one ledger (`GiftCard` kind `credit` / `gift`), in the books and the
  liability report. No layaway, no house accounts, no financing tender.

## 1. Sales tax holidays

Some states suspend sales tax for a few days a year on some items. Massachusetts, the nearest: **8 and 9 August 2026**,
the 6.25% tax off most items for personal use priced **$2,500 or less per item** (a dearer item is taxed in full), and
every Massachusetts seller must take part
([mass.gov FAQ](https://www.mass.gov/info-details/massachusetts-sales-tax-holiday-frequently-asked-questions),
[Sovos](https://sovos.com/regulatory-updates/sut/massachusetts-announces-dates-for-2026-sales-tax-holiday/)).
Rhode Island has none planned for 2026
([Sales Tax Handbook](https://www.salestaxhandbook.com/rhode-island/sales-tax-holidays)). Other states run
back-to-school, hurricane or Energy Star holidays with their own item lists
([TaxCloud 2026 list](https://taxcloud.com/blog/sales-tax-holidays-2026/)).

**Design**
- A shop sets up a **tax holiday**: name ("Massachusetts tax-free weekend"), first and last day (in the shop's time
  zone, whole days), which items it covers (all taxable items, or chosen kinds: fabric, notions, machines, parts,
  patterns...; classes and services left out by default), and a **per-item price limit** (blank = none). Rule for the
  limit, as Massachusetts and most states do it: a line whose price per unit after its own discount is over the limit is
  taxed in full; at or under, not taxed.
- **Presets** for the states we know (Massachusetts first) fill the form in; the shop confirms the dates each year
  (they're set by law each year, sometimes late). A reminder in the program two weeks before a preset's usual month:
  "Is Massachusetts' tax-free weekend on this year? Confirm the dates."
- **At the register** during a holiday: covered lines show "Tax holiday" instead of the tax; the receipt prints the
  holiday's name. Nothing to tick: the register applies it by date. The cashier can still charge tax on a line
  ("Charge tax anyway", as for exempt customers) for an item the state excludes that the kind didn't catch.
- **Layaway and holidays** (the Streamlined rule most states follow): an item is tax free if it's chosen and the
  layaway accepted during the holiday, or if the last payment and pickup fall in it. Section 4 records both dates.
- **Online shop and booking**: the same rule by order date.
- **Returns**: given back as sold (already the rule since 7 Oct): an item bought tax free returns tax free.
- **Reports**: the sales tax report lists holiday sales apart (states ask for exempt sales on the return).

**Data**: `TaxHoliday` (shopId, name, state preset key, firstDay, lastDay, kinds[], maxUnitCents, active) and on
`SaleLine` a `taxNote` (null, `exempt`, `holiday:<id>`, `included`) so receipts, returns and reports know why a line
had no tax. About 1.5 days.

## 2. Shop-pays-the-tax sales ("tax included")

What the shop means: the customer pays the sticker price and the shop pays the state out of it. The tax is still owed:
it's **backed out of the price** (a $1,000 machine at 7% is $934.58 plus $65.42 tax), exactly as club payments already
work ("price includes tax", `src/lib/club-books.ts`). The books and the tax report show the real tax.

**The law differs by state, and it's about advertising.** Massachusetts, Connecticut, Virginia and Nebraska forbid a
seller to advertise or say that it will pay or absorb the tax
([Mass. ch. 64I sec. 24](https://servanda.ai/law/massachusetts/massachusetts-general-laws-chapter-64i-section-24),
[Connecticut DRS](https://portal.ct.gov/DRS/Publications/Informational-Publications/2009/IP-200911-Unlawful-Advertisements-Referring-to-Sales-Tax),
[Virginia](https://www.tax.virginia.gov/laws-rules-decisions/rulings-tax-commissioner/07-32),
[Nebraska](https://revenue.nebraska.gov/sites/default/files/doc/info/6-493.pdf)); Pennsylvania and Texas now allow it
with conditions ([Avalara](https://www.avalara.com/blog/en/north-america/2019/07/retailers-in-pennsylvania-and-texas-can-absorb-sales-tax.html)).
Rhode Island: a lawyer question. In the states that forbid it, a shop can still simply lower the price.

**Design**
- Part of a small **promotions** feature (scheduled sales), since shops will want the same scheduling for plain
  sales: a promotion has a name, first and last day, what it covers (kinds, brands, chosen items, or machines for
  sale), and one effect: percent off, amount off, or **tax included**.
- Tax included on a line: the line's price is treated as tax-inclusive; the tax is worked out of it at the shop's rate
  and shown on the receipt as "Price includes $65.42 sales tax" (the wording a state that allows it expects; never
  "we pay your tax").
- Off by default, behind a setting with the warning: "Some states forbid advertising that you pay the sales tax
  (Massachusetts, Connecticut, Virginia, Nebraska). Check your state's rule before you use this."
- Percent and amount off use the register's existing line discount, so returns and reports already handle them.
- Fits the one-rate-per-sale rule: a tax-included line is taxed at the same rate, just counted from the other end.

**Data**: `Promotion` (shopId, name, firstDay, lastDay, scope JSON, effect, value, active) and `SaleLine.promotionId`.
About 2 days, including the register's price display.

## 3. Machine sales with warranty for every shop

Open the Vac Shop's machines-for-sale to sewing, embroidery, serger, quilting and longarm machines (and any shop kind).
The code is general already: `StockUnit` hangs off a `Machine`, which has a kind.

**Design**
- Move the unit pages from `/vac/units` to **Machines for sale** (`/units`), shown to every shop; the Vac Shop module
  keeps its vacuum-specific extras (bags due). Owner question 1: in the base price, or a module.
- What sewing dealers need on top of the vacuum version:
  - **What comes with it**: a bundle on the unit (accessories, software, a cabinet discount) printed on the receipt.
  - **Owner's classes**: dealers give new-machine "guide classes". A sale can grant class credits (e.g. 3 guide
    classes), booked through the classes module; the receipt says so; the customer page shows what's left.
  - **The shop's own service plan**: e.g. "free cleaning yearly for 3 years" or an extended warranty sold as a line.
    The plan sits on the machine; a repair ticket for that machine shows "Covered: free cleaning (1 of 3 used)" and
    the ticket's labour can be marked covered (zero charge, kept for the report).
  - **Warranty at intake**: a repair ticket for a machine sold here shows "Sold here 12 Mar 2026, maker's warranty
    until ..., registered / not registered", so the tech knows before quoting. Uses the serial and the existing
    `warrantyUntil`.
  - **Registration reminder**: an unregistered unit sold more than 7 days ago shows on the dashboard ("Register these
    with the maker"), with the maker's registration page when we have it.
  - **Maker warranty terms** as the shop types them (parts years, labour years, electronics years); no built-in
    claims about any maker's warranty.
- Trade-ins, returns, the receipt notes and the four tabs work as they do for vacuums.

About 2 days (most of it moving and renaming, plus class credits and service plans).

## 4. Layaway

Common at sewing dealers: about 10% down, equal payments over about 3 months, the machine held until paid
([example terms](https://www.kenssewingcenter.com/financing-available)). Several states require written layaway terms
and set refund rules on cancelling: a lawyer question before shops use it.

**Design**
- **Start a layaway** at the register: customer, items (a machine for sale is set to HELD so nobody else sells it; a
  stock item's quantity is reserved), the deposit (the shop's minimum, default 10%), the term (default 90 days) and
  the payment plan (equal payments every 2 weeks or monthly, shown with dates). The customer signs the printed terms
  (the shop's own wording, with a default to adapt).
- **Payments** are taken at the register against the layaway (any tender, store credit included). Money in is
  **customer deposits**, a liability in the books, not a sale yet.
- **Complete**: the last payment turns the layaway into the sale (items, tax at the rate on that day, or the holiday's
  rule from section 1), the deposits pay it, and the customer takes the machine. The warranty starts that day.
- **Cancel**: by the shop's policy (setting: refund all, keep a fee of $X or Y%, or refund as store credit). The
  machine goes back on sale.
- **Overdue**: a missed payment shows on the dashboard; the messaging module sends a friendly reminder if it's on.
- **Reports**: open layaways and the deposits held (the liability total must match the books).

**Data**: `Layaway` (shopId, number, customerId, status OPEN / COMPLETED / CANCELLED, startedAt, dueBy, planJson,
depositMinCents, feeRule, saleId when done), `LayawayLine`, `LayawayPayment` (amount, tender, paidAt, the register
receipt it printed on). About 3 days.

## 5. Financing (Synchrony, Affirm and the like)

Dealers offer Synchrony's "Sewing & More" card (no interest for 6 to 12 months on approval) and Affirm, Sezzle, PayPal
Pay in 4 ([example](https://www.sewingmachineoutlet.com/pages/sewing-machine-financing),
[another](https://www.altonsewingmachine.com/synchrony-financing)). The lender pays the shop; the customer owes the
lender. We don't integrate with any lender (each needs its own merchant agreement); we make it easy to record:
- A **Financed** tender at the register with the lender's name (the shop lists its lenders in settings) and the
  approval number. The sale is complete; the money is **owed by the lender** until the shop marks it paid (or the
  books export shows it as a receivable from that lender).
- The shop's "apply now" link per lender, shown on the receipt and on the online shop's machine pages.
- A report: financed sales by lender, and which ones the lender hasn't paid yet.

About 1 day. **House accounts** (the shop lets a customer charge and pay monthly) are left out: rare in sewing retail,
and they bring statements, late fees and collections. Store credit and layaway cover most of the need.

## 6. Order and size

1. Machines for sale for every shop (section 3): about 2 days. Most asked for, and layaway builds on it.
2. Layaway (section 4): about 3 days.
3. Tax holidays (section 1): about 1.5 days; before 1 August 2027 for Massachusetts shops.
4. Financing tender (section 5): about 1 day.
5. Promotions with tax included (section 2): about 2 days, after the lawyer's answer for the owner's states.

About 9.5 days in all, each on its own branch off the release, each with checks and a browser spec.

## 7. Questions for the owner

1. Machines for sale (section 3) in the base price, or part of a module? **Recommended: base**, every dealer sells
   machines; the Vac Shop module keeps the vacuum extras.
2. Owner's classes granted with a machine: build now with section 3, or later? **Recommended: now** (small, and a
   selling point for dealers).
3. Layaway defaults: 10% down, 90 days, payments every 2 weeks, cancel fee $0 with refund as store credit? **Recommended:
   yes**, every one a shop setting.
4. Tax at layaway completion uses that day's rate (and holiday rule)? **Recommended: yes** (the common rule; lawyer to
   confirm for RI and MA).
5. Shop-pays-the-tax: build it (off by default, with the state warning), or only percent and amount off?
   **Recommended: build it off by default**, and ask the lawyer about Rhode Island.
6. Tax holiday presets: Massachusetts only first, or every state with a holiday? **Recommended: Massachusetts first**,
   others as shops in those states join (each state's item list differs and changes yearly).
7. Financing: record-only tender as above, or wait for a real integration? **Recommended: record-only now.**
8. House accounts: leave out? **Recommended: leave out.**
9. Service plans (free cleanings, extended warranty) as a shop-defined product? **Recommended: yes, with section 3.**
10. Order of building (section 6)? **Recommended: as listed.**

## Built

**Section 3, machines for sale for every shop (7 Oct 2026, branch `sales-features`).** Migration
`20261019000000_machine_sales`. The unit code moved from `src/lib/vac/` to `src/lib/units/` (`units.ts`,
`sale-units.ts`, `plans.ts`, `types.ts`), `src/actions/units.ts`, `src/components/units/`; pages at `/units` and
`/units/[id]` (old `/vac/units` links redirect, tab and search kept); "Machines for sale" in the menu for shops with a
counter; Settings → "Plans and warranties" (`/settings/sales`). Check: `scripts/checks/machine-sales.check.ts` (7 groups);
`vac-units`, `customer-merge`, `modules-tenant`, `move-export`, `audit-log` and `reports` checks still pass.
Decisions made while building:
- The gate is per kind, not per module: a sewing machine sells with no module (base price, answer 1); a vacuum or an
  appliance sells and trades in only while its module allows new work (`requireEquipment`), returns always. The "Add"
  form picks the kind (only the kinds the shop can take new work for); a trade-in at the register says its kind (older
  registers that send none mean a vacuum).
- Owner's classes are a count on the unit (`StockUnit.classCredits`), used by a class seat (`Enrollment.creditUnitId`,
  the seat free); the customer's page and the class's sign-up list show what is left. A return of the machine takes the
  unused ones away. No separate credit table, so no new customer column to merge.
- Service plans (`ServicePlan`, copied to the machine as `MachinePlan` when sold): sold as a register line for a machine
  on the same sale or one of the customer's machines, or included with a unit. A visit is a ticket with a covered line;
  covering keeps the would-be price (`TicketLine.coveredCents`) and is audited (`ticket.covered`). A void or a return
  ends the plans; voiding the return starts them again. A plan is not returned at the register: an owner ends it on the
  machine's page and refunds by a misc line (said on the screen). Plans are untaxed by default (the shop ticks it).
- Maker warranty terms are per brand (`MakerWarranty`), with the maker's registration page, shown on the unit, the
  receipt and the ticket. The registration reminder is a to-do line (dashboard and register) after 7 days.
- Browser test needed: `/units` add form (kind links, "More options"), the register's Machine for sale / Trade-in /
  Service plan / Return a machine, a ticket's "Covered by ..." button, the class roster's "Use an owner's class",
  `/settings/sales`; `tests/vac-shop.spec.ts` and `tests/modules-lapse.spec.ts` were updated for the new words.

**Section 4, layaway (7 Oct 2026).** Migration `20261019100000_layaway` (Shop layaway defaults, `Layaway`,
`LayawayLine`, `SaleLine.layawayId`, `StockUnit.layawayId` with status HELD, stock move reason HELD). Code:
`src/lib/layaway.ts`, `src/lib/layaway-hooks.ts` (the register's part, so `register-sale.ts` doesn't import it back),
`src/lib/layaway-math.ts`, `src/actions/layaway.ts`, the register's Layaway button (`src/components/layaway-panel.tsx`),
`/layaways`, `/layaways/[id]`, `/layaways/[id]/print` (terms to sign), Settings → "Layaway, plans and warranties",
Reports → "Layaways and plans", to-do lines for layaways behind, the customer's page. Check:
`scripts/checks/layaway.check.ts` (8 groups); `customer-merge`, `move-export`, `books-export`, `reports`, `sales-tax`,
`store-credit`, `gift-cards`, `clubs`, `online-shop`, `register-bookings`, `machine-sales`, `vac-units` still pass.
Decisions made while building:
- No `LayawayPayment` table: every payment is a register sale with a LAYAWAY line carrying the layaway's id (any
  payment method, store credit and gift cards included), so receipts, the day's takings, voids and the books need
  nothing new. What was paid is the LAYAWAY lines of sales that stand; the books post them to a new "Customer Deposits"
  account (Settings → Bookkeeping can rename it), and the report checks that total against the open layaways.
- Pick-up is one sale: the held items sold at that day's rate (answer 4; the holiday rule comes with section 1), a
  LAYAWAY line of minus what was paid, and the rest paid then. The machine's warranty starts that day. Voiding the
  pick-up opens the layaway again and holds the items again; a payment can't be voided once the layaway is finished.
- Cancel (owner or admin) gives the payments back less the shop's fee (a LAYAWAY_FEE line, income) as store credit or
  money, by the setting, changeable each time; the items go back on sale.
- Stock items come off the shelf when held (a HELD stock move) and go back on at pick-up just before the sale takes
  them again, so sales velocity counts them on the pick-up day.
- The stored deposit is the one taken (the plan splits the rest); "behind" is what the plan asked for by today less
  what was paid. The reminder is a button ("Send a friendly reminder", Marketing on), not automatic.
- Browser test needed: the register's Layaway button (start with a machine and an item, payment, pick up), the layaway
  page (plan, payments, cancel), the printed terms, Settings → Layaway, Reports → Layaways and plans.

**Section 1, sales tax holidays (7 Oct 2026).** Migration `20261019200000_tax_holidays` (`TaxHoliday`,
`SaleLine.taxNote`). Code: `src/lib/tax-holiday-math.ts` (kinds, the Massachusetts preset, the limit rule, shared by
the register and the server), `src/lib/tax-holidays.ts`, `src/actions/tax-holidays.ts`, `src/components/tax-holiday-form.tsx`;
Settings → Selling (was "Layaway, plans and warranties") starts with "Sales tax holidays". Check:
`scripts/checks/tax-holidays.check.ts` (8 groups); `layaway`, `sales-tax`, `online-shop`, `reports`, `move-export`,
`register-bookings`, `store-credit` still pass.
Decisions made while building:
- What a holiday covers is picked from the register's report categories (fabric, notions, thread, patterns, accessories,
  supplies, parts, machines for sale, other items; classes, appointments and service plans unticked by default). The
  Massachusetts preset ticks the goods with a $2,500 limit and fills Aug 8 to 9 for 2026, the second August weekend for
  other years, for the shop to confirm. The limit is checked on the price each after the line's own discount (not the
  whole-sale discount).
- `completeSaleAs` applies it by the shop's date (no holiday for a processor's tax amount, an exempt customer, or a
  return); a covered line is saved untaxed with `taxNote = holiday:<id>`; "Charge tax anyway" on the register's line
  sends `taxAnyway`. An exempt customer's taxable lines get `taxNote = exempt`. A receipt return copies each item's
  tax and note from the original line (an item bought tax free comes back tax free).
- Layaway: the pick-up checks the holidays on the pick-up day and on the day the layaway began; the layaway's own
  totals (plan, pick-up quote, page) use the same rule.
- Online shop: the cart is priced with the holiday on the order's day. If the order is posted to the books on another
  day, the tax the customer paid is kept (the existing "given tax" path), but those lines carry no holiday note.
- The "confirm the dates" reminder is a to-do line for owners and admins, from two weeks before the preset's month
  until a holiday from that preset is set up for the year, only for shops that used the preset before.
- A holiday with sales under it is switched off, not deleted (receipts and the tax report name it).
- Browser test needed: Settings → Selling's holidays (the Massachusetts button, the form), the register on a holiday
  (the banner, "Tax holiday" on lines, "Charge tax anyway"), the receipt's "(tax holiday)" and its line, Reports →
  Sales tax's holiday list.

**Section 5, financing (7 Oct 2026).** Migration `20261019300000_financing` (`Lender`, `FinancedSale`). Code:
`src/lib/financing.ts`, `src/actions/financing.ts`; the register's "Financing" payment button (shown once the shop lists
a lender), Settings → Selling → Financing, Reports → Financing (by lender, not paid yet, "Lender paid"), the receipt
("Financing by Synchrony, approval ..."; a machine's receipt prints the lenders' apply pages), the online shop's home
page ("Financing available: apply with ..."). Check: `scripts/checks/financing.check.ts` (6 groups); `books-export`,
`reports`, `store-credit`, `move-export`, `online-shop`, `layaway` still pass. No house accounts (answer 8).
Decisions made while building:
- FINANCED is a payment method on the sale's tenders (the lender's id and name and the approval number kept with it);
  each one also makes a `FinancedSale` row, which is what the lender owes. The books post it to a new "Due from
  Lenders" account; marking it paid posts the money in on that day. It is left out of the day's "money taken".
- A sale whose lender already paid can't be voided until an owner marks it not paid (the lender has the money to sort
  out). A refund can be paid back as a negative Financing payment (the lender's reversal).
- The approval number is required. A lender can be unticked (no new payments) but not deleted.
- Online shop: the design's "machine pages" don't exist (the online shop sells stock items), so the apply links are on
  the shop's home page.
- Browser test needed: Settings → Selling → Financing, the register's Financing button (lender, approval number),
  the receipt, Reports → Financing ("Lender paid", "Not paid after all"), the online shop's financing line.
