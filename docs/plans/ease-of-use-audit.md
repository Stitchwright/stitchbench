# Ease-of-use audit (7 Oct 2026)

Audit of the running test build (http://localhost:3300, branch `scheduling-features`) against `ease-of-use.md`. Read
as a 65-year-old shop employee would meet it: on a counter PC (1366 x 768), a 10-inch tablet held sideways
(1024 x 768) and an iPad upright (820 x 1180). No app code was changed.

How it was done: Playwright with Chrome. Busy-shop screens are from the E2E Test Shop; first-run and the everyday
tasks were done in a fresh company made for this audit, "UX Review Quilts" (repairs and counter, Scheduling on;
owner `ux-owner@stitchbench.test`, left in the dev database). Nothing was sent: messaging is not set up in that
company. Screenshots are in `ease-of-use-shots/`.

Measured on every screen checked (script counts visible buttons, links and fields, and the font size of visible text):
- 80 to 90% of visible text is smaller than 16px; 30 to 50% is smaller than 14px (field labels 12px uppercase, table
  headers 12px, small buttons 12px, hints 12px).
- Almost no tap target reaches 44px. Fields are 42px (close). Small buttons (`btn-sm`: Cash, Card, Sign up, Receive,
  Print labels, Cut into 4 fat quarters) are about 26px tall; on the ticket page 50 targets are under 24px, below the
  WCAG 2.2 AA minimum.
- Contrast: body text is fine (ink-2 on cream 6.9:1). Fails: input borders #d9d4c7 on white 1.5:1 (WCAG 1.4.11 wants
  3:1, so on a tablet in daylight the boxes almost vanish); placeholder text about 3.2:1 (needs 4.5:1, and the app
  uses placeholders as labels in places); the amber "Waiting on customer OK" pill 4.2:1 at 12px; disabled buttons.

What already works well, and should be kept: plain, friendly sentences in most help text and error messages
("Enter the customer's name and phone, so you can call them when it's ready"); verbs on many buttons ("Check in a
machine", "Cut into 4 fat quarters", "Add the collection"); the dashboard count tiles are links; the scan box keeps
focus and scans can't land in a Qty field; return mode is visibly marked; label printing is one clear page;
two-tap instead of pop-up confirms; pretty good empty states on Fabric and the dashboard.

## 1. Task by task

### Sign in, dashboard, menu
Works: the sign-in card is clean and large (`login` not saved). The dashboard's "Check in a machine" is the obvious
main button; the status tiles open the matching list.
Would trip her up:
- The menu has 28 items for an owner of a repair-and-counter shop (`03-sidebar-tablet-820.png`): Register,
  Dashboard, Tickets, Invoices, Machines, Customers, Calendar, Classes, Parts, Fabric, Longarm, Partner shops,
  Marketplace, Factory specs, Shared by techs, Manual links, My manuals, Scan a manual, Price list, Sales log,
  Register sales, Online orders, Reports, Settings, Community chat. On a 768-tall screen Settings and Sign out are
  below the fold. "Sales log" and "Register sales" sit side by side and mean different things.
- A new company lands on seven "0" tiles and two empty boxes, with no hint of what to set up first
  (`02-first-run-dashboard-1366.png`).
- A busy shop's dashboard is a list of 87 tickets with 12px serial numbers (`01-dashboard-busy-1366.png`).
- The search box in the menu ("Serial, model, customer, ticket") is cut off and 14px.

### Register: a sale with an item and a cut of fabric, cash, a return
Works: scan or type into one big box; fabric lines show "2 1/2 yd" under the Qty; the total is bold; return mode turns
the button navy and shows a yellow banner (`08-register-return-1366.png`).
Would trip her up:
- The payment buttons are the smallest buttons on the page (26px, 12px text) and greyed out until there is a line
  (`04-register-empty-1366.png`). They are the most important buttons at the counter.
- "Amount tendered (blank = $34.99)" and "Gift card or store credit number (scan or type; blank = the customer's
  credit)" are software phrasing in 12px capitals.
- The order of steps is backwards for cash: you must type the amount first and then press Cash. Pressing Cash first
  (what people do) records the exact total; the $50 typed afterwards is ignored and no change is shown
  (`06-register-cash-1366.png`: Cash $36.24, the 50 sits unused in the box).
- After "Complete sale" the only feedback is a small toast that fades in four seconds, sitting over the
  "Sale #1001 done. Change due ... Print receipt" card, which is below the fold at 768px
  (`07-register-sale-done-1366.png`). The change due is the one number the cashier needs, and it is 14px.
- Typing 2.4 yards is refused in small red text "Use 1/8 yd steps" (`05-register-fabric-yards-1366.png`); she has
  to work out that 2.4 should be 2 3/8.
- "Disc %", "Misc item", "Return mode off" (the button's label is its state, not what it does).
- On a 1024-wide tablet the sale table is cut off: % off, line total and the remove button are off the right edge
  and need sideways scrolling (`09-register-tablet-1024.png`). The menu takes a quarter of the width.

### Repair ticket: check in, change status, ready notice
Works: the check-in form is grouped (Customer, Machine, Work, Accessories) with power cord and foot control ticked
by default; "Read the plate" from a photo; plain hints (`11-check-in-form-1366.png`). The status change says
"Status: Ready - customer called" (`13-ticket-status-1366.png`).
Would trip her up:
- Customer: "Existing customer" search and "New customer name" fields side by side. Which one to use is unclear.
- "Pre-approved over the service ($)" with a grey "75.00" placeholder that looks like a filled-in value.
- Pressing "Create ticket" on an empty form shows the browser's own "Please fill out this field" bubble at a field
  scrolled out of view (`12-check-in-empty-error-1024.png`); it doesn't say what is missing in words.
- The ticket page is 8,000 px tall at 1366 and 11,000 px at 1024 (`15-ticket-page-full-1366.png`): estimate, parts,
  status, checklist, tension readings, 22 timing readings, charges, payments, messages, test mode, manuals. The
  Messages section (where the ready notice lives) starts 4,400 px down (`14-ticket-messages-1024.png`).
- "Customer's OK": "Approved" is a navy button and "Declined" plain, so it reads as if the customer already approved
  (`13-ticket-status-1366.png`).
- Status is a drop-down that saves the moment it changes, with no Undo; at 1366 its text is cut off ("Waiting on
  customer (").
- With messages off, nothing on screen after "Ready - customer called" says "now phone Ruth at 555-330-1212"; the
  phone hint is only in the Customer's OK box.

### Find a customer; add a customer
Works: the add form is short and its labels are plain; after Add it opens the customer's page (`17-add-customer-1366.png`).
Would trip her up:
- Searching "dorthy" for Dorothy Miller finds nothing and says "No customers yet." (`16-customer-search-typo-1366.png`),
  which is wrong (there is one) and offers no "Did you mean" or "Add Dorothy".
- The list page has no "Add customer" button at the top; the form is below the list, under however many customers
  the shop has.
- The tax-exempt placeholder is in the code font; "route code" in the search hint means nothing to a counter clerk.
- Every customer page shows a Longarm box ("Not certified to rent the longarm") and empty Appointments, before the
  contact details.

### Receive stock; look up an item; print labels
Works: printing labels is a clear page with a big "Print or save PDF" and plain choices (`20-print-labels-1366.png`).
The scan page has clear modes: Look up, Receive, Count shelf, Use on ticket.
Would trip her up:
- Adding an item shows 20 fields at once, including six fabric-only fields for a spool of thread and "Partner price
  ($, what partner shops pay once it is offered to them)" (`18-add-part-form-1366.png`).
- Receiving stock on an item's page is two placeholder-only boxes ("qty", "$ cost each (op...") and a 26px
  "Receive" button (`19-part-receive-stock-1366.png`). The fields' meaning disappears once she types.
- "Parts on order" only lists parts customers wait for; there is no plain "Receive a delivery" for shelf stock
  except the scan page's Receive mode, which she would not find from the Parts page header (Import spreadsheet, Most
  used, On order, Cross-reference, Marketplace).
- In a counter-only company the menu says "Inventory" but the page says "Parts and accessories".

### Fabric: cut from a bolt, fat quarters
Works: very good. Bolt ends are listed with the buttons that matter ("Cut into 4 fat quarters", "Cut into 2 half
yards", "Mark down 20% to $10.00") (`21-fabric-bolt-ends-1366.png`). The collection form fits how fabric arrives.
Would trip her up:
- After the cut, the row vanishes and a toast says "Cut 1 yd into 4 fat quarters (new item MOD-1002-FQ)" for four
  seconds (`22-fat-quarters-done-1366.png`). No Undo, no link to the new fat quarters, no "Print 4 labels".
- There is no fabric list or fabric search on the Fabric page: finding a bolt means Parts, then the Fabric chip.
- Buttons are 26px tall; the item number is in the code font.

### Classes: sign a student up
Works: the class page puts "Sign someone up" first with the fee stated (`23-class-page-1366.png`).
Would trip her up:
- At the register, "Classes & appointments" then "Sign up" shows a Name and Phone form (placeholders only) and, at the
  same moment, a red "Pick the customer first." (`10-register-class-signup-1024.png`). Two instructions that
  disagree.
- The class page mixes signing up, editing the class and deleting it on one long page; "Cancel the class" and
  "Delete the class" are side by side.
- The same "Existing customer / New customer name" pair as check-in.

### Settings and first run
Would trip her up:
- Settings is one page 8,500 px long (Account, Community hub, What this company does, Modules, Messages, Reports,
  Bookkeeping, Off-site backup, Audit log, Your data, Shop, Fabric, Service menu and price list, People, My
  password). The first thing a new owner reads is hub sync status, manual counts and a copyright-strikes paragraph
  (`24-settings-top-1366.png`); the shop's own name, address and tax rate are far down.
- Nothing guides a new company through the few things it must set (tax rate, receipt footer, staff logins, label
  printer).

## 2. Global fixes (apply everywhere)

| # | Fix | Where | Principle |
|---|---|---|---|
| G1 | Base text 16px: `.btn`, `.table`, nav links and `.input` to `text-base`; `.label` to 14px sentence case (drop `uppercase tracking-wide`); hints `text-xs` to `text-sm`. | `src/app/globals.css`, `src/components/nav.tsx` | 1 |
| G2 | Touch targets: `.btn` min-height 44px; `.btn-sm` min-height 36px, and 44px under `@media (pointer: coarse)`; `.check` 24px with the label clickable. | `globals.css` | 2 |
| G3 | Contrast: `--line` for input borders to about #8f8a7e (3:1); placeholder colour set to `--ink-2`; `--wait` darker (about #7a5400); disabled buttons keep 4.5:1 text. | `globals.css` | 1 |
| G4 | Toasts: top-centre, 8 s for success, errors stay until closed, larger text; the page also shows the result. | `src/app/layout.tsx` Toaster | 8 |
| G5 | Wording glossary (below), applied in one pass. | all | 3 |
| G6 | No placeholder-only fields; placeholders show an example only, never a value-looking number. Code font only for codes, never for placeholders. | forms | 1, 11 |
| G7 | Undo in the success toast for reversible actions; two-tap arm time from 3 s to 6 s. | `action-form.tsx` | 7 |
| G8 | Inline errors next to the field (replace the browser's "Please fill out this field" bubble). | `ActionForm` | 11 |

### Wording glossary
| Now | Say instead |
|---|---|
| tender, amount tendered | payment; "Cash handed over" |
| Disc %, Discount on sale | % off; "Take money off the sale" |
| Misc item | Other item (type a price) |
| Return mode off / on | Return an item / Returning: scan what comes back |
| Pre-approved over the service ($) | OK to spend up to ($) without calling |
| Existing customer / New customer name | Find the customer / or add a new one |
| Account (customer type) | Shop or dealer |
| route code | (drop from the hint) |
| Cross-reference | Other part numbers |
| Modules | Add-ons |
| Sync now, Community hub | Update from StitchHub, StitchHub (under Advanced) |
| Collected by customer | Picked up |
| Abandoned | Never picked up |
| Inventory / Parts and accessories | one name per shop kind, the same in menu and page |

## 3. Per-page fixes
- Register: big Cash / Card / Check / Gift card buttons (56px) in a "Payment" box; for cash, press Cash, type what was
  handed over, change shows large; after the sale a large "Change $13.76" panel with a "Print receipt" button that
  stays until the next scan; round fabric to the nearest 1/8 yd and say so; full-width counter layout (menu folded)
  under 1100px so the sale table fits.
- Check-in and class sign-up: one customer picker everywhere ("Find the customer" search; "New customer" opens name
  and phone). Class sign-up at the register uses the sale's customer or the typed name, never both messages.
- Ticket page: a top panel "Status / What's next / Call or notify the customer / Take payment"; the bench work
  (checklist, tension, timing readings, test mode, manuals) in a collapsed "Bench work" section or its own tab;
  Approved / Declined as equal buttons; status as large buttons (or a select plus Undo).
- Customers: "Add customer" button at the top; typo-tolerant search (trigram, digits-only phone match); "No customer
  matches 'dorthy'. Add a new customer?"; hide Longarm and Appointments boxes when the shop doesn't use them.
- Items: add form shows Name, Item number (optional), Type, Price, Cost, Stock; "More details" for the rest; fabric
  fields only when Type is Fabric. "Receive stock" with real labels and a 44px button; a "Receive a delivery" button
  on the Parts header that opens the scan page in Receive mode.
- Fabric: after a cut, keep a line "Cut into 4 fat quarters (MOD-1002-FQ). Print 4 labels | Undo"; a search box on
  the Fabric page.
- Settings: split into pages (My shop, Register and receipts, People, Messages, Add-ons, Advanced); hub, backups,
  audit and data under Advanced. A "Getting started" checklist on the first-run dashboard.
- Menu: "Everyday" items first; reference items (Factory specs, Shared by techs, Manual links, My manuals, Scan a
  manual) in a "Bench library" group for techs; Settings and Sign out pinned at the bottom.

## 4. Ranked fix list (top 15, quick wins first)

| Rank | Fix | Effort | Principle | Screens |
|---|---|---|---|---|
| 1 | Base font 16px, labels 14px sentence case, hints 14px (G1) | small | 1 | all |
| 2 | Buttons 44px, small buttons 36/44px on touch, bigger checkboxes (G2) | small | 2 | 04, 19, 21 |
| 3 | Contrast: input borders, placeholders, amber pill, disabled buttons (G3) | small | 1 | 04, 13 |
| 4 | Toasts top-centre, 8 s, errors stay; keep the result on the page (G4) | small | 8 | 07, 22 |
| 5 | Change due large and kept on screen after a sale, with a Print receipt button | small | 8, 4 | 07 |
| 6 | Wording glossary pass (tender, Disc %, Misc item, Return mode, Pre-approved...) (G5) | small | 3 | 04, 11 |
| 7 | Customer search: right empty message, "Add new" offer, typo and phone-digits matching; Add button at top | small (wording) / medium (fuzzy) | 6, 10, 11 | 16, 17 |
| 8 | Class sign-up at register: no contradictory "Pick the customer first"; real labels | small | 11, 9 | 10 |
| 9 | Payment box: big Cash/Card/Check buttons; press method first, then amount handed over; change shows | medium | 2, 4, 6 | 04, 06 |
| 10 | Register fits a 1024 tablet: fold the menu on the register, no sideways scroll | medium | 2, 9 | 09 |
| 11 | Add-item form: essentials first, "More details" folded, fabric fields only for fabric; labelled Receive stock | medium | 5 | 18, 19 |
| 12 | One customer picker pattern at check-in, register and class sign-up; inline errors (G8) | medium | 9, 11 | 11, 12, 10 |
| 13 | Undo for status change, fat-quarter cut, removed line; longer two-tap (G7) | medium | 7 | 13, 22 |
| 14 | Menu grouped and trimmed per person; Settings and Sign out always visible; Settings split with Advanced folded, plus a first-run "Getting started" checklist | medium-large | 5, 9, 10 | 02, 03, 24 |
| 15 | Ticket page reorganised: what's next and customer contact on top, bench work folded | large | 4, 5 | 13, 14, 15 |

Order to do them: 1 to 4 are one change to `globals.css` and the Toaster and lift every screen at once; check the
register and ticket pages afterwards for wrapping at 1024px. 5 to 8 are small edits in `register.tsx`,
`customers/page.tsx` and the wording. 9 to 15 each want a short design note and a look on a real tablet first.

## Screenshots
`ease-of-use-shots/`: 01 dashboard (busy shop), 02 first-run dashboard, 03 menu on an upright iPad, 04 register
empty, 05 fabric yards refused, 06 cash pressed then amount typed, 07 after the sale, 08 return, 09 register on a
1024 tablet, 10 class sign-up at the register, 11 check-in form, 12 check-in empty-form error, 13 ticket status,
14 ticket messages (4,400 px down), 15 whole ticket page, 16 customer search typo, 17 add customer, 18 add item
form, 19 receive stock, 20 print labels, 21 bolt ends, 22 after cutting fat quarters, 23 class page, 24 settings top.
