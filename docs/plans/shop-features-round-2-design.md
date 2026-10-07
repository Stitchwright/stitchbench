# Shop features round 2: everything in the shop research, selling thread, accessories and software, maker crafts, more than one store: design

7 Oct 2026. **Owner, 7 Oct 2026: every owner question answered as recommended.** **Owner, 7 Oct 2026: "I want it all"** (HANDOFF section 3 item 25): every recommendation in
`docs/research/shop-retail-features-and-ai.md` except the two it says not to build, plus the planned "selling thread,
accessories and software" section; the same day the owner added **crafts beyond sewing** (cutters, lasers, 3D printers:
section 6) and **one owner running two or more stores** (section 7). Nothing here is built. It ships after the test
month and after `sales-features` (`docs/plans/tax-machine-sales-layaway-design.md`), each package on its own branch off
the release. Questions for the owner are in section 12; the recommended answer is listed first.

This document **builds on** `tax-machine-sales-layaway-design.md` and never redesigns it. From it, assumed built:
- **Machines for sale for every shop** (its section 3): `StockUnit` at `/units` for every kind of machine, with
  trade-ins, the bundle ("what comes with it"), owner's class credits, the shop's service plans, warranty at intake.
- **Layaway** (its section 4), and with it a **Customer deposits** liability account in the books.
- **Promotions** (its section 2): `Promotion` by date, percent or amount off, `SaleLine.promotionId`.
- **Tax holidays** and the **Financed** tender.

What exists today (checked in the code on 7 Oct 2026, so nothing is designed twice):
- Already built, not designed again: review-request texts (`Customer.lastReviewAskAt`, Settings, Messages); longarm
  rental by the hour with a certification check (`AppointmentType.hourlyCents`, `needsCert`,
  `Customer.longarmCertifiedAt`); class seats and waitlists (`ShopClass.waitlist`, `Enrollment.status` WAITLIST);
  web orders for pickup or shipping with a tracking number (`WebOrder.fulfil`, `tracking`); the books export
  (`src/actions/books.ts`); partner consignment (`ConsignItem`, `ConsignSale`); vacuum trade-ins (`StockUnit`
  `tradeInLineId`); parts-arrived texts on tickets (`PartWait`, notice `parts_in`); fabric insight; the bolt-label
  reader; the spreadsheet import for items and customers (`inventory-import.ts`, `customer-import.ts`); the wholesaler
  catalog connector (`src/lib/connectors/`, **fabric only**); purchase orders (`PurchaseOrder`, **fabric only**: units
  yards or bolts); bags-due call lists for vacuums (`src/lib/vac/bags-due.ts`); 3D printer and resin printer repair
  tickets (`src/lib/equipment/appliances.ts`, Small Appliance Repair module); gift cards and store credit on one ledger.
- Designed elsewhere, not designed again: points loyalty and printed reward cards (`docs/plans/reward-cards-design.md`,
  which also brings the birthday month); wholesaler partner adapters (`fabric-smarts-design.md` section 5a).
- Not there: special orders, pre-orders, want lists, price groups, birthdays, loaners, pay links sent by staff,
  barcodes (GTIN) on items, thread fields, which machines an accessory fits, software codes, locations.

## 0. How every screen here works (the owner's ease-of-use rule)

Most shop staff are older women, many not technical. Every screen in this document follows the same rules (and
`docs/plans/ease-of-use.md` once it exists):
- **Shop words.** "Special order", "Lend a machine", "Raise prices", "Who's coming", never "entity", "SKU sync" or
  "status". Statuses read as sentences: "Waiting for the supplier", "Here, waiting for Jane".
- **One obvious main button** per screen, big and at the bottom right on a phone; anything else is a plain link.
- **Few choices at once.** The usual case fills itself in; "More choices" folds away the rest.
- **Defaults filled in**, from the shop's settings or the last time.
- **Big readable text and buttons** (at least 16px text, 44px tap targets), working at phone width.
- **Forgiving input**: "5005", "isacord 5005" and "ISA-5005" find the same thread; "$12", "12" and "12.00" are the
  same price; phone numbers in any shape.
- **Undo instead of scary confirmations**: a change shows "Done. Undo" for a while (a day for price changes); only a
  money step that can't be undone (sending a pay link, refunding a card) asks first, in one plain sentence.
- **Helpful empty pages**: an empty list says what it is for and has the one button to start ("No special orders yet.
  When a customer wants something you don't have, tap Take a special order.").
- **Hidden until needed**: a shop with one store never sees the word "location"; a feature a shop hasn't switched on
  doesn't show in the menu.

Rules every package follows (AGENTS.md): every query filters by the signed-in company's `shopId`, ownership checked
before any row by id, server actions in `src/actions/` wrapped with `safe()` and `UserError`, money in integer cents,
every new per-company table carried by the company file (`src/lib/move/format.ts`), every action allowed or refused
in `lapse-allow.ts`, checks and a browser spec per package.

**AI** in this document goes through the program's one way to the model (`runAssistant` in
`src/lib/assistant/client.ts`, to the hub's Assistant proxy), is logged as an `AssistantCall` and counts against the
Assistant allowance (300 calls a month, top-ups), like the existing features. Each new feature gets an id in
`FEATURES` and a switch group in Settings, Assistant (`src/lib/assistant/features.ts`). A person presses a button;
nothing runs on its own. Numbers always come from the program; the model only reads pictures, picks from lists and
words things.

## 1. Must-have for launch customers

### 1.1 Purchase orders for every item (a foundation)

Today purchase orders and receiving work for fabric only (`PoUnit` is yards or bolts; `fabric-orders.ts` filters
`kind: FABRIC`). Special orders, the invoice reader, thread and consumables all need them for any item.

**Design**: "Order from a supplier" opens for every kind of item; lines in **each** (or yards and bolts for fabric).
Reorder suggestions use each item's existing `reorderAt`. Receiving works as now (adds stock, records lead time).

**Data**: `PoUnit` gains `EACH`; the fabric filter in `fabric-orders.ts` becomes a kind check per line. About 1.5 days.

### 1.2 Special orders and pre-orders ("coming soon" with a deposit)

What shops do today: a paper slip and a $10-$25 deposit taken by hand, remembered when the box arrives. Every serious
competitor has it (Rain, MicroBiz, Lightspeed).

**Design**
- **Take a special order** (register, customer page, item page): customer, the item (search the stock; or type what it
  is: "Tula Pink Untamed charm pack"), how many, the price, the deposit (default from settings: none, a set amount or
  a percent), when it's expected (optional). One main button: **Take the order**. The deposit is rung up on the same
  screen and prints a slip: "Special order 1042, deposit $10.00, balance $34.95 when it arrives."
- **Pre-order** is the same record on an item marked **Coming soon** (a date on the item). The register search shows
  "Coming soon (1 Nov): take a pre-order" instead of "out of stock"; the online shop shows **Pre-order** with the
  deposit, paid online (the existing web-order checkout, for the deposit only). Kit subscriptions: the deposit now, and
  "Ask for the balances" about a week before the ship date sends each customer a pay link (1.3).
- **It goes on the next order**: the supplier's purchase order shows "3 special orders waiting" with **Add them**;
  each order line remembers the special orders it covers.
- **It's here**: receiving that order (or receiving the item any other way) marks the special orders "Here", holds
  the quantity for those customers (it can't be sold to someone else at the register without "Sell it anyway") and
  sends the "it's here" text or email through the existing messaging (a new message kind `order_in`, like `parts_in`,
  never twice). Customers who said "no messages" go on a "Call these" list.
- **Picking up**: the register shows "Jane has a special order waiting" when Jane is chosen; one tap adds it, the
  deposit comes off. Not picked up after N days (setting, default 30): it shows on the dashboard.
- **Cancelling**: by the shop's deposit rule (setting: refund, store credit, or keep for non-refundable items; the
  slip prints the rule). Undo for a day.
- **Lists**: Special orders page in three tabs: Waiting for the supplier, Here, Done. Empty page says what it is for.

**Money and books**: a deposit is money held for the customer: the **Customer deposits** liability (the account
layaway brings), not a sale. At pickup the sale is made and the deposit pays part of it, exactly as layaway completes.
A kept non-refundable deposit becomes income ("Kept deposits") on the day it is kept. The deposits report shows open
special-order deposits beside layaway's; the total matches the books.

**Data**: `SpecialOrder` (shopId, number, customerId, kind ORDER | PREORDER, status WAITING | ORDERED | HERE |
DONE | CANCELLED, partId?, description, qty, unit, priceCents, depositCents, depositRule, expectedOn, poLineId,
hereAt, noticedAt, saleId, cancelledAt, note, createdById); `Part.comingSoonOn`; `SaleLine.specialOrderId` and
kind `DEPOSIT`; `Shop.specialOrderDepositRule`, `specialOrderDays`. About 3 days.

### 1.3 Pay links sent by staff (a foundation)

The online shop's checkout only takes orders a customer builds. Special-order balances, live sales (4.3) and retreat
balances (4.5) need the shop to send a link.

**Design**: **Send a pay link** from a special order, a claim list or an event: the program makes a web order with the
lines filled in and texts or emails the link; paid, it lands as the existing web order (paid, ready, collected or
shipped). Hosted first, like the online shop.

**Data**: `WebOrder.source` (`customer` | `staff`), `WebOrder.specialOrderIds`, `createdById`. About 1.5 days.

### 1.4 Want lists

What shops do today: a notebook at the counter ("call me when the next Tula Pink line lands").

**Design**: on the customer page, **Add to her want list**: an item, or words to watch for (a designer, a collection, a
maker: "Tula Pink"). When an item matching arrives (receiving, the catalog import, a new item) the want list shows
"Here now" and offers **Let her know** (one tap, the `order_in` message with the item's name); the shop chooses, it
doesn't send by itself. The item page shows "4 customers want this" (a good reason to order).

**Data**: `WantItem` (shopId, customerId, partId?, words?, createdAt, matchedPartId, matchedAt, toldAt, doneAt).
About 1.5 days. The wish list or gift registry the report mentions waits until want lists are in use (9.9).

### 1.5 Customer price groups, memberships, wholesale and the vacuum lifetime discount

What shops do today: the guild discount someone remembers; a paid club card that gives 15% off; a lifetime discount
on bags, belts and filters written on the vacuum's paperwork.

**Design**
- **Price groups** in Settings, Prices: a name ("Guild", "Teachers", "Club card", "Wholesale"), what it gives (percent
  off; or for Wholesale the item's existing `wholesaleCents`), which kinds of items (all, or fabric, notions...),
  and whether it applies to items already on sale (default no).
- **A customer joins a group** on her page, with an end date for paid memberships. **Sell a membership**: a membership
  item at the register (its price and length: "Club card, $25, 12 months") puts the buyer in the group from today.
- **At the register**: choose the customer and the group's discount goes on every line it covers, labelled "Guild
  10%". Tap the label to take it off a line. With a promotion on the same line the **bigger one wins, not both**
  (setting). A membership about to end shows "Club card ends 3 Nov: renew?" with a one-tap renewal.
- **Lifetime discount for a machine's owner**: on a machine-for-sale unit, tick "Lifetime discount on its supplies"
  (default from the Vac Shop setting: 25% off bags, belts and filters). When the buyer is chosen at the register and a
  line is a supply for that vacuum (the bags-due link already knows), the discount applies, labelled "Lifetime 25%".
- **Reports**: discounts given by group, members and renewals due.

**Books**: discounts are line discounts as today (`SaleLine.discountCents`), so returns and reports already handle
them; a membership sold is income ("Memberships").

**Data**: `PriceGroup` (shopId, name, pctOff, useWholesale, kinds[], onSaleItems, active); `Customer.priceGroupId`,
`priceGroupUntil`; `Part.membershipGroupId`, `membershipMonths` (an item that sells a membership);
`StockUnit.lifetimePctOff`; `SaleLine.priceGroupId`. About 2.5 days.

### 1.6 Birthdays and per-yard price breaks

**Design**
- **Birthday**: month and day on the customer page (optional, "Only if she'd like to tell you"). The birthday offer in
  Settings: percent off one sale, or a store credit, during the birthday month, once a year. The register shows "Happy
  birthday month: 15% off today" when she's chosen; one tap uses it. A birthday list on the dashboard each month for
  a card or a campaign. (Points and the birthday bonus of `reward-cards-design.md` reuse the same field.)
- **Per-yard breaks**: Settings, Prices: "10 yards or more of one fabric: 10% off" (one or more steps); an item may
  override ("this wide-back: $18 a yard from 3 yards"). The register applies it to the line when the yards reach the
  step, labelled "10+ yd price".

**Data**: `Customer.birthMonth`, `birthDay`, `birthdayUsedYear`; `Shop.birthdayOffer` (JSON: kind, value);
`YardBreak` (shopId, minYards, pctOff, kinds[]); `Part.breakMinQty`, `breakPriceCents`. About 1.5 days.

### 1.7 Loaner and demo machines

What shops do today: a tag on a loaner and a notebook line; demos on the floor with no record. Rain bundles loaners,
trials, rentals and trade-ins in its middle tier.

**Design** (on the machines-for-sale units of `sales-features`; no new machine system)
- A unit gets a **use**: For sale (as now), **Loaner**, **Demo**, **Rental**. Loaners and rentals don't show in the
  register's "sell a machine" search unless the shop chooses to sell one ("Sell this demo": it becomes For sale, with
  its condition set to open box or used).
- **Lend a machine** on a repair ticket (or a customer page): pick from the loaners in (the list shows only what's in),
  the due date (default: the ticket's promised date plus 2 days), a deposit or "card on file" note (setting: none by
  default), the condition going out (one line, filled with "Good"). Prints a short loan slip to sign. One main button.
- **It's back**: one tap on the ticket at pickup ("Did the loaner come back? Yes"); the condition coming back; the
  deposit refunded.
- **Demo out**: a demo taken to a class, a show or a customer's home for a test, the same way.
- **Dashboard**: "Out on loan: 3, 1 overdue". The ticket shows "Loaner out: Brother CS6000i, due 14 Oct".

**Money and books**: a deposit is a Customer deposits liability until it is refunded or kept (a kept deposit for a
lost or damaged loaner becomes income, "Loaner charges").

**Data**: `StockUnit.use` (SALE | LOANER | DEMO | RENTAL); `UnitLoan` (shopId, unitId, kind LOAN | DEMO | RENTAL |
TRIAL, customerId, ticketId?, outAt, dueAt, backAt, depositCents, depositLineId, cardNote, conditionOut,
conditionBack, note). About 2.5 days.

### 1.8 Rentals, rent-to-own and trial purchases

**Design**
- **Rent it out**: a Rental unit, a rate (per day, week or month) and the dates; rent is rung up at the register at the
  start and each period (or a pay link, 1.3); overdue shows on the dashboard. **Rent-to-own**: a percent of the rent
  paid (default 100% for up to 3 months) counts toward buying it; "Buy it now" shows the credit and sells the unit.
- **Trial purchase**: a machine sold with "Try it for 14 days" (setting): the receipt says so; a return inside the
  window takes it back in full (the existing return path, capped at what she paid), after it the shop's normal rule.

**Books**: rent is income ("Rentals"); the rent-to-own credit is a discount on the sale line ("Rent credit"), so the
rent already counted isn't counted twice.

**Data**: `UnitLoan` rate fields (rateCents, ratePer, ownPct, ownUntil); `SaleLine.unitLoanId`; `StockUnit.trialDays`,
`trialUntil`. About 2 days.

### 1.9 Trade-up credit and the trade-in value rule

What shops do today: B-Sew Inn credits the repair cost toward a new machine within 30 days; dealers value a trade-in at
what it should sell for in 60-90 days.

**Design**
- **Trade-up offer** on a repair ticket (setting, default off; default 30 days): the invoice prints "If you'd rather
  buy a new machine by 12 Nov, we'll take $89 off". At the register, selling a machine to that customer shows "Repair
  credit $89 (until 12 Nov)" with one tap to use it.
- **Trade-in value** (on the existing trade-in step): the shop's rule, "what we expect to sell it for, less 30%"
  (setting), shows the number to start from; staff change it freely. The AI helper (5.5) adds a condition note and the
  expected price from the shop's own past sales.

**Books**: the credit is a discount on the machine line ("Trade-up credit"), not a liability: the customer can't cash
it.

**Data**: `TradeUpOffer` (shopId, customerId, ticketId, amountCents, until, usedLineId); `Shop.tradeUpDays`,
`tradeInLessPct`. About 1 day.

Trade-ins for sewing machines: `sales-features` section 3 says trade-ins work for every kind of machine as they do for
vacuums. Nothing more to build here; check it in that branch's spec.

### 1.10 A photo of the packing slip or invoice fills in receiving (AI)

What shops do today: retype the packing slip line by line, and miss cost changes. Lightspeed and Like Sew read them.

**Design**
- On a purchase order: **Receive from a photo** (or "Receive without an order" on the Items page). Take or choose up
  to 5 pictures, or a PDF from the supplier's email.
- The Assistant reads the lines (item number, description, quantity, unit cost); the program matches them to the order
  lines and the shop's items by item number (`numberKeys`), never by guessing names. The screen shows three groups:
  **On the order** (ticked), **New to us** (one tap makes the item, filled in), **Not on the order** (unticked). Each
  line shows the quantity on the order beside the quantity on the slip. One main button: **Receive these**.
- **New costs**: a cost that changed shows "Cost up 12% ($4.10 to $4.60)"; ticked by default to update the item's
  cost (to the ten-thousandth, `costTenThou`); items now under the shop's margin floor go to the Raise prices list
  (4.4).
- Only the picture goes out; never a customer. One call per page. Off with the Assistant's "Stock helpers" switch.

**Data**: feature `read_invoice` (class `read`, new group `stock`, "Stock helpers"); `AssistantSettings.stockOn`;
`AssistantCall.purchaseOrderId`. About 3 days. Needs 1.1.

## 2. Selling thread, accessories and software (the owner's planned section)

### 2.1 Item details: thread, filament and other supplies

Today a thread is an item of kind THREAD with a number and a description; nothing knows its color number or weight.

**Design**: an item of kind THREAD shows, under its name, **Maker** (the existing brand), **Color number** (the maker's
own: Isacord 0015, Aurifil 2024), **Color name**, **Weight** (40 wt, 50 wt...), **Fibre** (polyester, cotton, rayon,
silk, metallic, blend: a short list), **Spool or cone** (a short list per maker: "1,000 m spool", "5,000 m cone",
or type it) and a color swatch (picked from a color, or from the bolt-label style photo). The same fields serve
filament, resin, vinyl and laser materials (section 6). The "add a collection" pattern from fabric applies: add a
whole thread line at once from a distributor list (2.3).

**Data**: on `Part`: `colorNumber`, `colorName`, `colorHex`, `material` (fibre for thread, PLA for filament...),
`itemType` (thread | filament | resin | blade | mat | vinyl | laser-material | die | software | null), `specs` JSON
(weight, put-up and length for thread; diameter and spool grams for filament; volume for resin; size and thickness for
sheets). `colorNumber`, `colorName` and `material` are columns because the counter search reads them. About 2 days.

### 2.2 Color lookup at the counter

What shops do today: a customer brings a spool end or a number; staff walk the rack.

**Design**: the register search and a **Find a color** button take a maker and number in any shape ("isa 15", "0015",
"Aurifil 2024") or a color name ("navy"), and show big swatches with what's in stock, where (the bin) and the price;
one tap adds it to the sale. Nothing in stock: "Order it for her" (a special order, 1.2). On the customer page,
**Colors she bought** lists her past threads (from sales), for "the same as last time". Across makers the program
doesn't guess equivalents (makers' conversion charts aren't ours to copy, and swatches beat screens): the shop can
link its own matches on an item ("same as Madeira 1147"), and those show in the lookup.

**Data**: `Part.sameAs` (plain ids of other items, checked as the shop's own). About 1.5 days.

### 2.3 Distributor thread, notion and supply lists

Today the catalog connector imports fabric only (`src/lib/connectors/catalog.ts`).

**Design**: the same import (choose the supplier, open the file, match the columns, see what will change, **Bring them
in**) for thread, notions, accessories, patterns and supplies, with the new columns (color number and name, weight,
fibre, spool size, material) in the column match. New costs from the list update items' costs and feed Raise prices
(4.4); stock is never touched.

**Data**: `CATALOG_FIELDS` gains the 2.1 fields; the kind comes from a column or the supplier's default kind
(`FabricSupplier.defaultKind`). About 2 days. Needs 2.1.

### 2.4 Accessories that fit a machine

What shops do today: "which feet fit my machine?" answered from memory or the maker's chart.

**Design**
- An accessory, foot, bobbin, die or supply says **which machines it fits**: models picked from the shop's models
  (matched on model keys like everything else) and/or a **fit group** the shop names once ("Brother 7 mm low shank",
  "Cricut Maker 3", "Bambu P1 hot end") with its models. The free-text `fits` stays for notes.
- **For her machines**: on the customer page, "Fits her machines" lists what's in stock for each machine she owns.
- **At the register**: with a customer chosen, a quiet line "3 feet fit her Brother PE800" opens the list; never a
  pop-up.
- **At a machine sale**: selling a unit shows **Goes with this machine**: what fits it, in stock, with one tap to add
  each (and the unit's bundle from `sales-features`).
- **Online shop**: "Fits your machine" filter by model.

**Data**: `Part.fitsKeys` (model keys), `Part.fitGroupIds`; `FitGroup` (shopId, name, modelKeys[]). About 2.5 days.

### 2.5 Software licences and activation codes

What shops do today: embroidery software (and cutting-machine and slicer software, section 6) sold with a code written
on the receipt by hand; renewals forgotten; a returned box whose code is already used.

**Design**
- An item of type **Software** says whether it is **once** (perpetual) or a **subscription** (months), and its
  no-returns wording (default: "Software can't be returned once it has been activated.").
- **At the register**: ringing it up asks for the code (scan it or type it; "Add the code later" is allowed and puts
  it on a "Codes to fill in" list). The receipt prints the product, the code, the customer's name, the machine it is
  for (picked from her machines, optional), the renewal date for a subscription, and the no-returns note.
- **Codes on hand**: a shop that buys codes ahead (cards in a drawer, or a list from the distributor) can load them on
  the item; the register then fills in the next one itself.
- **Her page and the machine page** show her software, codes masked ("…7F3K", shown in full with one tap).
- **Activated**: the shop marks it activated (or the sale date, setting); a return of an activated licence is refused
  at the register with the note; an owner or admin can still take it back with a reason (recorded in the audit log).
- **Renewals**: subscriptions due in 30 days show on the dashboard and, if messages are on, a friendly reminder goes
  (new message kind `software_renew`, once per renewal). Renewing is ringing up the renewal item; the date moves on.

**Data**: `PartKind` gains `SOFTWARE`; `Part.licenseKind` (ONCE | SUBSCRIPTION), `licenseMonths`, `noReturnText`;
`SoftwareLicense` (shopId, partId, saleLineId, customerId, machineId?, code, kind, startsOn, renewsOn, activatedAt,
status ACTIVE | RENEWED | RETURNED | ENDED, note); `SoftwareCode` (shopId, partId, code, usedById, receivedAt) for
codes on hand. Codes are kept as the shop's record of the sale (masked in lists and in the company file's previews,
never sent to the hub or the Assistant). About 2.5 days.

## 3. What the report calls strong next

The report's strong-next list grows sales rather than fixing daily friction. It is split into channels and events
(section 4) and the AI features (section 5); the report's later items are in section 9.

## 4. Channels and events

### 4.1 Google "in stock nearby" listings

What shops do today: nothing (no evidence Like Sew does it); Square and Lightspeed do it free.

**Design**: Settings, Online shop, **Show your stock on Google** (hosted first, like the online shop). Steps in plain
words: link your Google Business Profile, open a Merchant Center account (a guided page with screenshots), paste the two
feed links we show. The program publishes a **product feed** and a **local inventory feed** (Google's file formats)
that Google fetches daily: items with a real barcode (Google asks for at least 50 products with barcodes), a price and
the in-store quantity; items priced below the maker's minimum advertised price are left out (9.3); fabric without
barcodes isn't listed. A page lists what's in the feed and why anything isn't ("no barcode").

**Data**: `Part.gtin` (the barcode number, filled by the scanner on the item page); `Shop.feedToken`; feed routes under
`/shop/{slug}/feeds/` (token in the path, rate limited). About 2 days, plus Google's own review time.

### 4.2 Facebook and Instagram catalog

**Design**: the same page, **Show your items on Facebook and Instagram**: a third feed link in Meta's catalog format,
each item pointing at its page in the shop's own online shop (Meta moved US shops to checkout on the seller's site in
2025, so no Meta payments). Guided steps for Commerce Manager. About 1 day. Shares 4.1's feed code.

### 4.3 Live-sale claim list

What shops do today: a Facebook Live, comments copied to paper, invoices typed after.

**Design**: **Live sale** page, big and simple for a phone or tablet beside the camera: search an item (or tap one from
the "On today's show" list picked beforehand), type the buyer's name (finds the customer; a new name is fine) and the
quantity (yards in eighths for fabric). **Claim** holds the stock. A running list shows claims and what's left. When the
show ends: **Send pay links** groups each buyer's claims into one pay link (1.3) by text or email. Unpaid after the hold
time (default 48 hours) shows "Let go of these?" with one tap to put the stock back. Reading Facebook comments
automatically is left for later (9.12: needs Meta's approval).

**Data**: `LiveSale` (shopId, name, startsAt, status OPEN | CLOSED, holdHours); `LiveClaim` (shopId, liveSaleId,
customerId?, name, phone?, partId, description, qty, unit, priceCents, status HELD | SENT | PAID | LET_GO,
webOrderId). Held stock counts as held like special orders. About 3 days. Needs 1.3.

### 4.4 Raise prices, margin floor and the back-order list

What shops do today: tariffs raised fabric 10-20%; repricing one item at a time.

**Design**
- **Raise prices**: choose whose (a supplier, a maker, a kind, a collection), by how much (percent), how to round
  (to .99, to the nearest 25 cents, a yard to the nearest 50 cents); the screen shows old and new prices for every
  item; **Raise them**. "Done. Undo" lasts a day (the old prices are kept).
- **Margin floor**: Settings, Prices: "Tell me when an item's margin falls under 40%" (per kind). Items under it, mostly
  after a cost rise from the invoice reader or a list import, show on the dashboard with **Raise prices** pre-filled.
- **Back orders**: a purchase order line the supplier says is back ordered gets "Back ordered, expected 20 Nov" (one
  tap on the line, or from the invoice reader). The **Coming in** list shows what's on back order and who's waiting
  (special orders); **Let them know** sends "your order is delayed until about 20 Nov".

**Data**: `PriceChange` (shopId, at, userId, rule JSON, items JSON [{partId, oldCents, newCents}], undoneAt);
`Shop.marginFloor` (JSON per kind); `PurchaseOrderLine.backorderedOn`, `expectedOn`. About 2.5 days. Needs 1.1.

### 4.5 Retreats, trunk shows and other ticketed events

What shops do today: $150-$400 non-refundable deposits, the balance 60-90 days before, early-bird prices, a room list
in a spreadsheet, door prizes drawn from a basket. Classes with seats and waitlists are already built.

**Design** (on `ShopClass` and `Enrollment`; a class gains a kind)
- **New event**: a retreat, trunk show, sew-in or class (the same form; the retreat's extras fold away under "More
  choices"): early-bird price until a date; a deposit and when the balance is due (default 60 days before); choices
  with their prices (room: single +$120, double, shared; meals: none, lunches, all; a free-text "dietary needs").
- **Signing up** (counter or online): the price shown with the early-bird; the deposit taken now, the balance by a pay
  link (1.3) or at the counter. "Balance due" reminders go through messages (once at 14 days before the due date, once
  on it). The roster shows paid, owing, and each person's choices; **Room list** and **Meal list** print.
- **Trunk show at the door**: an event with a door price; "Sell a ticket" at the register in one tap; a check-in list.
- **Door prize drawing**: **Draw a name** from the people checked in (or signed up); big name on screen, recorded with
  the prize; **Draw again** if she's not there (the first draw is kept, marked "not present").

**Money and books**: event payments are counted as class fees are today (income when paid, refunds through the
existing refund path); deposits marked non-refundable print that on the receipt. A shop whose accountant wants event
money held until the event can tick "Hold event payments as deposits" (Customer deposits until the first day).

**Data**: `ShopClass.kind` (CLASS | EVENT | RETREAT), `earlyCents`, `earlyUntil`, `depositCents`, `depositRefundable`,
`balanceDays`, `choices` JSON, `doorCents`; `Enrollment.choices` JSON, `checkedInAt`; `EventPayment` (shopId,
enrollmentId, amountCents, saleLineId, paidAt); `EventDraw` (shopId, classId, enrollmentId, prize, drawnAt, present).
About 3.5 days.

### 4.6 Shop hop passports (on StitchHub)

What shops do today: paper passports stamped at each shop (44 Minnesota shops in 2025; a sewing machine as the prize
for all 10 stamps in Northern California). No register tracks stamps. Unproven demand: **ask one hop organizer first**
(question 1).

**Design**
- **On the hub** (it already links shops): an organizer shop creates a **Hop** (name, dates, prize rules: "all 10
  shops", "any 6"); other shops join by invitation and choose to take part (opt-in, the sharing rule). Shoppers sign up
  on the hub's hop page (name, email or phone; a tick to share their details with each shop they visit, off by default)
  and get a **passport**: a page on their phone with a code, or a printed card with the same code.
- **In the shop**: the program's **Shop hop** page: **Stamp a passport** opens the camera (or type the code); a big
  green tick with "Stamp 4 of 10". No sign-up needed at the counter. The page shows today's visitors and totals.
- **Prizes**: the organizer's page lists completed passports and draws a winner the same way as 4.5's drawing.
- Shops see only shoppers who ticked "share with this shop"; everyone else is a count.

**Data**: hub: `hops`, `hop_shops`, `hop_passports`, `hop_stamps` (migration on the hub); program: `HopStampLocal`
(shopId, hopId, passportRef, at) as the shop's own record, sent to the hub signed like partner messages. About 4 days on
the hub and 1.5 in the program.

### 4.7 Help switching from Square, Rain or Like Sew, and QuickBooks Desktop POS

What shops do today: retype, or pay for a migration. 34% of merchants switch over missing features.

**Design**: the existing spreadsheet import gains **ready-made layouts**: "From Square", "From Rain or Like Sew", "From
QuickBooks Point of Sale". Choose one, open the exported file, see what will come in, **Bring them in**. Items,
customers, and **gift card balances** (opening balances on the gift-card ledger, `OPENING`, with the card numbers so
customers' cards keep working). A one-page "How to export from Square" with pictures for each.

**Data**: preset column maps in `inventory-import.ts` and `customer-import.ts`; a gift-card import action. About 2.5
days (needs a sample export from each system: question 13).

### 4.8 A card reader at the counter (Stripe Terminal), only if a launch shop asks

Today card payments are recorded as a tender on the shop's own terminal; the online shop uses Stripe.

**Design**: Settings, Card reader: connect the shop's Stripe account (as the online shop does), pair a Stripe reader.
At the register, **Card** shows "Tap, insert or swipe on the reader" and finishes the sale itself when approved; the
tender records the payment so a return refunds the card. Tap to Pay on a phone is the no-hardware option. Hosted first;
the Windows program needs the internet for it. About 6 days. **Gated**: build only when a launch shop asks
(question 2).

**Data**: `Shop.terminalLocationId`, `Sale.tenders` entries carry `stripePaymentId`; `CardReader` (shopId, readerId,
label).

## 5. AI the report ranks (table stakes and differentiators)

Every feature here: a person presses a button, the call goes through the hub's Assistant proxy and counts against the
allowance, a switch per group in Settings, Assistant, and numbers only from the program. 1.10 (invoice reading) is in
the launch set.

### 5.1 Ask your shop a question

**Design**: an **Ask** box at the top of Reports: "Which precuts sold best since spring?", "Which machines waited
longest for parts?". The model chooses **one of the program's own reports** and its settings (dates, kind, collection,
top N) from a fixed list (best sellers, slow items, sales by kind, margins, waited for parts, tickets by status, class
fill, special orders waiting, gift-card liability, discounts by group...); the program runs it; the model words a
two-sentence answer **from those numbers only**; the table shows underneath with **Open this report**. A question no
report covers gets "I can't answer that from your reports yet" and the list of what it can. Customer names never go
to the model (counts and item names only; names are filled in on this computer). With more than one store (section 7)
the question can say "at the Florida store" or "both stores".

**Data**: feature `ask_shop` (class `suggest`, group `ask`); a report registry in `src/lib/reports/` with each report's
parameters. About 4 days (4.5 with locations).

### 5.2 Marketing and web-store drafts

**Design**: **Draft it** buttons where the words are needed: a **new arrivals** email (from items received in the last
N days, with their pictures), a **class blurb** (from the class's fields), an item's **online description** (from its
fields and the label read), a **social post** (copy to paste). In the shop's voice (`AssistantSettings.voice`). The
draft lands in the campaign (Marketing module) or the field, for staff to change; nothing is sent by itself.

**Data**: features `draft_arrivals`, `draft_class`, `draft_product`, `draft_post` (class `draft`, group `marketing`);
`AssistantSettings.marketingOn`. About 2 days.

### 5.3 Build this quilt from our stock (the differentiator)

**Design**
- **Quilt planner** (Fabric page): choose a pattern (a PATTERN item with its yardage per size typed once from the
  pattern's back: "Throw: background 2 1/4 yd, focus 1 yd, binding 1/2 yd, backing 3 3/4 yd") or a plain quilt size and
  block layout (the program works out the yards: never the model; uses `fabric-math.ts`).
- **Pick the fabrics**: the customer's focus fabric (an item, or a photo of what she brought). **Suggest coordinates**
  sends the model the focus fabric's color tags and collection and a list of in-stock fabrics with enough yards (number,
  name, color tags, collection; their swatch thumbnails when the shop has them); it returns picks per role with a
  one-line reason. The program checks each pick is in stock with the yards needed and drops any that isn't.
- **Thread to match**: from the 2.1 thread fields: threads whose color tags or swatch match each picked fabric, in stock.
- **The result**: a pull list with swatches, yards and prices; **Add all to the sale**, **Print the list**, or **Make it
  a kit** (the existing kit builder).

**Data**: `PatternNeed` (shopId, patternPartId, size, role, yards); feature `quilt_pick` (class `suggest`, group
`quilt`). About 2 days for the planner and yards (no AI), 3 days for the AI picks and thread step. Needs 2.1 for the
thread step and the existing color tags (`tag_fabric`).

### 5.4 Trade-in helper

**Design**: on the trade-in step: the plate photo (already read) plus up to 4 condition photos; **Draft a condition
note** writes "Light scratches on the bed, bobbin cover missing" for staff to change. The **expected price** comes from
the program: the shop's own past sales of used units of the same model (or kind and brand), with the days they took to
sell, and the 1.9 rule. Staff only; never on a receipt.

**Data**: feature `trade_in_note` (class `read`, group `plate`). About 1.5 days. Needs machines for sale.

### 5.5 Care tips and the "what we did" sheet at pickup; words on fabric insight

**Design**: on a ready ticket, **Draft the pickup sheet**: "What we did" in plain English (from the work done lines)
and care tips chosen from the shop's own care-tip list per kind (the shop writes them once; starters given, e.g.
"Change the needle every 8 hours of sewing"); never new advice from the model. Prints with the invoice. On fabric
insight, each card gets one sentence ("These 12 Christmas prints haven't sold since January") worded from its numbers.

**Data**: `CareTip` (shopId, kind, text, sortOrder); features `draft_pickup` (group `draft`), `explain_insight` (group
`fabric`). About 1.5 days.

### 5.6 Customer-facing answers: web chat, and a link for a phone-answering service

The report's caution, built in: a business is liable for what its chatbot says (Moffatt v. Air Canada, 2024).
**Answers come only from the shop's own records; never a price, a diagnosis or a promise; off unless the shop turns it
on; easy to turn off.**

**Design**
- Settings, Customer questions: **Answer customers' questions on your booking page** (off). The warning in plain
  words: "It only answers from your records: is a machine ready, your hours, classes with seats, open drop-off times.
  Anything else goes to you."
- **Buttons first, no AI**: the shop's public page (`/book/{slug}`) gets **Is my machine ready?** (ticket number and the
  last four digits of the phone on the ticket; both must match), **Hours**, **Classes with seats**, **Book a
  drop-off** (the existing online booking). These work without the Assistant and cost no calls.
- **Typed questions** (only with the Assistant on): the model only sorts the question into one of those four, or
  "for a person", and pulls out a ticket number; the answer is the program's fixed wording from the records. "For a
  person" saves the question to a **Customer questions** list (with her contact) and says "We'll get back to you". At
  most N typed questions a day (setting, default 20); past that, the buttons only.
- **Phone answering is bought, not built**: Settings shows a **status link** and a private key for the outside
  service the shop chooses (question 3). The service reads the same four answers (ticket status by number and phone,
  hours, classes with seats, open drop-off times) and can book a drop-off; it never reaches anything else. No AI on our
  side, no calls counted.

**Data**: `AssistantSettings.customerOn` (default false), `customerDailyCap`; feature `customer_question` (class
`suggest`, group `customers`); `CustomerQuestion` (shopId, at, name, contact, text, handledAt, handledBy);
`Shop.statusKeyHash`; routes `/api/public/v1/{slug}/...` (rate limited, `allowPublic`). About 4 days for the page and
chat, 1.5 days for the status link.

## 6. Crafts beyond sewing: cutters, lasers and 3D printers (owner, 7 Oct 2026)

Quilt shops already sell fabric die cutters (AccuQuilt) and their dies; many sell Cricut, Silhouette or Brother
ScanNCut; laser cutters (Glowforge, xTool) cut appliqué, wood and acrylic; 3D printers (Bambu Lab, Prusa, Creality,
resin printers) sell with filament and resin. **Repair is covered already** (3D printer and resin printer tickets in
the Small Appliance Repair module). This is the selling and services side, with **no new machine system**.

**Base or module** (question 7): **recommended: selling the machines and their supplies is base** (any shop sells any
item; machines go through machines for sale), and a **Maker Shop module** ($10 a month, in the everything bundle,
like Vac Shop) carries the extras: supplies-due reminders, maker-space time and print/cut jobs. The owner likes 3D
printers most, so the module's first page leads with them.

### 6.1 The machines, through machines for sale

**Design**: new machine kinds for selling: **craft cutter** (Cricut, Silhouette, ScanNCut), **fabric die cutter**
(AccuQuilt; a serial is optional), **laser cutter**, and the existing **3D printer** and **resin printer** kinds,
available for sale without the repair module. Serials, warranty, registration reminders, owner's classes ("Getting
started with your Bambu", 2 classes) and service plans work as for sewing machines. **Starter bundles** per kind
(Settings: "Bambu starter: 2 spools PLA, build plate glue"; "AccuQuilt starter: 2 dies, cutting mat"): at the sale,
**Add the starter bundle** puts them on the sale (the unit's bundle from `sales-features`). Accessories and dies fit
models through 2.4.

**Data**: kinds in `src/lib/equipment/` with `sellable` and a `module` of null for selling; `StarterBundle` (shopId,
kind, name, lines JSON [{partId, qty}]). About 1.5 days. Needs machines for sale.

### 6.2 Supplies with their own fields, the color and material lookup, reordering

**Design**: the 2.1 item details per type: **filament** (material PLA, PETG, ABS, TPU, ASA, nylon...; color; diameter
1.75 or 2.85 mm; spool weight 1 kg / 250 g; brand), **resin** (type: standard, tough, water-washable...; volume),
**cutter blades, mats, vinyl** (type, size, color), **laser materials** (material and thickness: 3 mm birch plywood,
acrylic; size), **dies** (shape, size; the machines they fit). The **Find a color** lookup (2.2) takes "PLA black 1.75"
or "matte red PETG" as well. Reordering uses reorder points and purchase orders for every item (1.1); the distributor
list import (2.3) covers filament and vinyl lists.

**Data**: no new fields beyond 2.1 (values in `specs`); short lists of materials in `src/lib/constants.ts`. About 0.5
day on top of 2.1 and 2.2.

### 6.3 "Running low" reminders for printer and cutter owners

**Design**: like the vacuum bags-due list, generalized: a customer who bought a printer (or cutter) from the shop, and
how often she buys filament (or mats, blades), gives a "probably running low" date (default: 6 weeks after her last
spool if she hasn't bought since, or her own average gap). **Supplies due** list: call, snooze, stop, or one-off send
through Marketing; never sent automatically (the bags-due rule).

**Data**: the bags-due logic (`src/lib/vac/bags-due.ts`) moves to a shared `src/lib/supplies-due.ts` taking a kind's
rule (which items count as its supplies, the default gap); `VacCare`'s marks gain a general twin `SuppliesCare`
(shopId, machineId, calledAt, snoozeUntil, stoppedAt). About 2 days.

### 6.4 Classes and maker-space time

**Design**: classes are the existing classes. **Maker-space time**: booking the shop's own laser or 3D printer by the
hour, exactly as longarm rental works (`AppointmentType.hourlyCents`, capacity, resource), with **certified** made
general: "Certified on: Longarm, Laser" on the customer page, one tap to certify after the safety class. Material used
is added at the register when she pays.

**Data**: `Certification` (shopId, customerId, equipment, certifiedAt, byUserId); `AppointmentType.certFor` (the
equipment); `Customer.longarmCertifiedAt` copied into it by the migration and kept in step until removed. About 1.5
days.

### 6.5 Print and cut jobs

What shops do today: a customer emails a file, the shop quotes on a sticky note.

**Design**
- **New print or cut job** (the longarm work-order pattern): customer, what it is ("20 acrylic name tags"), the file
  (attach it; kept 30 days after pickup, then deleted), the machine (3D printer, resin printer, laser, cutter), the
  material (an item from stock), and **Work out the price**: machine time x the shop's hourly rate + material used
  (grams, ml or sheets) x its price + a set-up fee, all from settings and filled in. The quote can go by the existing
  estimate link for approval.
- Statuses in shop words: Quoted, Approved, Printing (or Cutting), Ready, Collected; **Ready** sends the ready message.
  Paid at the register like a longarm order.
- **The shop decides what it will make**: the job slip and the online request say "We decide what we'll print or cut";
  **Turn it down** with a reason (copied logos, weapons, unsafe materials). The laser material list carries the shop's
  "never cut" list (default: PVC and vinyl, which give off chlorine gas when laser cut).

**Data**: `MakeJob` (shopId, number, customerId, kind PRINT | RESIN | LASER | CUT, status QUOTED | APPROVED |
WORKING | READY | COLLECTED | CANCELLED | TURNED_DOWN, title, fileName, fileData Bytes, fileDeleteAfter, machineMinutes,
materialPartId, materialQty, setupCents, rateCents, quoteCents, estimateLinkId, dueAt, turnedDownWhy, saleId, note);
`Shop.makeRateCents`, `makeSetupCents`. About 3 days.

## 7. One owner, two or more stores (owner, 7 Oct 2026)

The case: one owner running a store in New England and one in Florida, from an RV.

**How far the program gets today**: a person can have a login in several **separate companies** (email unique per
company since round 3 W1), each with its own customers, stock, gift cards, tax rate and time zone; signing in picks
the company. The Companies page is the hosted administrator's list, not the owner's. So today two stores are two
companies: no shared customers, gift cards that work in one store only, no combined reports, no transfers. **Locations
inside one company** are the right fit; the company stays the unit for billing, the hub and the company file.

**Price** (question 4): competitors charge per location (Square, Lightspeed, Shopify per location; Orderry $49-$179 per
extra location; RepairShopr's top tier for 2+). **Recommended: the location features are in the base program, and
each store is billed at the plan price, as the 3 Oct price list already says ("per location")**.

**Where the stores run** (question 5): **recommended: hosted first.** On the hosted service all of a company's stores
share one database, so nothing has to sync and no hub is involved (7.1 to 7.7). A store that wants the Windows program
on its own PC needs its stores kept in step through StitchHub (7.8), a separate and later piece of work; until then a
Windows shop opening a second store moves to hosted with the existing company move.

### 7.1 Locations, registers and settings per store

**Design**: Settings, **Stores**: "Add a second store" (the first is made from the company's own details). Each store
has its name, address, phone, hours, time zone, tax rate (and its state's tax holidays), receipt footer, and an
approval limit (7.5). With one store none of this shows. Staff have a **home store**; the register, tickets, classes,
appointments and shifts belong to a store; the store is picked once per device and shown in the top bar ("Florida").
Customers, gift cards and store credit are the company's, so they work at every store; each entry records where it was
used.

**Data**: `Location` (shopId, name, address, phone, timeZone, taxRatePct, hours JSON, receiptFooter, approveOverCents,
active, sortOrder); `locationId` on `Sale`, `Ticket`, `WebOrder` (pickup store), `StockUnit`, `PurchaseOrder`,
`ShopClass`, `AppointmentType`, `Shift`, `LongarmOrder`, `MakeJob`, `SpecialOrder`, `UnitLoan`, `GiftCardEntry`;
`User.locationId`; the migration makes one location per company and fills every row. Tax takes the location's rate
where it took `Shop.taxRatePct`. About 3.5 days.

### 7.2 Stock per store, counts and transfers

**Design**
- **Seeing it**: an item's page, the stock list and the register search show **"In this store: 2 · At Florida store:
  5"** (the other stores in smaller text; a store with none isn't listed). Bin and reorder point are per store.
- **Counts and adjustments** are per store: the count screen counts this store's shelves; an adjustment records the
  store and the person, as today.
- **Send to another store**: pick items and quantities, **Send**; the other store sees "Coming from New England store"
  and taps **It arrived** (the counts can be corrected on arrival; a difference is recorded as an adjustment there).
  Machines for sale move the same way.

**Data**: `StockLevel` (shopId, partId, locationId, qtyOnHand, reorderAt, bin), with `Part.qtyOnHand` kept as the sum in
the same transaction so every existing reader keeps working; `StockTransfer` (shopId, number, fromId, toId, status
ASKED | SENT | ARRIVED | CANCELLED, forCustomerId?, saleId?, askedAt, sentAt, arrivedAt, userIds) and
`StockTransferLine`; `MoveReason` gains `TRANSFER`; `StockMove.locationId`. About 4 days.

### 7.3 Selling and ordering across stores

**Design**
- **Selling what the other store has**: the register finds the item out here but "At Florida store: 5", and offers two
  plain choices: **Bring it here for her** (she pays now or leaves a deposit; a transfer request for her goes to
  Florida, the item is held there, and she gets the "it's here" message when it arrives, as with special orders), or
  **Ship it to her from there** (the sale is made here with her address; Florida gets a "Ship this" job like a web
  order to ship, and its stock comes off when it ships, with the tracking number on the sale).
- **One purchase order for several stores**: each line can say how many are for each store ("12: 6 here, 6 Florida").
  The receiving store receives the whole box and **Send Florida's share** fills in the transfer; or each store receives
  its own part when the supplier ships to both.
- **Reorder suggestions** per store or combined: the Reorder tab has "This store / All stores"; a combined order keeps
  the split per store.
- **Move slow stock to where it sells**: fabric insight's Slow fabric list (and a slow-items list for other kinds)
  shows "Sells faster at Florida store (6 yd in 8 weeks there, none here)" with **Send it there**, which fills in a
  transfer. A suggestion only; nothing moves by itself.

**Data**: `PurchaseOrderLine.split` JSON ({locationId: qty}); `StockTransfer.forCustomerId`, `shipTo`, `saleId`;
`WebOrder`-like ship jobs reuse `WebOrder` with `source: staff` and the selling store's sale. About 3 days.

### 7.4 Reports per store and combined

**Design**: every report has a store choice at the top: "Both stores" (the owner's default) or one store (staff's
default is theirs). The sales-tax report is per store (each state's return), the books export tags each line with the
store (a QuickBooks location or class). Gift-card liability stays company-wide. About 2 days.

### 7.5 The owner's phone: daily summary and approvals

**Design**
- **Today** page, made for a phone: one card per store with takings so far (by tender), sales, repair tickets waiting
  (and ready for pickup), low stock, who's on shift now, and anything waiting for her approval. Tap a card for the
  detail. A **daily summary** email or text at each store's closing time (owner's choice, on by default for owners
  with more than one store).
- **Approvals**: a refund or discount over the store's limit (setting, e.g. refunds over $200, discounts over 20%)
  stops at the register with two ways on: a manager there enters her code, or **Ask the owner**. The owner gets a text
  or email with a link (she signs in), sees the sale and the reason, and taps **Approve** or **Not this time**; the
  register screen moves on by itself.
- **Ask your shop** (5.1) answers across stores.

**Data**: `Approval` (shopId, locationId, kind REFUND | DISCOUNT, amountCents, reason, draft JSON, requestedById,
status ASKED | APPROVED | REFUSED | EXPIRED, decidedById, decidedAt); `User.approveCode` (hashed); the summary as a
notice kind `owner_daily`. About 3 days.

### 7.6 Bring an existing company in as a store

**Design**: an owner already running two companies (as today) chooses **Join into one company**: the second company's
items, customers (duplicates offered for merging with the existing merge), gift cards and history come in as a new
store, using the company file format (`src/lib/move/format.ts`). About 2.5 days.

### 7.7 Notes between stores and transfer requests

**Design**
- **Store notes**: a simple board on the Today page, "Notes between stores": a note to one store or all ("Florida: the
  Bernina rep visits Thursday"), read ticks, pinned notes at the top, older ones folding away. No chat app, no typing
  indicators.
- **Ask another store for stock**: from an item, **Ask Florida to send some** ("2 yards of this, for Jane by Friday").
  Florida sees it on its Today page with **Send it** (which makes the transfer, 7.2) or **Can't this time** (with a
  one-line reason). The asking store sees "Sent" then taps **It arrived**. The request is the transfer in status ASKED.

**Data**: `StoreNote` (shopId, fromLocationId, toLocationId?, userId, text, pinned, createdAt) and `StoreNoteRead`
(noteId, userId, readAt); transfer requests are `StockTransfer` rows in ASKED. About 1.5 days.

### 7.8 A store on its own Windows PC: keeping stores in step through StitchHub (later)

On hosted, 7.1 to 7.7 need nothing more. A store that runs the Windows program has its own database, so the stores
must exchange what they share. The hub already carries signed messages between partner companies
(`src/lib/partners.ts` and the hub's `partners.mjs`: signed envelopes, an outbox with retries, pinned keys, a failure
list instead of a stuck queue); store-to-store sync uses the same channel as a new kind of link, a **store link**
between installs of the same company (set up by the owner with a code shown on one PC and typed on the other, like a
partner invite, and pinned keys).

**What syncs and how conflicts are settled**
- **Customers**: each change goes as a message with the field, the new value and when. The latest change to each field
  wins; the older value stays in the customer's history, and two changes to the same field within a minute show on a
  "Check these" list. Duplicates found on both sides are merged with the existing merge (L126), never automatically.
- **Gift cards and store credit**: the ledger is add-only (entries never change), so stores send entries and every
  store adds them up: no conflict in the records. The one risk is the same card spent at two stores while one is
  offline: a store may spend a card only down to the balance it knows, redeeming over $50 (setting) needs the hub
  reachable, and a card that goes below zero after syncing shows to the owner as "Used at both stores while offline".
- **Stock levels for lookup**: each store sends its own levels every 15 minutes (only the owning store ever writes
  them); other stores show them read-only with the time: "At Florida store: 5 (at 10:42)". Selling from the other store
  (7.3) becomes a request it must accept, since its count may have changed.
- **Transfers and transfer requests**: like partner orders, a state machine where each step can only be sent by its
  side (the asking store asks and confirms arrival; the sending store sends or declines); stock moves on each side when
  its own step happens.
- **Store notes**: sent as messages; add-only, no conflicts.
- **Not synced**: sales, tickets, the books and each store's settings stay with the store that made them; combined
  reports and the owner's Today page read a daily summary each store sends (takings, tickets waiting, low stock,
  shifts). Approvals (7.5) travel as messages to the owner's install or, if she has none, by text or email as on hosted.

**Data**: program: `StoreLink` (shopId, linkId, locationId of the other store, keys pinned as `PartnerKey` does),
messages through `PartnerOutbox` with new types (`customer.change`, `gift.entry`, `stock.levels`, `transfer.*`,
`note.new`, `summary.daily`), `StockLevelRemote` (shopId, partId key, locationId, qty, asOf); hub: a `store` link kind
in `partners.mjs` that only joins installs of the same hub account. About 8 days (hub link kind 1.5, customers 2.5,
gift cards 1.5, transfers and notes 1.5, stock levels and daily summary 1). **Recommended: later**, only when a
multi-store shop needs Windows at each store.

## 8. Not building, and why

- **Embroidery digitizing**: it belongs to Wilcom, Hatch and Brother; the shop sells their software (2.5) instead.
- **"Smart" sales forecasting**: adds little for fabric, where most prints sell slowly and are never reordered; whether
  advanced methods beat simple ones there is "still debatable". Reorder points and fabric ordering are the right tool.

Also not designed, because the report doesn't recommend them: TikTok Shop (8% per sale, a poor fit), rain checks (no
source).

## 9. Later (dealer paperwork and the report's later items)

### 9.1 Warranty claims per maker
**Design**: on a ticket, a line marked **Claim it from the maker** charges the customer nothing and goes on a claim:
maker, claim number, parts, labour, the amount expected; **Paid** records what came in (short pays show). A list by
maker: filed, paid, short, refused; the money owed by each maker. Closed portals (Brother's) are not connected; this
logs and reconciles. **Books**: the expected amount is owed by the maker (a receivable) until paid.
**Data**: `WarrantyClaim` (shopId, ticketId, machineId, maker, claimNumber, filedAt, partsCents, laborCents,
expectedCents, receivedCents, receivedAt, status FILED | PAID | SHORT | REFUSED, note); `TicketLine.claimId`. 1.5 days.

### 9.2 Co-op advertising and rebate claims
**Design**: a list of claims: maker, program, what was spent (with a photo of the ad and invoice), what can be claimed,
the deadline (reminder on the dashboard 14 days before), filed, received.
**Data**: `CoopClaim` (shopId, maker, kind COOP | REBATE, program, spentCents, claimCents, deadline, filedAt,
receivedCents, receivedAt, note) and `CoopProof` (photos). 1 day.

### 9.3 Web prices below the maker's minimum advertised price
**Design**: an item or unit gets **Minimum advertised price**; when the online price is lower, its page shows the
minimum price and "Add to cart to see our price"; the cart shows the real one. Feeds (4.1, 4.2) leave such items out.
**Data**: `Part.mapCents`, `StockUnit.mapCents`. 1 day.

### 9.4 House charge accounts and many-machine service visits
The tax design's question 8 left house accounts out (7 Oct), and the report keeps them until a repair-shop customer
asks; designed here so it's ready (question 11). **Design**: a customer gets an **account** (limit, terms "30 days");
**On account** tender at the register and on tickets; a monthly **statement** (print or email); payments against it;
an "owed to us" list by age. A **service visit** for a school or business: one site ticket (the existing `TicketSite`)
with many machines, each with its own lines. **Books**: accounts receivable.
**Data**: `HouseAccount` (shopId, customerId, limitCents, termsDays, status), `AccountEntry` (charges and payments),
`Statement`; `TicketMachine` (ticketId, machineId, lines). 4 days. Gated.

### 9.5 Shipping labels
**Design**: **Export for Pirate Ship** from the web orders to ship (their file layout); the tracking number pastes
back as now. Shippo inside the program later (2 more days) if shops ask. **Data**: none. 1 day.

### 9.6 Customers' used machines on consignment
**Design**: a machine for sale can belong to a **consignor** (a customer): her price, the shop's commission (default
25%), the date to take it back or mark it down. Sold: the payout owed shows on her page; **Pay her** by check, cash
or store credit; a consignor statement. **Books**: what's owed to consignors is a liability; the shop's income is the
commission. **Data**: `StockUnit.consignorId`, `consignPct`, `consignUntil`; `ConsignPayout` (shopId, unitId,
customerId, amountCents, paidAt, method). 2.5 days. Needs machines for sale.

### 9.7 Sales commissions; "listed elsewhere" holds
**Design**: **Commissions**: who sold it, picked at the register (default the person signed in); the rule per staff
(percent of machine sales, or of everything); a report per period. **Listed elsewhere**: a unit marked "Also listed on
eBay / Etsy / Marketplace" with the link; selling it at the register asks "Take it down on eBay first", ticked
before the sale finishes. **Data**: `SaleLine.soldById`; `User.commission` JSON; `StockUnit.listedOn` JSON. 1.5 days.

### 9.8 Quilt appraisal certificates
**Design**: **New appraisal** (customer, the quilt's size, maker, date, techniques, condition, photos, value, the
appraiser and her credential); the fee rung up like a longarm order; prints a certificate with a photo and a number.
**Data**: `Appraisal` (shopId, number, customerId, details JSON, valueCents, appraiser, photos, feeCents, saleId,
issuedAt). 1.5 days.

### 9.9 Wish lists and gift registries
**Design**: once want lists are used: her want list can be **shared** (a link she sends to family); a buyer at the
counter or online sees it and the bought items are ticked off without telling her. **Data**: `WantItem.shared`,
`boughtLineId`; `Customer.wishToken`. 1.5 days. Needs 1.4.

### 9.10 Thread match from a phone photo
**Design**: offered only as "Pull these and check": a photo of her thread or fabric, and the model picks the closest
few threads in stock by color; the screen says to check against the swatch card. **Data**: feature `thread_photo`.
1.5 days. Gated on shops asking.

### 9.11 Listing photo clean-up and counting spools from a rack photo
Not worth building yet (the report): Google's Product Studio cleans photos free and fabric color accuracy matters
more; spool counting is unproven. Revisit if shops ask; no design now.

### 9.12 Reading Facebook Live comments into the claim list
Needs Meta's approval; a large job. After 4.3 is used. About 5 days once approved. Gated.

## 10. Build order

Each package is its own branch off the release (after `sales-features` is merged), 1-4 days, with checks and a
browser spec, run one at a time on this PC. Schema changes go one package at a time (one schema editor).

**Phase 1: must-have for launch customers** (the report's four gaps)
| Package | Section | Days | Needs |
|---|---|---|---|
| `po-any-item` | 1.1 | 1.5 | |
| `special-orders` | 1.2 | 3 | `po-any-item` |
| `pay-links` | 1.3 | 1.5 | |
| `want-lists` | 1.4 | 1.5 | `special-orders` (the message kind) |
| `price-groups` | 1.5 | 2.5 | `sales-features` promotions (stacking rule) |
| `birthdays-yard-breaks` | 1.6 | 1.5 | `price-groups` |
| `loaners` | 1.7 | 2.5 | machines for sale (`sales-features`) |
| `rentals-trials` | 1.8 | 2 | `loaners`, `pay-links` |
| `trade-up` | 1.9 | 1 | machines for sale |
| `invoice-reader` (AI) | 1.10 | 3 | `po-any-item` |
| | | **20** | |

**Phase 2: selling thread, accessories, software and maker crafts**
| Package | Section | Days | Needs |
|---|---|---|---|
| `item-details` | 2.1, 6.2 | 2.5 | |
| `color-lookup` | 2.2 | 1.5 | `item-details` |
| `catalog-any-item` | 2.3 | 2 | `item-details`, `po-any-item` |
| `fits-machines` | 2.4 | 2.5 | |
| `software-codes` | 2.5 | 2.5 | |
| `maker-machines` | 6.1 | 1.5 | machines for sale, `item-details` |
| `supplies-due` (Maker Shop module) | 6.3 | 2 | `maker-machines` |
| `maker-space` (Maker Shop module) | 6.4 | 1.5 | |
| `make-jobs` (Maker Shop module) | 6.5 | 3 | |
| | | **19** | |

**Phase 3: strong next: channels, events, switching**
| Package | Section | Days | Needs |
|---|---|---|---|
| `product-feeds` (Google, Meta) | 4.1, 4.2 | 3 | the online shop (hosted) |
| `live-sales` | 4.3 | 3 | `pay-links` |
| `repricing` | 4.4 | 2.5 | `po-any-item`; better after `invoice-reader` and `catalog-any-item` |
| `events` | 4.5 | 3.5 | `pay-links` |
| `switch-imports` | 4.7 | 2.5 | sample exports (question 13) |
| `shop-hop-hub` | 4.6 | 4 | an organizer's yes (question 1) |
| `shop-hop-program` | 4.6 | 1.5 | `shop-hop-hub` |
| | | **20** | |

**Phase 4: strong next: AI**
| Package | Section | Days | Needs |
|---|---|---|---|
| `ask-your-shop` | 5.1 | 4 | |
| `marketing-drafts` | 5.2 | 2 | |
| `quilt-planner` (no AI) | 5.3 | 2 | |
| `quilt-from-stock` (AI) | 5.3 | 3 | `quilt-planner`, `item-details` (thread step) |
| `trade-in-helper` | 5.4 | 1.5 | machines for sale, `trade-up` |
| `pickup-sheet-and-insight-words` | 5.5 | 1.5 | |
| `customer-answers` | 5.6 | 4 | |
| `status-link` (phone service) | 5.6 | 1.5 | `customer-answers` (the same answers) |
| | | **19.5** | |

**Phase 5: more than one store** (moves ahead of phase 3 if a launch shop has two stores: question 6)
| Package | Section | Days | Needs |
|---|---|---|---|
| `locations` | 7.1 | 3.5 | hosted; best after phases 1-2 so their new tables get `locationId` from the start |
| `stock-per-location` | 7.2 | 4 | `locations` |
| `stock-between-stores` | 7.3 | 3 | `stock-per-location`, `pay-links` (shipping from the other store) |
| `location-reports` | 7.4 | 2 | `locations` |
| `owner-phone` | 7.5 | 3 | `locations`; `ask-your-shop` for the AI part (+0.5) |
| `store-notes` | 7.7 | 1.5 | `stock-per-location` (transfer requests) |
| `join-companies` | 7.6 | 2.5 | `stock-per-location` |
| | | **19.5** | |

**Phase 6: later** (dealer paperwork and gated items)
| Package | Section | Days | Needs |
|---|---|---|---|
| `warranty-claims` | 9.1 | 1.5 | |
| `coop-claims` | 9.2 | 1 | |
| `map-prices` | 9.3 | 1 | before `product-feeds` if a dealer sells online |
| `ship-export` | 9.5 | 1 | |
| `consign-machines` | 9.6 | 2.5 | machines for sale |
| `commissions-listed` | 9.7 | 1.5 | machines for sale |
| `appraisals` | 9.8 | 1.5 | |
| `gift-registry` | 9.9 | 1.5 | `want-lists` in use |
| `house-accounts` (gated) | 9.4 | 4 | a repair-shop customer asks |
| `card-reader` (gated) | 4.8 | 6 | a launch shop asks |
| `thread-photo` (gated) | 9.10 | 1.5 | `item-details`, shops ask |
| `shippo` (gated) | 9.5 | 2 | shops ask |
| `fb-comments` (gated) | 9.12 | 5 | Meta's approval, `live-sales` |
| `store-link-hub` (gated) | 7.8 | 4 | phase 5; a store link kind on the hub, stock levels, transfers, notes, daily summary |
| `store-sync-customers` (gated) | 7.8 | 2.5 | `store-link-hub` |
| `store-sync-gift-cards` (gated) | 7.8 | 1.5 | `store-link-hub` |
| | | **38** | |

## 11. Size

About **136 days** in all: phase 1, 20; phase 2, 19; phase 3, 20; phase 4, 19.5; phase 5, 19.5; phase 6, 38. Of
these, 32 days are gated on an outside answer (shop hop 5.5, card reader 6, house accounts 4, Facebook comments 5,
Shippo 2, thread photo 1.5, Windows-per-store sync 8), so about **104 days** without them. Multiple stores on hosted
is 19.5 days; a store on its own Windows PC adds 8.

## 12. Questions for the owner

1. Shop hop passports: ask a hop organizer before building? **Recommended: yes, ask one first** (Denise's hops are
   the natural start); build only if they'd use it in a coming hop.
2. Card reader (Stripe Terminal): build only if a launch shop asks? **Recommended: yes, only then**; shops keep their
   own terminal and record the tender meanwhile.
3. Which outside phone-answering service? **Recommended: don't pick one now**; ship the status link (5.6) and test with
   the service the first interested shop already uses or chooses; no phone AI built by us.
4. More than one store: price? **Recommended: the store features in the base, each store billed at the plan price**
   (the 3 Oct "per location" rule; no new add-on).
5. More than one store: where do they run? **Recommended: hosted first** (one database, no sync, 19.5 days); a store
   on its own Windows PC synced through the hub (7.8, 8 more days) only when a multi-store shop needs it; meanwhile a
   Windows shop opening a second store moves to hosted with the company move.
6. When to build stores (phase 5)? **Recommended: after phases 1-4**, ahead of phase 3 if a launch shop has two stores.
7. Crafts (section 6): base or module? **Recommended: selling the machines and supplies in the base; a Maker Shop
   module ($10 a month, in the everything bundle) for supplies-due reminders, maker-space time and print/cut jobs.**
8. Loyalty: price groups and birthdays now, points later? **Recommended: yes**; points and printed cards only when
   customers ask (`reward-cards-design.md`).
9. A group discount and a promotion on the same line: **Recommended: the bigger one, not both** (a shop setting).
10. Special-order deposits by default: **Recommended: refundable as store credit**; the shop marks an item
    non-refundable (kit pre-registrations); the slip prints the rule. The layaway lawyer question covers both.
11. House accounts: the 7 Oct answer was "leave out"; with "I want it all", keep it designed and gated? **Recommended:
    yes, build only when a repair-shop customer asks** (phase 6).
12. Customer-facing answers: count typed questions against the shop's Assistant allowance with a cap of 20 a day, the
    buttons free? **Recommended: yes.**
13. Switching imports need a sample export from Square, Rain or Like Sew and QuickBooks POS: **Recommended: ask the
    first switching shop for its files** (with customer details removed) rather than guess the layouts.
14. Software returns once activated: refuse at the register, with an owner or admin override and a reason?
    **Recommended: yes.**
15. Print/cut job files: delete 30 days after pickup? **Recommended: yes** (customers' files are theirs, and they're
    big).

## Built

**`po-any-item` (1.1, 7 Oct 2026, branch `phase2-selling`).** Migration `20261020000000_po_any_item` (`PoUnit` gains
`EACH`). Code: `src/lib/fabric-orders-math.ts` (pieces math, `amountText`, `orderAmountText`, `eachSuggestion`),
`src/lib/fabric-orders.ts` (`addItemsToDraftFor`, `reorderEachFor`, `orderOneFor`; lines by hand take any item),
`src/actions/fabric-orders.ts` (`addItemsToOrders`, `orderMore`); pages moved to Parts (Inventory) → **Orders to
suppliers** (`/parts/orders`, `/parts/orders/[id]`, its print page; the old `/fabric/orders/...` links redirect), with
**Order more** in the Stock box of every item's page. Check: `scripts/checks/po-any-item.check.ts` (7 groups);
`fabric-orders` and `connectors` still pass.
Decisions made while building:
- An order line for anything not sold by the yard is in pieces (EACH) whatever the form says; fabric keeps yards and
  bolts. `PurchaseOrderLine.receivedYards` holds pieces for an EACH line (no column renamed, so nothing to migrate).
- "Running low" uses each item's own reorder point: at or below it (a sent order counts), the suggestion brings stock
  back up to twice the point (at least 1). Kits, the fat quarters / half yards / remnants that fabric is cut into, a
  partner's consigned stock and fabric by the yard (it has its own Reorder tab) are left out.
- A tech can order but can't type a cost (refused in words; a tech's save keeps each line's cost).
- Orders open for every company now (a repair bench orders parts too), not only shops with a counter.
- Browser test needed: `/parts/orders` (tick, amounts, "Add ticked items to draft orders", Start an order by hand), an
  order page with fabric and pieces lines (save, send, "When the box arrives", "Receive what came"), the item page's
  Order more, the old `/fabric/orders/<id>` link; `tests/fabric.spec.ts` updated for "Receive what came".

**`item-details` (2.1 and 6.2, 7 Oct 2026).** Migration `20261020100000_item_details` (`Part.colorNumber`, `colorName`,
`colorHex`, `material`, `itemType`, `specs` JSON, an index on shop and type). Code: `src/lib/item-details.ts` (pure: the
types, their fields, "What is it?" choices, forgiving input, the one-line summary), the short lists in
`src/lib/constants.ts`, `src/components/item-details-fields.tsx` (the item form's "What is it?" list and the chosen type's
details), `src/components/color-dot.tsx`; `src/actions/parts.ts` saves them; the item page and the Parts / Inventory list
show the summary with its swatch, and the list's search reads color number, name and material. Check:
`scripts/checks/item-details.check.ts` (5 groups); `move-export` still passes.
Decisions made while building:
- "What is it?" is one list: the plain kinds, then (for shops with a counter) "Cutters, lasers and 3D printers": filament,
  resin, cutter blade, cutting mat, vinyl and laser material (filed as supplies) and dies (accessories). A thread saved
  before this is still a thread (its type is read from its kind), so no data was changed by the migration.
- Only the chosen type's fields are kept; switching an item to a type without details clears them. A form without the
  details (an import, an older tab) leaves them as they are.
- Each list (fibres, weights, spools, filament materials...) is a suggestion: a word of the shop's own is kept as typed,
  and a list word typed in any case or spacing is saved as listed ("5000 m cone" -> "5,000 m cone"). Numbers get their
  unit ("40" -> "40 wt", "1kg" -> "1 kg", "500" -> "500 ml").
- The swatch is picked with the color picker (or "No swatch"); picking it from a photo of the spool is left for
  `thread-photo` (9.10).
- Browser test needed: the add form and an item's Details with each type (the details box appears and swaps; the swatch
  picker and "No swatch"), the item page's summary line, the Parts list's summary and search ("0015", "navy", "PETG").

**`color-lookup` (2.2, 7 Oct 2026).** Migration `20261020200000_color_lookup` (`Part.sameAs`, plain ids kept both
ways). Code: `src/lib/color-match.ts` (pure: the words split and scored), `src/lib/colors.ts` (the lookup, "colors
bought before", the shop's own matches), `src/actions/colors.ts`; the register's search puts color hits first and shows
each hit's swatch and details, and its new **Find a color** button (`src/components/color-finder.tsx`) shows big swatches
with stock, bin and price, one tap to add; "Colors bought before" on the customer's page
(`src/components/customer-colors.tsx`); "Same color as" on an item's page (`src/components/same-color.tsx`). Check:
`scripts/checks/color-lookup.check.ts` (5 groups); `base-license` passes again (see below).
Decisions made while building:
- Every word typed has to match something on the item's details (color number, maker, color name, material, specs);
  a word found only in the description doesn't make a color hit. An exact color number ("15" = "0015") ranks above a
  near one, then in stock, then the shop's own before a partner's consigned stock.
- "Order it for her" waits for special orders (1.2, phase 1, not built on this branch): meanwhile a color with none on
  the shelf has **Order more**, which puts it on its supplier's draft order (`po-any-item`).
- With a customer chosen, Find a color opens on the colors she bought before (from sales that stand; voids and returns
  left out), each with when, in the shop's time zone. The headings use her first name, or "Colors bought before".
- The shop's matches ("same as Madeira 1147") are linked by number on the item's page, both ways, and shown under each
  hit with their stock; the program never guesses equivalents.
- `lapse-allow.ts`: `findColors` is a read; the layaway actions from `sales-features` that `base-license` was missing
  (`startLayaway`, `payLayaway`, `pickUpLayaway` by hand; `openLayaways`, `planChoices` reads) are listed, so that check
  passes again.
- Browser test needed: the register's search ("isa 15", "navy", "PLA black 1.75") and Find a color (big swatches, Add,
  Order more, the matches, a customer's colors), the customer page's "Colors bought before", an item's "Same color as".

**`catalog-any-item` (2.3, 7 Oct 2026).** Migration `20261020300000_catalog_any_item` (`FabricSupplier.defaultKind`).
Code: `CATALOG_FIELDS` (`src/lib/connectors/types.ts`) gains the type column and the 2.1 details (color number and name,
fibre or material, thread weight, spool size, filament diameter and spool weight, size), grouped main / fabric /
details; `readCatalogRows` reads them; `src/lib/connectors/catalog.ts` plans any item (`kindFromWords` in
`src/lib/item-details.ts` reads a type column in words); the import (`src/components/connector-forms.tsx`) asks "What's
on this list?" and folds the fabric and detail columns away; Parts → Orders to suppliers gains **Suppliers' lists** (each
supplier's import, "Add supplier"; owners and admins), beside the Fabric page's own. Check:
`scripts/checks/catalog-any-item.check.ts` (4 groups); `connectors` still passes.
Decisions made while building:
- Each row's type is its own Type column in words ("Thread", "Notions", "3D filament", "HTV"), else the list's type
  ("What's on this list?", saved on the supplier with the columns); a word the program doesn't know is read as the
  list's type and named among the partly read rows. A supplier that never set one stays fabric by the yard, as before.
- An item that is there keeps its kind: a notion row against fabric by the yard, a fabric row against a notion, and a
  partner's consigned stock are left alone and named. An item with no type takes the list's type when its kind is the
  same (a SUPPLY on a filament list becomes filament), then its details are filled or changed; specs are merged.
- New costs update the item's cost (Raise prices, 4.4, will read them when it is built); stock is never touched.
- Browser test needed: Parts → Orders to suppliers → Suppliers' lists (add a supplier, open it, choose a thread list,
  "What's on this list?", the folded columns, Preview, Bring them in), and the Fabric page's import still reading fabric.
- Sources (coordinator, 7 Oct): the import is built around a small source interface, `CatalogSource` in
  `src/lib/connectors/types.ts`, listed in `src/lib/connectors/sources.ts`. The spreadsheet upload is the first source;
  a distributor's own published feed or API (Notions Marketing, United Notions, Checker, Brewer, Tacony...) is one more
  entry whose `fetchCatalog` maps the feed to the same `CatalogRow`s, and `previewSourceFor` / `applySourceFor` put
  them through the same matching, preview and "Bring them in". A feed key is the shop's or the partnership's, stored
  sealed like the other secrets; no scraping, no wholesaler passwords. No feed is built (none is publicly documented
  yet); the settings form for a feed key comes with the first one. Rows carry a barcode (UPC/EAN column: kept among the
  item's numbers, so a scan finds it) and a picture address (reserved for feeds; nothing fetches pictures yet).
- Machines (coordinator, 7 Oct): a list can hold machine models. Migration `20261020400000_machine_models` (`PartKind`
  gains `MACHINE`). A machine model is an item of type "Machine model (to order)" with its kind (sewing, embroidery,
  serger and quilting machines as "sewing", vacuums, 3D and resin printers), model and the maker's warranty terms
  (Maker, Model, Type, Cost, MAP or list price, Warranty columns). It is ordered on a purchase order like anything else
  (in pieces); "When the box arrives" asks for a serial number for each one, and each becomes a machine for sale
  (`receiveUnitsFor` in `src/lib/units/`) at the line's cost and the model's price, its note naming the order and the
  warranty. The model itself is never stock: the register, the color lookup, "Running low" and Receive stock leave it
  out or refuse it in words. Left for later: cutters and lasers as machine kinds come with `maker-machines` (6.1);
  warranty months aren't read from the terms (the unit gets the shop's default months, the terms in its note); MAP is
  kept as the price, not enforced (9.3).

**`fits-machines` (2.4, 7 Oct 2026).** Migration `20261020500000_fits_machines` (`Part.fitsModels`, `fitsKeys`,
`fitGroupIds`; `FitGroup`, carried by the company file). Code: `src/lib/fits.ts`, `src/actions/fits.ts`; an item's
**Fits these machines** (`src/components/fits-section.tsx`: brand and model picked from the shop's models or typed, fit
groups ticked), Parts → **Fit groups** (`/parts/fit-groups`), **Fits their machines** on the customer's page
(`src/components/customer-fits.tsx`), the register's quiet lines (`src/components/register-fits.tsx`: "3 items fit
Jane's Brother PE800" with a customer chosen, "Goes with this Brother SE600" with a machine for sale on the sale; one
tap opens the list, each item has Add), and the online shop's **Fits your machine** picker. Check:
`scripts/checks/fits-machines.check.ts` (6 groups); `online-shop`, `move-export`, `base-license` still pass.
Decisions made while building:
- Models match on the model key alone, as everything else does (PE-800 is PE800). An item's labels and keys are kept
  side by side, so a brand of two words ("Baby Lock Altair") keeps the key of its model; in a fit group's list a
  two-word brand takes a comma ("Baby Lock, Altair").
- The register's lines show only what is on the shelf; a customer's machine with nothing that fits isn't mentioned.
  The machine's own bundle ("what comes with it") stays on the unit's line as before.
- Removing a fit group takes it off its items (they keep their own models), after one confirming tap.
- The free-text `fits` stays, labelled "Fits (notes)".
- Browser test needed: an item's Fits these machines (add, take off, groups), /parts/fit-groups, a customer's page, the
  register with a customer who owns a machine and with a machine for sale on the sale, the online shop's picker.

**`software-codes` (2.5, 7 Oct 2026).** Migrations `20261020600000_software_codes` (`PartKind` gains `SOFTWARE`;
`Part.licenseKind`, `licenseMonths`, `noReturnText`; `SoftwareLicense`, `SoftwareCode`; `Shop.softwareActivatedAtSale`)
and `20261020610000_software_renewals` (`SoftwareLicense.renewedFromId`, `returnLineId`). Code: `src/lib/software.ts`,
`src/actions/software.ts`; the register's software line (`src/components/software-line.tsx`: scan or type the code,
"Add the code later", the machine from the customer's own, "Renew their subscription"; a return's reason for an owner or
admin), `register-sale.ts` (prepare, apply, void), the receipt's licence notes (`src/components/sale-software-notes.tsx`:
product, code in full, customer, machine, renewal date, no-returns words), Parts → **Software licences**
(`/parts/software`: codes to fill in, renewals in the next 30 days, sold lately), the item's **Software licence** box
(once or subscription, words, codes on hand and loading them), **Software** on the customer's and the machine's pages
(codes masked, "Show the code"), Settings → Selling → Software (activated at sale), dashboard and register to-do lines,
and the new message kind `software_renew` (marketing; one friendly reminder per renewal date, sent by the notices
scheduler for shops with Marketing on, cancelled if the licence is renewed, ended or its date moves). Licences are in
the company file and the customer and machine merges. Check: `scripts/checks/software-codes.check.ts` (7 groups);
`customer-merge` (licences seeded), `messaging-core`, `notices`, `move-export`, `base-license`, `promotions`, `layaway`,
`machine-sales` still pass.
Decisions made while building:
- One licence a line (each has its own code); scanning the same software twice makes two lines.
- No code typed: the next code on hand (first loaded, first used); none on hand and "later" not ticked is refused in
  words. A typed code that is one of the codes on hand comes out of the drawer.
- Renewing makes a new licence carrying the same code from the old renewal date (or today, when that has passed); the
  old one is RENEWED. Voiding the renewal brings the old one back; a sale whose licence was renewed or returned since
  can't be voided until that sale is.
- Returns find the licence on the receipt's sale, else the customer's latest active one of that item. Not activated: it
  comes back and its drawer code goes back on hand. Activated: refused with the item's words; an owner or admin types a
  reason on the line and it is taken back, audited as `software.return`. Voiding the return makes it active again.
  A return scanned from a receipt shows no reason box (its lines don't say they are software): for activated software,
  ring the return up by the item instead.
- "Mark activated" is on each licence; un-marking and "Not renewing" (ENDED) are owner or admin.
- Codes are printed in full on the receipt (the customer's record) and masked everywhere else; they are in the company
  file (the shop's record) and never in anything sent to the hub or the Assistant.
- Browser test needed: an item set to Software (licence box, codes), the register's software line (code, later, machine,
  renew, a return with and without a reason), the receipt, /parts/software, the customer and machine pages, Settings →
  Selling → Software, the dashboard lines; the renewal reminder through the message worker with Marketing on.

**`maker-machines` (6.1, 7 Oct 2026).** Migration `20261020700000_maker_machines` (`StarterBundle`, carried by the
company file). Code: `src/lib/equipment/maker.ts` (craft cutter, fabric die cutter, laser cutter), `sellFree` and
`serialOptional` on equipment kinds (`src/lib/equipment/types.ts`; the 3D and resin printers are `sellFree` too),
`ShopKinds.sellable` / `sellableKind` / `sellsFree` (`src/lib/equipment/shop.ts`), the machines-for-sale gate per kind
(`src/lib/units/units.ts`, `sale-units.ts`, `layaway.ts`: `sellableMachines`, `isSellableMachine`, `requireForSale`),
`src/lib/starter-bundles.ts`, `src/actions/starter-bundles.ts`, Settings → Selling → **Starter bundles**
(`src/components/starter-bundle-settings.tsx`) and the register's **Add the starter bundle** button for a machine of
that kind on the sale (`StarterBundles` in `src/components/register-fits.tsx`); catalog machine models read these kinds
too. Check: `scripts/checks/maker-machines.check.ts` (4 groups); `machine-sales`, `vac-units`, `layaway`,
`modules-tenant`, `bags-due`, `equipment`, `equipment-lines` still pass.
Decisions made while building:
- Selling printers, cutters, die cutters and lasers needs no module (answer 7); the new kinds are appliance kinds, so
  repairing them is the Small Appliance Repair module's (they show on "What you repair" for a shop with it). A vacuum
  still needs Vac Shop to be sold.
- A fabric die cutter may be added without a serial; every other new machine still needs one (the warranty does).
- Serials, warranties, registration reminders, owner's classes and service plans are the machines-for-sale ones,
  unchanged; "what fits" (2.4) shows dies and accessories for a machine on the sale.
- A starter bundle is per kind (not per model) and holds items with how many each; the register adds them as ordinary
  lines (priced and taxed as items), one tap per machine.
- Browser test needed: /units "Add machines for sale" with the new kinds (a die cutter without a serial), the register
  selling a printer with no module and taking a laser in trade, Settings → Selling → Starter bundles, the register's
  starter bundle button.

**`supplies-due` (6.3, Maker Shop module, 7 Oct 2026).** Migration `20261020800000_supplies_due` (`SuppliesCare`,
carried by the company file and the machine merge). The **Maker Shop module** itself: `maker` in `MODULE_IDS`
(`src/lib/license.ts`), its name and blurb (`src/lib/module-info.ts`), the Companies switch, the menu item "Maker Shop"
(shown while the module is on), Maker Shop $10 a month / $100 a year in the everything bundle at the same $30 (pricing
docs), and its pages' frame (`src/components/maker/maker-page.tsx`: gate, header, tabs). Code: `src/lib/supplies-due.ts`
(a rule per machine kind: filament for 3D printers, resin, mats / blades / vinyl for craft cutters, laser stock, mats
for die cutters; the running-low date; the marks; the one-off send), `src/actions/maker-supplies.ts`, **Maker Shop**
home (`/maker`, 3D printers first) and **Supplies due** (`/maker/supplies`), the new message kind `supplies_due`
(marketing, sent by hand only, cancelled if she buys before it goes). Check: `scripts/checks/supplies-due.check.ts`
(5 groups); `customer-merge`, `modules`, `license`, `base-license`, `modules-tenant`, `modules-crossover`, `notices`,
`messaging-core`, `move-export` still pass.
Decisions made while building:
- Only machines sold here count (as the design says), each running-low date from her own purchases of that kind's
  supplies since: her average gap (two weeks to a year) after the last, else six weeks after the last (or after the
  machine's sale; 90 days for a die cutter's mats). The six weeks is fixed, not a setting.
- Listed a week ahead; a call or message from a week before the date takes it off; "Not yet" is 30 days.
- Vacuums keep their own bags-due list (its matching reads the finder); this one reads item types, so the two were not
  merged into one file. Same marks, same "never automatic" rule.
- The send is owner or admin and needs Marketing; the module ending makes the list read-only and cancels queued ones.
- The hub's own billing (StitchHub add-on prices and keys) needs Maker Shop added there too: a key can carry `maker`
  now, and `npm run license -- --modules maker` issues one.
- Browser test needed: the menu item with the module on and off, /maker, /maker/supplies (Called with a note, Not yet,
  Stop, Remind the n due now), Settings → Modules and the Companies switch showing Maker Shop.

**`maker-space` (6.4, Maker Shop module, 7 Oct 2026).** Migration `20261020900000_maker_space` (`Certification`,
carried by the company file and the customer merge; `AppointmentType.certFor`; every customer with `longarmCertifiedAt`
copied in as certified on "Longarm"). Code: `src/lib/certifications.ts`, `src/actions/certifications.ts`; **Certified
on** on the customer's page (`src/components/customer-certifications.tsx`: one tap to certify after the safety class,
"Take off"), replacing the longarm's own flag there; an appointment type's "Certified customers only, on the ___"
(`appt-type-form.tsx`); the booking check (`appointment-actions.ts`) reads the type's machine; Maker Shop →
**Maker-space time** (`/maker/space`: your machines by the hour, "Set up a machine by the hour", the next two weeks'
bookings, who is certified). Check: `scripts/checks/maker-space.check.ts` (5 groups); `longarm` (its wording updated),
`appointments`, `online-booking`, `customer-merge` (certifications seeded), `move-export` still pass.
Decisions made while building:
- A maker-space machine is an appointment type exactly like longarm rental (hourly rate, how many at once, what it
  uses up, bookable hours), with `certFor` naming the machine; a type with "certified only" and no machine is the
  longarm, so the longarm's types and certifications work as before. Certifying on, or setting up a type for, anything
  but the longarm needs Maker Shop; booking needs Scheduling (the calendar), as before.
- `Customer.longarmCertifiedAt` stays and is kept in step with the "Longarm" certification (both buttons), and a
  customer certified only by the old flag still books the longarm; removing the column is left for a later clean-up.
- Material used is rung up at the register beside the booking (no separate material log).
- Browser test needed: a customer's Certified on (certify, take off), Calendar → Types with a machine, /maker/space
  (set up, coming up, who is certified), booking a laser hour for a certified and an uncertified customer.

**`make-jobs` (6.5, Maker Shop module, 7 Oct 2026).** Migration `20261021000000_make_jobs` (`MakeJob` with the file as
bytes, carried by the company file and the customer merge and delete; `Shop.nextMakeJobNumber`, `makeRateCents` $20,
`makeSetupCents` $5, `makeNeverCut` "PVC, vinyl"; `EstimateLink.makeJobId`). Code: `src/lib/make-jobs-math.ts` (pure:
words, steps, material by the gram / ml / sheet, the price, the never-cut check), `src/lib/make-jobs.ts`,
`src/actions/make-jobs.ts`, `src/components/maker/job-form.tsx` (the price shown as it is typed), Maker Shop → **Print
and cut jobs** (`/maker/jobs`: open, Take a job, finished lately, Job prices), the job's page (`/maker/jobs/[id]`: the
next step as the one main button, Collected and paid, Send the quote, the file, Change the job, Turn it down), the job
slip (`/maker/jobs/[id]/print`, with "We decide what we'll print or cut"), the file download
(`/api/maker/jobs/[id]/file`); the estimate link (`src/lib/estimate-links.ts`) learned print and cut jobs (approving
moves the job to Approved); voiding the collecting sale puts the job back to Ready (`register-sale.ts`). Check:
`scripts/checks/make-jobs.check.ts` (7 groups); `estimate-links`, `customer-merge` (jobs seeded), `move-export`,
`longarm`, `base-license` still pass.
Decisions made while building:
- Statuses and kinds are text (as the machines-for-sale ones are), not new enums.
- Material is priced from the item: filament by the gram (its price over the spool's weight), resin by the ml (over the
  bottle), laser stock and vinyl by the sheet; it is billed as a line on the sale and does not take stock off the shelf
  (grams of a spool can't be counted in whole items). A material the customer brings is named in words, unpriced.
- A tech takes jobs at the shop's rate and set-up fee; owners and admins may change them per job.
- The laser's never-cut list (Job prices) refuses a job whose material names one of its words, from stock or typed.
- The Ready message goes when Marketing is on (an order-notice style text or email); otherwise call them.
- The customer's file is kept until 30 days after the job ends (collected, cancelled or turned down) and then deleted
  (the job keeps its name); deleting happens when Maker Shop's job pages are opened, and a file past its days can't be
  downloaded. A worker sweep for every company (`purgeJobFiles(null)`) is ready to be called if wanted.
- Not built: the customer's online job request (the design's "online request" wording is on the job slip and the
  quote's note), and a jobs list on the customer's page.
- Browser test needed: /maker/jobs (Take a job with a file and the live price, a tech's form, the never-cut refusal),
  a job's page through Approved, Printing, Ready, Collected (and a void), Send the quote and answering it on /e/...,
  Turn it down, the slip, the file download.

**`warranty-claims` (9.1, 7 Oct 2026, branch `phase6-later`).** Migration `20261024000000_warranty_claims`
(`WarrantyClaim`, `TicketLine.claimId`, `Shop.nextClaimNumber`; carried by the company file and the machine merge).
Code: `src/lib/warranty-claims.ts`, `src/actions/warranty-claims.ts`; on a ticket, **Claim it from the maker** on a line
(and "Charge it instead" while the claim isn't sent; the printed invoice says "Covered by the maker's warranty (no
charge)"); the new menu item **Paperwork** (`/paperwork`, `src/components/paperwork/frame.tsx`, tabs for this phase's
records) → **Warranty claims** (by maker: not sent, waiting, owed, paid, short, refused; the claims, filtered by status
or maker) and each claim's page (Mark it sent with their claim number, Record what came in, They refused it, Undo).
Books: two new accounts, "Due from Manufacturers" (owed from the day a claim is sent) and "Warranty Claims Income";
what came in clears the receivable on its day and a short or refused claim's rest comes off the income that day. Check:
`scripts/checks/warranty-claims.check.ts` (6 groups); `books-export`, `move-export`, `base-license` still pass. Spec:
`tests/warranty-claims.spec.ts`.
Decisions made while building:
- A claimed line works like a line covered by a service plan: its price moves to `coveredCents` and it charges 0, so
  ticket totals, invoices and reports needed no change. A line can't be both. Fees and discounts aren't claimed.
- Lines go on the ticket's claim that isn't sent yet, else a new one, made out to the machine's brand (changeable).
- "Not sent yet" is a step of its own before Sent (the design's FILED), so lines can be gathered first. Once sent, the
  lines and the amount expected are fixed; the amount expected follows the lines until an owner types over it (makers
  pay labour at their own rate). A tech can claim lines and send; recording money, refusals and undo are owner or admin.
- Nothing connects to the makers' portals (Brother's and others are closed): the shop sends there by hand.

**`coop-claims` (9.2, 7 Oct 2026).** Migration `20261024100000_coop_claims` (`CoopClaim`, `CoopProof`,
`Shop.nextCoopNumber`; both carried by the company file). Code: `src/lib/coop-claims.ts`, `src/actions/coop-claims.ts`,
Paperwork → **Co-op and rebates** (`/paperwork/coop`: owed to you by maker, not sent yet by deadline, "Add a claim",
sent and settled) and each claim's page (the proof photos, "I sent it to Brother", Record what came in, They turned it
down, Undo, details), the proof route `/api/paperwork/coop-proof/[id]`, and a dashboard and register line "Send co-op
claim #3 to Brother: due Tue, Oct 21, 2026" 14 days before the deadline while it isn't sent (owners and admins). Books:
"Co-op and Rebates Received" when the money comes in. Check: `scripts/checks/coop-claims.check.ts` (5 groups);
`books-export`, `move-export` still pass. Spec: `tests/coop-claims.spec.ts`.
Decisions made while building:
- Co-op and rebates are one list with a kind (co-op advertising or rebate). A co-op claim left blank claims half of
  what was spent (the usual program); a rebate's amount is typed.
- Owners and admins keep the list (it is marketing money); techs can read it.
- The proof is a photo (JPEG, PNG, WebP, HEIC) or a PDF, 5 MB at most, as many as needed. Nothing is booked when the ad
  is paid (that is the shop's own bill); the books get the money back when it comes in.

**`map-prices` (9.3, 7 Oct 2026).** Migration `20261024200000_map_prices` (`Part.mapCents`, `StockUnit.mapCents`).
Code: `src/lib/map-math.ts` (`belowMap`), `src/lib/map-prices.ts` (`setMapFor`, `mapProblems`), `src/actions/map-prices.ts`,
`src/components/map-price.tsx` (the item's and the machine's **Minimum advertised price** box with its warning, and
`MapWarnings`); the online shop's catalog and item page show the minimum and "Add to cart to see our price" when the
real price is lower (`shownPrice` in `src/lib/shop/online-shop.ts`; the real price is never in those pages), the cart
shows the real one. The list of prices advertised below a minimum shows on Settings → Selling → Sales (promotions on now
or coming that bring an item or machine under) and on a new or draft campaign (everything: the item's own price and
the sales). Check: `scripts/checks/map-prices.check.ts` (5 groups); `online-shop` still passes. Spec:
`tests/map-prices.spec.ts`.
Decisions made while building:
- The price at the counter and in the cart may be below the minimum (that is how MAP works); only advertising is
  checked. The register is not changed.
- Campaign emails are free text, so the program doesn't read prices out of them: the draft page lists the items whose
  price or sale price is under a minimum, as a reminder not to put those prices in.
- Machines for sale aren't in the online shop yet; their minimum shows on the machine's page and in the list. The
  Google and Meta feeds (4.1, 4.2, phase 3) should leave out, or show at the minimum, anything `belowMap`.
- Fabric by the yard gets no minimum box (makers don't set MAP on fabric).

**`ship-export` (9.5, 7 Oct 2026).** No migration. Code: `src/lib/ship-export.ts` (pure: `splitAddress`,
`pirateShipRows` in Pirate Ship's spreadsheet layout: Name, Company, Address, Address Line 2, City, State, Zipcode,
Country, Email, Phone, Order ID, Order Items, then weight and size left blank), `src/lib/ship-orders.ts`
(`ordersToShip`: paid, to post, no tracking yet), the download `/api/shop-orders/pirate-ship`, and on Online orders a
box "3 orders to post" with **Export for Pirate Ship** (and the orders whose address was split by guesswork). The
tracking number is pasted back with Shipped, as before. Check: `scripts/checks/ship-export.check.ts` (3 groups). Spec:
`tests/ship-export.spec.ts`.
Decisions made while building:
- The online shop takes the address as one box of text, so the export splits it (lines or commas, the name on the
  first line dropped, "State ZIP" at the end, ZIP+4, "USA"); anything else goes in Address whole and is named on the
  page so it is checked in Pirate Ship, which validates every address on import anyway. Splitting the checkout's box
  into fields would make this exact; left as it is so the checkout doesn't change.
- Items carry no weight, so Pirate Ship asks for the weight (or uses the shop's saved package there).

**`consign-machines` (9.6, 7 Oct 2026).** Migration `20261024300000_consign_machines` (`StockUnit.consignorId`,
`consignPct`, `consignUntil`; `ConsignPayout`; `Shop.consignDefaultPct`, 25). Code: `src/lib/consign-machines.ts` (the
sale hooks `payoutOnSale` / `payoutOnReturn` / `payoutOnVoidSale` / `payoutOnVoidReturn`, called from
`src/lib/units/sale-units.ts`; set, give back, pay, undo, the statement), `src/actions/consign-machines.ts`, the machine
page's **Consignment** box ("A customer's machine? Sell it for her": the customer, the shop keeps %, the give-back
day; "Give it back to her unsold"), Paperwork → **Consigned machines** (owed to consignors with **Pay her** by check,
cash or store credit; the machines on consignment, give-back day first; paid lately; the usual commission), the
printable **consignment statement** (`/paperwork/consign/[customerId]`), and "Her machines on consignment" on the
customer's page (`src/components/paperwork/customer-paperwork.tsx`, which later packages add to). Books: "Due to
Consignors": her share comes off the machine sales on the day it sells and is owed until paid (cash or check out of
undeposited funds; store credit through her card). Merges and the customer delete carry the consignor and payouts
(the delete is refused while she is owed or her machine is for sale). Check: `scripts/checks/consign-machines.check.ts`
(6 groups); `machine-sales`, `layaway`, `customer-merge` (seeds the new columns, and `WarrantyClaim.machineId` from
`warranty-claims`), `move-export`, `books-export` still pass. Spec: `tests/consign-machines.spec.ts`.
Decisions made while building:
- Her share is worked out on what the machine sold for before tax, after its line discount and its part of a
  whole-sale discount (as `soldNetCents`), less the commission at the time it was set on the machine.
- A return before she was paid takes the payout back; after she was paid it stays (the shop paid her and has the
  machine back: sell it again as the shop's own, or settle with her by hand). Voiding the sale is refused while she is
  paid; "Undo" her payment first (check or cash; store credit is taken back by adjusting her card).
- A consigned machine carries no cost (the shop paid nothing for it).

**`commissions-listed` (9.7, 7 Oct 2026).** Migration `20261024400000_commissions_listed` (`SaleLine.soldById`,
`User.commission`, `StockUnit.listedOn`, `Part.listedOn`). Code: `src/lib/listed-math.ts` (pure), `src/lib/commissions.ts`
(listing, the register's `checkDelisted` / `clearUnitListings` / `sellerFor`, the rules and `commissionReport`),
`src/actions/commissions.ts`; `completeSaleAs` takes `soldById` and each line's `delisted`; the register's **Sold by**
picker (shown when the company has two or more people, starting on the person signed in) and the line's tick "Take it
down on eBay first: done" (Complete sale waits for it); **Also listed on** on a machine's and an item's page
(`src/components/listed-elsewhere.tsx`: eBay, Etsy, Facebook Marketplace, Craigslist, their own website or a place
typed, each with its link); Paperwork → **Commissions** (owners and admins: each person's month, machines and
everything, the commission by their rule, the month before; each person's rule). Check:
`scripts/checks/commissions-listed.check.ts` (5 groups); `promotions`, `layaway`, `gift-cards`, `software-codes`,
`machine-sales`, `make-jobs`, `online-shop`, `store-credit`, `tax-holidays` still pass. Spec:
`tests/commissions-listed.spec.ts`.
Decisions made while building:
- The seller is one per sale (every line carries it); the online shop's sales have none. A layaway's pick-up sale
  counts for the person ringing it up.
- Commission is on each line's price less its own discount, before tax; returns take off, voids drop out; gift cards,
  layaway payments and partner repair bills don't count, nor trade-in credit.
- A machine asks for the tick whenever it is listed; an item only when the sale takes its last one (the listing can
  stay up while there are more). A machine's listings are cleared when it sells (voiding the sale doesn't put them back).
- Listings are recorded by anyone; the rules by owners and admins.

**`appraisals` (9.8, 7 Oct 2026).** Migration `20261024500000_appraisals` (`Appraisal`, `AppraisalPhoto`;
`Shop.nextAppraisalNumber`, `appraisalFeeCents` $75, `appraiserName`, `appraiserCredential`; carried by the company
file, the merges and the customer delete). Code: `src/lib/appraisals.ts`, `src/lib/appraisals-words.ts`,
`src/actions/appraisals.ts`, `src/components/appraisal-fields.tsx`; **Quilt appraisals** (`/appraisals`, from the
Longarm page's header and the customer's page: the list, "New appraisal" with a new or existing customer, the shop's
appraiser and fee), each appraisal's page (photos, "Issue the certificate" with how the fee was paid, the draft's
details) and its printable **certificate** (`/appraisals/[id]/certificate`: number, date, shop, owner, the first photo,
the quilt, the value and what it is for, the appraiser's signature line and credential); photos at
`/api/appraisal-photos/[id]`. Check: `scripts/checks/appraisals.check.ts` (3 groups); `customer-merge`, `move-export`
still pass. Spec: `tests/appraisals.spec.ts`.
Decisions made while building:
- Issuing rings the fee up as its own register sale (like a print job's pickup), untaxed: an appraisal is a service.
  A shop in a state that taxes it can ring it up by hand instead (fee 0 on the appraisal).
- An issued certificate can't change (a new appraisal replaces it); voiding the fee's sale makes it a draft again.
- The value is what the appraiser writes; a tech can do appraisals but not change the fee.
- Deleting the customer keeps the appraisal (the fee's record) without her name or the photos.

**`gift-registry` (9.9, 7 Oct 2026).** Migration `20261024600000_gift_registry` (`GiftRegistry`, `RegistryItem`,
`SaleLine.registryItemId`; carried by the company file, the merges and the customer delete). Code:
`src/lib/gift-registry.ts`, `src/actions/gift-registry.ts`; **Wish lists** on the customer's page ("Start a wish list or
gift registry she can share with family": its name and day), the list's page (`/gift-lists/[id]`: what she would like,
how many, "n of m bought" for staff, the link to send with Copy, Stop sharing / Share it again, add from stock with the
part box or in words), the register's **Gift lists** button (`src/components/register-gift-lists.tsx`: find her list by
name, what is still wanted, Add puts the item on the sale as a "gift: <list>" line), and the public page
`/shop/[slug]/wish/[token]` (what is still wanted, linked to the online shop's item pages; nothing about buyers or
prices). Check: `scripts/checks/gift-registry.check.ts` (4 groups); `base-license` (`findGiftLists` is a read),
`customer-merge`, `move-export`, `register-bookings` still pass. Spec: `tests/gift-registry.spec.ts`.
Decisions made while building:
- Built on its own list (`GiftRegistry`), not on want lists (1.4, phase 1, built on another branch): when `want-lists`
  merges, its `WantItem` can be shared through the same page and the register line, or its rows folded into these.
- What was bought is counted from the sales that stand (a void puts it back by itself); a return of a gift is an
  ordinary return and doesn't put it back on her list.
- The link lives on the shop's public address (`/shop/<slug>/...`, already public and on the links address), so a
  shop needs its page address (Settings → Online shop) to share lists; the token is random and changes when the list
  is shared again. Online purchases don't tick the list off yet (the cart has no list line); the public page tells
  buyers to say so at the counter.

**`house-accounts` (9.4, built 7 Oct 2026 on the owner's "everything today"; question 11's gate lifted).** Migration
`20261024700000_house_accounts` (`HouseAccount`, `AccountEntry`, `Shop.houseAccountsOn` off by default; carried by the
company file, the merges and the customer delete). Code: `src/lib/house-accounts-math.ts` (pure: balance, aging,
statement), `src/lib/house-accounts.ts`, `src/actions/house-accounts.ts`; the register's **On account** payment
(`ACCOUNT` tender, shown with a customer picked while house accounts are on; the server checks her open account and
limit; a void takes the charge off, a refund to the account goes on it), a ticket's existing "Invoice (on account)"
payment for a customer with an account goes on it (removing the payment takes it off), Paperwork → **House accounts**
(the owner's "Turn on house accounts" switch, "Owed to us" by age: current, 31-60, 61-90, over 90, with last month's
statement to print), each account's page (Take the payment: check with its number, cash, card; Undo; by age; charges
and payments; print or **Email** last month's statement with Messages on; limit, days to pay, closed to new charges),
the printable **statement** (`/paperwork/accounts/[id]/statement?month=`), and "House account" on the customer's page
(open one: limit and days to pay). Books: On account tenders are accounts receivable (as ticket invoices already were);
payments against an account move it to undeposited funds (or card clearing). Check:
`scripts/checks/house-accounts.check.ts` (7 groups); `customer-merge` (seeds `HouseAccount`; its schema scan now skips
a column that keys a relation to another model, like `AccountEntry.accountId`), `move-export`, `books-export`,
`gift-cards`, `store-credit`, `financing`, `reports`, `money-records` still pass. Spec: `tests/house-accounts.spec.ts`.
Decisions made while building:
- Statements are worked out from the entries when printed or emailed (no Statement table): a month's opening balance,
  charges, payments, what is owed and the due day (the month's end plus her days to pay). Emailing uses the
  transactional notice kind, one per account and month.
- Aging pays the oldest charges first. A credit balance shows as a negative current amount.
- Turning house accounts off stops new charges; what is owed stays and payments still go in.
- Left for later: many-machine service visits for a school or business (`TicketMachine`, the other half of 9.4);
  meanwhile each machine is its own ticket, all charged to the same account.
