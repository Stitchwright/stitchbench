# StitchShop register: how money is taken, and how to add class and appointment fees

The register is StitchShop-only. It records how a sale was paid: cards run on the shop's own terminal and there is no card processing. Sales with negative quantities are returns. Today one kind of outside record can be paid at the register: a partner **RepairJob** (the retail side). That is the pattern to copy for class and appointment fees. StitchBench tickets are **not** paid at the register; they use `Payment` rows on the ticket page (see section 4).

## 1. Data model (`prisma/schema.prisma`)

**`Sale`** (schema.prisma:755-781):
- Fields: `id`, `shopId`, `number` (unique per `shopId`; comes from `Shop.nextSaleNumber`, default 1001, schema:49), `customerId?` (SetNull), `userId?`.
- Money fields: `subtotalCents`, `discountCents` (whole-sale discount), `taxCents`, `totalCents`, `taxRatePct` (the rate at the time of the sale).
- `tenders Json` holds `[{method, amountCents, note}]`. There is also `changeCents`.
- `status String` is `"COMPLETED" | "VOIDED"` (a plain string, not an enum). Also `voidedAt?`, `note?`, `createdAt`.
- Index: `@@index([shopId, createdAt])`.

**`SaleLine`** (schema.prisma:783-802):
- Fields: `id`, `saleId` (Cascade), `partId?` (FK, SetNull), `description`, `partNumber?`, `qty Float`, `unit?` (`"yd"` or null), `unitPriceCents Int`, `discountCents Int` (total off this line), `taxable Bool`, `costCents?`, `consignLinkId?`, `consignItemKey?`, `repairJobId String?`.
- **There is no kind/type column.** The kind is worked out from which reference is set:
  - `repairJobId` means "Repairs"
  - `part` means the part's `KIND_LABEL`
  - otherwise "Misc"
  
  This logic is at register/sales/page.tsx:35-37.
- `repairJobId` is a plain string with **no FK**, because `RepairJob` has a composite primary key `@@id([shopId,id])` (schema:901).
- There are no indexes on `SaleLine.saleId` or `repairJobId` (checked migration 20260925200000_stitchshop).

**`RepairJob` payment fields** (schema:888-895): `paidCents?` (what the sewing shop collected), `paidAt?`, `paidWhere?` (`shop|repair|split`), `repairPaidCents?` (paid straight to the repair shop), `pickedUpAt?`, `events Json` (`[{at,status,note}]`). It has no link back to the sale id. The sale number is only written into an event note.

**Other money records:**
- Ticket `Payment` (schema:358-366): `method` uses the `PaymentMethod` enum (`CARD|CASH|CHECK|SHOP_COLLECTED|INVOICE|OTHER`), `amountCents`, `paidAt`.
- `ConsignSale` (schema:955-970) uses **the sale line's id as its own id** (`id: line.id`) and stores the shop's share as fixed at the time of sale.

## 2. Money and format helpers

| Helper | File:line | Behaviour |
|---|---|---|
| `money(cents)` | src/lib/format.ts:3 | `-$1.23`; returns `""` for null |
| `toCents(v)` | src/lib/format.ts:10 | Strips `$ , space`; `Math.round(n*100)`; returns null if blank or invalid |
| `str(v)` | format.ts:40 | Trimmed string or null |
| `fmtDate` | format.ts:22 | Date formatting |
| `lineNet(l)` | src/lib/register-math.ts:10 | `round(qty*unit) - sign(qty)*discountCents` |
| `discountBase(lines)` | register-math.ts:13 | Sum of `lineNet` over lines with `discountable !== false` and positive net |
| `saleTotals(lines, orderDisc, taxRatePct, tenders)` | register-math.ts:22-35 | Returns `{subtotal, orderDiscount, tax, total, paid, change, due}`; same code runs in the browser and on the server |
| `TENDER_METHODS`, `TENDER_LABEL`, `Tender`, `TenderMethod` | register-math.ts:3-6 | `CASH, CARD, CHECK, GIFT, OTHER`. GIFT is only a label; there are no gift-card balances anywhere |
| `yards`, `qtyText` | register-math.ts:38-51 | Quantity display (fabric in eighths of a yard) |
| `repairDue(j)` (private) | src/actions/register.ts:66 | `max(0, total - repairPaid - paid)` |
| `monthRange`, `startOfToday`, `todayIn` | src/lib/sales.ts:66-84 | Date ranges in the shop's time zone (uses `zonedParts` / `zonedMidnight` in src/lib/partners.ts:1304,1311) |
| `paymentsBetween` | src/lib/sales.ts:87 | StitchBench ticket `Payment`s for `/sales`. Not register sales |
| `ticketTotals` | src/lib/ticket-math.ts:14 | Ticket money. Same rule of spreading a discount across tax |

## 3. Tax rules

- There is one rate, `Shop.taxRatePct` (a Float percent, schema:32). The rate is copied into `Sale.taxRatePct`.
- `saleTotals` works it out like this:
  - Tax base = the sum of `lineNet` over taxable lines, less the taxable lines' proportional share of the whole-sale discount.
  - That share is `round(orderDiscount * eligibleTaxable / base)`.
  - Tax is rounded once for the whole sale: `tax = round(base*rate/100)`.
- The whole-sale discount only comes off lines that are `discountable !== false` **and** `lineNet > 0`. Returns and repair lines are never discounted this way.
- **Who decides whether a line is taxed:**
  - Repair lines are forced to non-taxable and non-discountable on the server (register.ts:205-206), because the repair shop's bill already includes its tax.
  - For parts and misc lines the server **trusts the client's `taxable`** (register.ts:205). The client sets parts to `taxable: true` (register.tsx:75); misc lines have a checkbox (register.tsx:261).
- A return is taxed at the **current** shop rate, not the original sale's rate. Returns are not linked to an original sale.

## 4. Existing flows

### Client state (src/components/register.tsx)

`CartLine` (register.tsx:12-25):
```ts
{ key; partId?; repairJobId?; pickedUp?; description; partNumber?; unit: string|null; qty; unitPriceCents; discountPct; taxable; consigned? }
```
- `lines = cart.map(l => ({...l, discountCents: discountOf(l), discountable: !l.repairJobId}))` (register.tsx:49). The client computes the discount cents from a percentage (`discountOf`, :27).
- Totals come from `saleTotals(...)` (register.tsx:53).
- Ways to add a line:
  - Scan or search: `addItem` (register.tsx:57). In return mode the sign is -1. The same part scanned again adds one to its quantity, except fabric (each cut is its own line).
  - **Misc item** form (register.tsx:233-267): description, price, taxable.
  - **Repair pickup** picker (register.tsx:184-187, 270-301). It calls `pickupJobs()` and adds `{repairJobId, pickedUp:true, description:`Repair, tag …`, qty:1, unitPriceCents:j.dueCents, taxable:false}`. The same job can't be added twice (`disabled={cart.some(l=>l.repairJobId===j.id)}`).
- On a repair line, the quantity, price and discount inputs are disabled (register.tsx:342, 353, 365). The price input is also disabled when `!canSell`, i.e. for the TECH role (page.tsx:44).
- **Return mode** (register.tsx:32, 189-191) is only a sign flip for new scanned or misc lines. It does not refer to an earlier sale.
- `finish()` (register.tsx:119-153) maps lines to `SaleLineInput` and calls `completeSale`. On success it shows "Print receipt", which links to `/register/sales/<id>`.

### Server: `completeSale(input: SaleInput)` (src/actions/register.ts:151-317)

This action is **not** wrapped in `safe()`. It returns `{saleId, number, changeCents} | {error}` from its own `try/catch` with `isUserError` (:313-316). This is the pattern to copy for an action that must return data.

Input types (register.ts:132-149):
```ts
SaleLineInput = { partId?; repairJobId?; pickedUp?; description; qty; unitPriceCents; discountCents?; taxable }
SaleInput     = { customerId?; lines; orderDiscountCents?; tenders: Tender[]; note? }
```

Validation, in order:
- 1-300 lines (:156-157).
- Parts must belong to this shop (:160-162).
- Repair jobs must be this shop's `side:"retail"` jobs and must not be paid already (:163-171).
- The customer must belong to this shop (:172).
- Each line (:174-211):
  - `qty` must be non-zero and `|qty| ≤ 10000`.
  - Unit price must be ≥ 0. Negative prices are refused; a refund is a negative quantity.
  - The discount is clamped to between 0 and the line's gross (:194).
  - **For a repair line:** `qty === 1`, no discount, and **the price is recomputed on the server: `unit = repairDue(job)`**, ignoring the client's price (:182-188).
  - For a part: whole-number quantity unless sold by the yard. A TECH can't change the price of a part that has one (:189-192).
- Tenders are cleaned up (:213-215). Then the checks (:216-222):
  - Enough must be paid.
  - A refund must be paid out exactly, as negative tenders.
  - Only cash can give change.

Transaction (:232-308):
- Increment `Shop.nextSaleNumber` and create the `Sale`.
- For each line, `const line = await tx.saleLine.create({data:{saleId, ...row}})`. `row` is the line object minus `pickedUp` and `discountable` (:253-255), so **every other key on a built line must be a real `SaleLine` column**.
- Part: stock decremented and a `StockMove` with reason `SOLD` (:256-261).
- Consigned stock: a `ConsignSale` with `id: line.id`, a guarded `consignItem.updateMany`, and `sendToPartner("consign.sale")` (:262-286).
- **Repair (the pattern to copy)** (:287-305):
  ```ts
  const amount = lineNet(l);
  const paid = await tx.repairJob.updateMany({
    where: { shopId, id: job.id, paidAt: null },          // guard: nobody paid it meanwhile
    data: { paidCents: amount, paidAt: at, paidWhere: job.repairPaidCents ? "split" : "shop",
            ...(pickedUp ? { pickedUpAt: at, status: "COLLECTED" } : {}), events: [..., {note:`Paid $… at the counter, sale #${number}`}] },
  });
  if (!paid.count) throw new UserError(`Repair tag ${job.tag} was just paid. Take it off this sale.`);
  await sendToPartner(shopId, job.linkId, "job.paid", {...}, tx); // + "job.pickedup"
  ```
- Afterwards it calls `revalidatePath` on `/register`, `/repairs` and `/parts` with `"layout"` (:309-311).

On the repair shop's side, `job.paid` is applied in src/lib/partners.ts:817-831. It creates a ticket `Payment` with method `SHOP_COLLECTED` and the note `Paid at <shop>, sale #N`.

### Voids: `voidSale = safe(async (saleId, formData))` (register.ts:320-364)

- `requireAdmin()`. A sale that is already void is refused.
- **Any sale containing a repair line is refused** (:327-329): "Ring up a return for the items instead…". Repair payments therefore can't be undone at the register at all, and a repair line can't be returned either, because its quantity must be 1.
- The transaction uses a guarded `sale.updateMany({where:{status:"COMPLETED"}})` so two voids at once can't both run (:333-337).
- Stock is added back with a `StockMove`.
- Consigned lines get a reversing `ConsignSale` with id `${line.id}-void`, plus a guarded `consignItem.updateMany`. If that guard fails it throws "…returned since this sale; void that return first." (:357). This is the pattern to copy for "refunded since this sale".
- The void form is on the receipt page (sales/[id]/page.tsx:78-88), shown to everyone except TECH.

### Receipts and reports

- **Receipt**, `src/app/(app)/register/sales/[id]/page.tsx`:
  - Shows shop name, address and phone; the sale number and time; customer; who served.
  - For each line: `description`, `qtyText @ money(unit) less disc (no tax)`, and `lineNet`.
  - Then subtotal, discount, tax, TOTAL/REFUND, the tenders, change, a barcode `S${number}`, and `receiptNote`.
  - Only `description` identifies a line, so the class name and date must go into `description`.
  - Nothing scans the `S####` barcode; I found no handler for it.
- **Sales report**, `src/app/(app)/register/sales/page.tsx`:
  - Totals by tender, by type (:32-40, which uses `repairJobId`), tax collected, and "Repairs collected for the repair shop".
  - Voided sales are excluded from totals.
- **CSV export**, `src/app/api/export/[what]/route.ts:41-51`: `register-sales` writes one row per line. There is no column for what the line is tied to.

### StitchBench tickets (not at the register)

- `addPayment` (src/actions/tickets.ts:353) creates a `Payment` row.
- `removePayment` (:370) is admin only.
- `setStatus` (:140) sets `readyAt` when a ticket moves to `READY_*`, and sets `closedAt` / `warrantyUntil` when it becomes `COLLECTED`.
- The `/sales` log reads `Payment` rows.

## 5. Recommended way to add class and appointment fees (fewest changes, correct refunds)

Copy the RepairJob pattern: an explicit reference column on the sale line, the price fixed on the server, and a guarded `updateMany` on the booking inside the sale transaction. On top of that, add symmetric handling for refunds (quantity -1) and voids, which repairs don't have.

### Schema

```prisma
model SaleLine { ...
  enrollmentId  String?   // a class seat: qty 1 = paid, qty -1 = refunded
  appointmentId String?   // an appointment's fee (longarm time, lesson)
  @@index([enrollmentId]) @@index([appointmentId]) @@index([saleId])
}
// On Enrollment and on Appointment (whatever the scheduling design names them):
feeCents      Int        // price fixed at sign-up/booking (a later class price change doesn't reprice it)
taxable       Boolean @default(false) // copy from the class/appointment type; taxability of classes varies by state
paidCents     Int?
paidAt        DateTime?
paidLineId    String?    // SaleLine that paid it (exact match for void)
refundedCents Int?
refundedAt    DateTime?
refundLineId  String?
```
If scheduling uses one `Booking` model for both, one `bookingId` column is enough. Real FKs with `onDelete: SetNull` are possible if those models have a single-column `id`. Bookings that have been paid should be cancelled, never deleted.

Payment state is kept separate from seat status. Cancelling on the class page only frees the seat. Money goes back only through a refund line at the register.

### Server: `src/actions/register.ts`

1. Add `enrollmentId?` and `appointmentId?` to `SaleLineInput` (:132).
2. Next to the repair-job preload (:163-171), load `db.enrollment.findMany({ where: { shopId, id: { in } } })` and the same for appointments. Refuse missing ones and duplicates within one sale. A line may carry at most one reference.
3. In `lines.map` (:174-211), for a booking line:
   - `Math.abs(qty) === 1`.
   - **qty 1:** status must be ENROLLED or BOOKED (not WAITLIST or CANCELLED) and `paidAt == null`; `unit = feeCents`.
   - **qty -1:** `paidAt != null && refundedAt == null`; `unit = paidCents` (an owner or admin may lower it to keep a cancellation fee, but never raise it); discount 0.
   - `taxable` comes from the booking, not the client. A refund uses the booking's `taxable`, which is the same flag the payment used.
   - `description` is built on the server, for example `Class: Beginning Quilting, Tue Oct 7 6:00pm`.
   - Set `discountable: false`, so the line is outside the whole-sale discount like repairs. Then `paidCents = lineNet(l)` is exactly what was charged before tax, and a refund gives back exactly that. A line discount (for example a member %) stays allowed.
   - Return `enrollmentId` and `appointmentId` in the built object; they are real columns, so the `...row` spread works.
   - Optional: if `input.customerId` is empty, default the sale's customer to the booking's customer.
4. In the transaction, after `const line = await tx.saleLine.create(...)` (:255):
   ```ts
   if (l.enrollmentId) {
     const ok = await tx.enrollment.updateMany({
       where: l.qty > 0 ? { shopId, id: l.enrollmentId, paidAt: null, status: "ENROLLED" }
                        : { shopId, id: l.enrollmentId, paidAt: { not: null }, refundedAt: null },
       data:  l.qty > 0 ? { paidCents: lineNet(l), paidAt: at, paidLineId: line.id }
                        : { refundedCents: -lineNet(l), refundedAt: at, refundLineId: line.id },
     });
     if (!ok.count) throw new UserError(`${l.description} was just ${l.qty > 0 ? "paid" : "refunded"}. Take it off this sale.`);
   }
   ```
   Handle appointments the same way. Then `revalidatePath` the class and calendar routes with `"layout"`. No partner messages are needed.
5. Add a data-returning action `bookingsDue(customerId?: string, refunds = false)`, modelled on `pickupJobs` (:94-111) and scoped by `shopId`:
   - Normal mode: unpaid ENROLLED or BOOKED bookings, sorted by start time.
   - Return mode: bookings that are paid and not refunded.
   - Return `{kind, id, description, dueCents, taxable, customerName, startsAt}`.
6. In `voidSale` (:320-364), keep the repair block and add, inside the transaction:
   ```ts
   if (l.enrollmentId) {
     const undone = await tx.enrollment.updateMany({
       where: l.qty > 0 ? { shopId, paidLineId: l.id, refundedAt: null } : { shopId, refundLineId: l.id },
       data:  l.qty > 0 ? { paidAt: null, paidCents: null, paidLineId: null } : { refundedAt: null, refundedCents: null, refundLineId: null },
     });
     if (!undone.count) throw new UserError(`${l.description} was refunded since this sale; void that refund first.`);
   }
   ```
   This mirrors the consignment guard at :353-357. Revalidate the class and calendar paths.

### Client: `src/components/register.tsx`

- Add `enrollmentId?` and `appointmentId?` to `CartLine` (:12).
- In the `lines` memo (:49): `discountable: !l.repairJobId && !l.enrollmentId && !l.appointmentId`.
- Add a "Classes & appointments" button beside "Repair pickup" (:184). It is shown whenever the register shows, since the register already requires `sellsRetail`.
- The picker works like :270-301. It adds `{ key, enrollmentId|appointmentId, description, unit:null, qty: returnMode ? -1 : 1, unitPriceCents: b.dueCents, discountPct:0, taxable: b.taxable }`. It disables items already in the cart and shows "Refund $X" in return mode.
- Disable the quantity and price inputs for these lines, like the repair lines at :342 and :353. The server recomputes the price anyway.
- Pass both ids through in `finish()` (:124-133).

### Reports and export

- register/sales/page.tsx:32-40: add "Classes" and "Appointments" to the by-type buckets.
- Export route.ts:43-47: optionally add a `for` column (`class:<id>` / `appointment:<id>`).
- The receipt needs no change, because the description carries the class and date.
- On the class roster, show "Paid, sale #N" by looking up `saleLine.findFirst({ where: { id: e.paidLineId, sale: { shopId } }, include: { sale: { select: { id: true, number: true } } } })` and linking to `/register/sales/<saleId>`.

### Optional: ring up straight from the class page

A "Ring up" link to `/register?enrollment=<id>` would need `RegisterPage` to accept `searchParams: Promise<{...}>` (that pattern already exists in register/sales/page.tsx:11) and pass a preload prop to `<Register>`.

## 6. Limits and what I could not find

- Returns are not linked to their original sale. Tax on a return uses today's rate.
- Repair payments can't be refunded or voided at the register.
- The register has no deposit or partial-payment support. The one partial case is repairs, through `repairDue`, which already subtracts amounts paid elsewhere.
- Paying a StitchBench `Ticket` at the register does not exist.
- There is no gift-card balance ledger.
- I found no scanner for the receipt barcode.
- There are no automated tests of register math. The only register coverage is the e2e walkthrough in tests/partners.spec.ts:155-170.
- I did not open `node_modules/next/dist/docs`. The recommendations only reuse patterns already in this codebase (`searchParams` as a Promise, `revalidatePath(path, "layout")`, `"use server"` actions).

Files read: /home/user/stitchbench-feat/src/actions/register.ts, src/lib/register-math.ts, src/lib/sales.ts, src/lib/format.ts, src/lib/action.ts, src/components/register.tsx, src/app/(app)/register/page.tsx, src/app/(app)/register/sales/page.tsx, src/app/(app)/register/sales/[id]/page.tsx, src/app/api/export/[what]/route.ts, src/actions/tickets.ts, src/lib/ticket-math.ts, prisma/schema.prisma.