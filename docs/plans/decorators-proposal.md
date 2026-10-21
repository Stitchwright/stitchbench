# Embroidery and garment decorators in StitchShop: proposal

**Status:** 2026-10-21. Survey and proposal only; nothing built. Waiting on the owner's answers below. Owner: Bruce Wattendorf (SiteSentrix).

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
1. **Paid module or free?** The Vac Shop and Small Appliance modules are paid. Decorating could be a paid module, or free like the rest of the programs now are (`PROGRAM_FREE`). This is pricing, so it is yours.
2. **Which hand-off first?** Import only (option 1), or also the cloud inbox (option 2, which costs storage)?
3. **Who is the buyer?** A decorator running only embroidery, or screen printing too from day one? Screen print needs its own pricing tables (colours, locations, tiers) and screen/ink tracking, but no separation software.
4. **Does StitchFoundry export a job file?** The StitchFoundry chat should say whether one exists or will, and in what form, before D5 is designed.
5. **New shop kind or add-on?** A decorating shop could be its own `DEFAULT_SHOP_KIND` with its own menus, or a module a repair or retail shop turns on. This changes what people see on sign-in.

## Not decided here
Pricing, wording seen by customers (proof emails, quotes), and any legal text (terms for customer artwork and copyright on logos) stay with the owner.

## Revision history
- 2026-10-21: first version (survey and proposal).
