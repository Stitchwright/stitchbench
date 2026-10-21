# Embroidery and garment decorators in StitchShop: proposal

**Status:** 2026-10-21. D1 (orders), D2 (embroidery quotes and costing) and the file import of D5 are built (migration `20261102000000_decorating`, `src/lib/decor*.ts`, `/decorating`, `scripts/checks/decorating.check.ts`). D4's production worksheet and production list and screen printing (D6) are built too. The quote and proof by link (D3) is built too. Not built: the cloud inbox, DTG, heat transfer and vinyl. Owner: Bruce Wattendorf (SiteSentrix).

## What was asked
Add shops that decorate garments (embroiderers, screen printers and similar) to StitchShop, and let StitchShop receive embroidery files from StitchFoundry.

## What is here today (surveyed 2026-10-21)
- **StitchShop is the StitchBench code base** (`APP_NAME=StitchShop`, `DEFAULT_SHOP_KIND=retail`). Its model is a *repair shop*: a `Ticket` is a job on a `Machine` for a `Customer` (`prisma/schema.prisma`), with estimates the customer approves, parts, checklists, photos and payments. Retail adds a register, stock, classes, layaway and scheduling.
- **Paid modules** (`docs/plans/modules-design.md`): `ModuleGrant` rows and signed keys switch a module on per company; **equipment kinds** (sewing, vacuum, mixer, 3D printer, shop-added kinds) give a ticket its own intake questions, checklist and service menu. A decorating module would use these same two mechanisms.
- **What does not fit:** a decorating job is an *order for garments*, not a machine in for repair. It has a quantity and sizes, artwork, a proof the customer approves, a price by stitch count or by colours and print locations, a due date for an event, and a production run. Forcing it into `Ticket` + `Machine` would be wrong; it needs its own order model that reuses `Customer`, payments, approvals-by-link, messaging and scheduling.
- **StitchFoundry side** (`docs/stitchfoundry-spec.md`): it already has job orders (`embroidery.job.*`: customer, design, quantity, due, garment, placement, notes, status, with a worksheet and barcode), stitch counts, colours, sizes and run times, and writes DST, PES, PEC, JEF, EXP, VP3, XXX and U01. The spec names StitchBench and StitchShop as the planned siblings that take over its production and business items (quotes by stitch count, orders and approvals, mockups, production schedule, worksheets, costing). **Not checked:** whether StitchFoundry has a machine-readable job file to export; the spec describes job orders and worksheets inside the program, not a hand-off file.
- **The cloud service has no file store** (`docs/cloud.md` endpoints: account, credits, AI, reports). A "send from StitchFoundry" path through the cloud would need new storage on the StitchFoundry side or on the hub (which already has R2).

## Proposed shape (one module, built in packages)
A new paid module, **Decorating** (`decorating`), turned on like the others, in the same app:

| Package | What |
|---|---|
| D1 Orders | `DecorOrder` and its lines (garment, colour, sizes and quantities), a decoration per placement (method: embroidery, screen print, DTG, heat transfer, vinyl), status flow (quote, art, proof sent, approved, in production, done, picked up), due date, link to `Customer`, payments and the estimate-by-link approval already in the app. |
| D2 Quotes and costing | Embroidery: price by stitch count tiers, digitizing fee, setup, per-colour changes. Screen print: price by colours, locations and quantity breaks, screen and ink fees. Shop-set price tables; nothing is priced by the program on its own. |
| D3 Artwork and proofs | Attach design files (machine files and images), a mockup image, a proof the customer approves by the existing link flow. |
| D4 Production | A production schedule and worksheets: embroidery by machine and run time, screen print by press and colour, a run sheet and a barcode for each order. |
| D5 Receive from StitchFoundry | See the options below. |

## Receiving embroidery files from StitchFoundry: options
1. **Import in StitchShop (recommended first step).** Drag a machine file (and, if StitchFoundry gives one, its job file) onto an order. The program reads the stitch count, colours, size and run time from the file where the format carries them (DST and PES headers do) and from the job file when there is one. Works offline and on a Windows install, needs nothing new in the cloud, and nothing is uploaded anywhere.
2. **Send from StitchFoundry to the shop's inbox**, keyed by the Foundry Account (the same login both apps now share). Needs file storage and an inbox, which neither the cloud service nor the hub has for this today, so it is new cost and new work in two repositories. Desktop installs would pull the inbox only when linked.
3. **A watched folder** both programs can see. Cheap, but only works when they run on one PC or one network.

## Questions for the owner (these are yours to decide)
1. ~~Paid module or free?~~ **Decided 2026-10-21 (owner): free**, and Vac Shop is free too. Both already follow `PROGRAM_FREE` (`src/lib/free-program.ts`): while it is on, the default, every add-on is on for every company whatever keys it holds, except the Assistant. Decorating joins that rule and is not added to `FREE_EXCLUDED`. Open: if the owner wants these modules free even with `PROGRAM_FREE=off`, they need an always-on exception.
2. **Which hand-off first?** Import only (option 1), or also the cloud inbox (option 2, which costs storage)?
3. **Who is the buyer?** A decorator running only embroidery, or screen printing too from day one? Screen print needs its own pricing tables (colours, locations, tiers) and screen/ink tracking, but no separation software.
4. **Does StitchFoundry export a job file?** The StitchFoundry chat should say whether one exists or will, and in what form, before D5 is designed.
5. **New shop kind or add-on?** A decorating shop could be its own `DEFAULT_SHOP_KIND` with its own menus, or a module a repair or retail shop turns on. This changes what people see on sign-in.

## Not decided here
Pricing, wording seen by customers (proof emails, quotes), and any legal text (terms for customer artwork and copyright on logos) stay with the owner.

## Revision history
- 2026-10-21: quote and proof by link (D3) built.
- 2026-10-21: screen printing (D6) built.
- 2026-10-21: D4 production worksheet and list built.
- 2026-10-21: D1, D2 and the DST import built.
- 2026-10-21: owner decided Decorating and Vac Shop are free (question 1).
- 2026-10-21: first version (survey and proposal).

## Decisions (owner, 2026-10-21: "go with your picks")
Free module; import only first (a drag-in DST, no cloud inbox); embroidery first, screen printing as a later package; a module a repair or retail shop turns on, not its own shop kind; ask the StitchFoundry chat whether it exports a job file (not yet asked).

## Built so far (what to know)
- **Module `decorating`** (`MODULE_IDS`, `/decorating`, nav item "Decorating"): free while `PROGRAM_FREE` is on, a key otherwise.
- **Orders:** `DecorOrder` (QUOTED, APPROVED, IN_PRODUCTION, READY, COLLECTED, CANCELLED, TURNED_DOWN) with `DecorLine` (garments, sizes like "S 2, M 4", what the shop charges for each blank) and `DecorPlacement` (a decoration on every piece, with its design file kept for repeat orders). Order numbers: `Shop.nextDecorOrderNumber`.
- **Price:** the shop's table (`DecorSettings.prices`: stitch tiers, extra per thousand, quantity breaks, digitizing, set-up, machine speed) in `src/lib/decor-math.ts`. **The starting numbers are placeholders for the owner to change, not market prices.** A placement may carry an agreed price instead. The parts of the price are kept on the order, so a later change to the table never moves a quoted order and a sale bills exactly what was quoted.
- **Files:** only **DST** is read (stitch records, colour changes, size), from the format's public description (`src/lib/embroidery-file.ts`, tests written from that description). PES, JEF, EXP, VP3 and the rest are kept as sent and the stitch count is typed: reading them without a sample file to check against would be a guess.
- **Wired in:** collecting is a register sale (and voiding it puts the order back on the shelf); the customer merge, the delete blockers and the delete clean-up; the company move file and join (`MOVE_TABLES`, `NUMBERED`, `WITH_STORE`, `STAY`).
- **Production (D4):** each order has a printable worksheet (`/decorating/[id]/print`: garments with sizes and an "in" box, each decoration with its file, stitches, colours, size and machine time, boxes to tick as the work goes, notes; no prices) and `/decorating/production` lists approved and in-production orders soonest due first with the machine time each needs (stitches at the shop's set speed plus colour changes, on every piece; hooping and trimming are not counted) and the total queued. There is no calendar or per-day capacity yet.
- **Screen printing (D6, migration `20261103000000_decorating_screen`):** a placement's method is embroidery or screen print. A screen print is priced from the shop's grid (the price a piece for 1, 2, 3... colours from this many pieces, `DecorPrices.screen.rows`; each colour past the grid costs `extraColorCents`; fewer pieces than the first row pay its price). A white underbase for a dark garment counts as one more colour. Screens (`screenCents` a colour, underbase included) are charged only when the placement is marked as needing new screens, and the order keeps them as `DecorOrder.screenCents`; a repeat print is free of them. Press time is set-up minutes for each colour plus every piece through every colour at the prints an hour set in the prices. The quantity breaks of the embroidery table do not apply (the grid has its own). Art is kept as sent and never read. A mixed order (prints and embroidery) is one order and one sale. **The grid, the screen fee, the speed and the set-up minutes are placeholders for the owner to change, not market prices.** Not covered: separate ink or screen stock, reclaiming or reusing screens by customer, specialty inks and sizes beyond the number of colours, and a drying or curing time.
- **Quote and proof by link (D3, migration `20261104000000_decorating_proof`):** a quoted order can be sent for the customer to approve, by the existing estimate link (`EstimateLink.decorOrderId`; Messages (Marketing) sends it, as for print and cut jobs). The customer's page (`/e/<token>`, no sign-in) lists what will be made and where (each decoration in words), the price lines, a mock-up picture if the order has one, and Approve or Decline with a confirm step; approving moves the order to approved, declining leaves it quoted, her words go in the order's note. The mock-up is a PNG or JPEG (decided by its first bytes, never SVG), 2 MB at most, kept on the order (`DecorOrder.mockup*`), shown to the customer at `/api/e/<token>/mockup` for that link's order only (a public GET the links gate and lock already allow), and deleted with a deleted customer. **Any change to the garments, decorations or the picture stops a link already sent** (they must not approve a price or picture that has since changed), and a stopped link shows no picture. Staff may send at most three to one address a day (the existing cap).
- **Checked 2026-10-21:** `decorating.check.ts` (8 groups, five deliberate breaks each caught), `customer-merge`, `move-export`, `move-import`, `move-hub`, `join-companies`, `free-program`, `license`, `modules`, unit tests (118), tsc, lint; a real-browser run (take an order, garments, DST upload read as 5,000 stitches in 2 colours, approve, produce, ready, collect: sale #1001 at $185.00 before tax).
- **Not checked:** phone width, the Windows program with the module, a deploy, any real PES/JEF file, and a real StitchFoundry-made DST (the test files are built from the format description).
- **Open for StitchHub (another repo):** its `ADDON_IDS` and the keys it signs list five add-ons; `decorating` is not in them. Programs with `PROGRAM_FREE` on need no key, so nothing breaks, but a hub that comps "every add-on" does not yet include it.
