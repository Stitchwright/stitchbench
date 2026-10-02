# Parts arrived notices, online booking, and an online shop (design brief, revision 0)

Asked for by the owner on 2 Oct 2026, after the scheduling, messaging and modules work was built and tested. This is a
first draft for the owner to read and correct before anything is built. It follows the same rules as the two earlier
designs (`scheduling-messaging-design.md`, `modules-design.md`): every query filters by `shopId`, action bodies live in
`src/lib/*` taking a `CurrentUser` so check scripts can drive them, money is integer cents, times are instants shown in
`Shop.timeZone`, and every customer message goes through `queueToCustomer` and the consent gate.

Three features, in the order to build them. The first is small and fits the existing notices. The second is a
medium package on the existing calendar and classes. The third is large and gets a scope here, not a full design.

---

## 1. Parts arrived notice (package `parts-in`)

### What the owner described

A customer's machine needs a part the shop doesn't have. The shop orders it and the ticket waits ("Waiting on parts").
When the order comes in and is checked in, the customer should hear that the part arrived and the work is back on.

### What exists today

- Ticket status `WAITING_PARTS` ("Waiting on parts"), with nothing recording *which* part or when it was ordered.
- Parts have `qtyOnHand`, `reorderAt`, suppliers (`PartSource`) and stock moves with reason `RECEIVED`, but no
  purchase order and no "received" screen: stock is received by counting (`countStock`) or by a partner or market
  order arriving.
- Notices: `ready`, `estimate`, `abandon`, `service_due`, `review`, `reminder`, `bags_due`, with the worker, templates
  and the consent gate (`allowed()`), all under the Marketing module.

### Data (one model, foundation-style migration `20261003090000_part_waits`)

```prisma
// A part a ticket is waiting for: ordered, then received. Recorded when the ticket goes to Waiting on parts (or any
// time from the ticket), cleared when the part is checked in. The notice goes out on receipt.
model PartWait {
  id          String    @id @default(cuid())
  shopId      String
  shop        Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  ticketId    String
  ticket      Ticket    @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  partId      String?   // a stocked part, when it is one; null for a one-off ordered by description
  part        Part?     @relation(fields: [partId], references: [id], onDelete: SetNull)
  description String    // "Bobbin case", "Feed dog assembly 7mm": what the customer hears
  qty         Float     @default(1)
  supplier    String?
  orderedAt   DateTime  @default(now())
  expectedOn  String?   // YYYY-MM-DD, optional, for the list
  receivedAt  DateTime?
  receivedBy  String?
  noticedAt   DateTime? // when the parts_in message was queued (never twice)
  note        String?

  @@index([shopId, receivedAt])
  @@index([ticketId])
  @@index([partId])
}
```

`Ticket` gains `waits PartWait[]`, `Part` gains `waits PartWait[]`, `Shop` gains `partWaits PartWait[]`.

### Behaviour

- **Recording a wait.** On the ticket page, a "Waiting on a part" card (shown for any open ticket, highlighted when the
  status is Waiting on parts): pick a stocked part (the register's item search, so a part the shop stocks but is out
  of fills `partId` and its description) or type a description; quantity; supplier (datalist of the shop's suppliers);
  expected date; "Mark the ticket Waiting on parts" ticked by default when the status isn't already that. Several waits
  per ticket are fine (two parts from two suppliers).
- **The Parts on order page** (`/parts/on-order`, under Parts): every open wait across tickets, grouped by supplier,
  with the ticket, customer, description, quantity, ordered and expected dates. Per row: "Received" and "Cancel"
  (the part isn't coming: the ticket stays as it is, the note says why). Per supplier: "Received all of these". A
  count badge on the Parts nav item when anything is more than 14 days old past its expected date.
- **Receiving by stock.** When a stocked part's quantity goes up through a count (`countStock`, reason `RECEIVED` or
  `ADJUSTED` upward) or a partner or market order arrives (`receiveIntoStock`), the open waits for that `partId` are
  listed in the toast ("3 waits for this part: mark them received?") with a link to the page filtered to that part.
  Nothing is marked received without a person saying so: a count can be a correction, not an arrival.
- **Receiving a wait** (`receiveWaitFor(user, waitId, fd)`): sets `receivedAt` / `receivedBy`, and when the ticket's
  status is `WAITING_PARTS` and no other wait of the ticket is still open, offers (not forces) the status change to
  `ON_BENCH` as a ticked checkbox "Put it back on the bench". Then the notice (below). A wait received by mistake can be
  reopened within an hour ("Not received after all").
- **The notice** (`parts_in`, purpose `notice`, channels `preferred`, Marketing on): queued inside the same
  transaction as the receipt, dedupe key `parts_in:{waitId}`, `refType "wait"`, `refId waitId`, `ticketId`. When
  several waits of one ticket are received together, one message names them all ("your bobbin case and feed dog
  assembly"). The worker's `stillWanted` cancels it when the ticket has closed since, or the wait was reopened. The
  ticket page's Messages section shows it like a ready notice; a shop without Marketing sees "Call them: the part is
  in" with the customer's phone, and the wait is still recorded.
- **Templates** (foundation adds the kind to `MESSAGE_KINDS`, `KIND_PURPOSE` notice, `MESSAGE_KIND_LABEL` "Parts
  arrived", `FIELDS` `[...COMMON_FIELDS, "machine", "ref", "parts", "eta_line"]`):
  - `parts_in.sms`: `Hi {first_name}, the part for your {machine} ({ref}) came in: {parts}.{eta_line} We'll be in
    touch when it's ready.`
  - `parts_in.subject`: `The part for your {machine} is in`
  - `parts_in.email`: `Hi {first_name},\n\nThe part we ordered for your {machine} ({ref}) came in: {parts}.{eta_line}\n\nWe'll
    let you know when it's ready to pick up.`
  - `eta_line` is ` We expect to have it done by {date}.` when the receiver typed a date, else "".
- **Module gate.** The wait list is part of tickets: no module. The message needs Marketing like every other notice.
  Equipment gate as for any ticket edit (`ownTicket(…, "work")`): a lapsed Vac Shop still lets a pre-lapse vacuum
  ticket's wait be received and its customer told.
- **Exports.** `/api/export/tickets` gains `parts_waiting` (open waits as "description x qty (supplier)") and
  `parts_received`; a new `/api/export/part-waits` lists every wait with its dates.
- **Reports.** The dashboard's "Waiting on parts" count links to `/parts/on-order`.

### Files

`prisma/schema.prisma` + migration; `src/lib/part-waits.ts` (bodies: `addWaitFor`, `receiveWaitFor`,
`reopenWaitFor`, `cancelWaitFor`, `openWaits(shopId, { partId?, supplier? })`, `waitsForTicket`, `partsInStillWanted`);
`src/actions/part-waits.ts`; `src/components/slots/ticket-waits.tsx` (the ticket card) and `parts-on-order` page;
`src/lib/notices/hooks.ts` gains the `parts_in` branch of `stillWanted`; templates and constants;
`scripts/checks/part-waits.check.ts` (record, receive with and without Marketing, the one-message-per-ticket rule,
dedupe, reopen cancels the queued message, tenant section); `tests/parts-in.spec.ts`.

---

## 2. Online booking on the shop's website (package `online-booking`)

### What the owner described

Customers book appointments and sign up for classes from the shop's own website, and the booking lands on the
StitchBench calendar and class roster. Offer it on the hosted version first, where it needs no set-up.

### What exists today

Appointment types with hours, capacity and shared resources; `freeSlots` / `freeWeek`; `bookAs`; classes with seats,
waiting lists, `enrollIn`; booking and class sign-up confirmations and reminders; the public address (`PUBLIC_URL`,
the Windows links port) serving only `/e/*` (estimates) and `/u/*` (unsubscribe); `allowPublic` rate limiting;
consent recording (`recordConsent`, `consent_confirm` texts).

### Rules

- A shop switches it on in **Settings → Scheduling → Online booking** (admin, Scheduling module active): a public
  **slug** (`Shop.bookingSlug`, lower-case letters, digits and dashes, unique across the install, suggested from the
  shop name), which appointment types are bookable online (`AppointmentType.online` boolean, default off), which
  classes (`ShopClass.online`, default off; only OPEN classes with seats or a waiting list show), **lead time** (hours
  from now before the first offered slot, default 24), **how far ahead** (days, default 60), and the welcome text.
  Payment is at the counter in this version (the fee is shown; "pay when you come in"). Deposits come with the
  online shop's payment work (section 3).
- The public pages live under `/book/{slug}` and are served on the public address like `/e` and `/u`
  (`src/proxy.ts` adds `/book/` and `/api/book/` to the links-host allow list). On the hosted app the slug alone is
  the link: `https://stitchshop-production.up.railway.app/book/sew-and-vac`. The Windows program needs its public
  address and tunnel, as for estimate links; without one, the Settings page says so and the switch is disabled.
- **Embedding.** Settings shows the link and an `<iframe>` snippet (height 900, the page sets
  `Content-Security-Policy: frame-ancestors *` for `/book/*` only). The page is plain, narrow, no nav, the shop's
  name and phone at the top, works at phone width.
- **Flow (appointment).** `/book/{slug}`: the shop's bookable types and open classes as cards. A type:
  `/book/{slug}/a/{typeId}?date=` shows 14 days of free times (`freeWeek`, honouring lead time, how far ahead, hours
  and capacity across the shared resource) → the customer picks one → a short form: name, phone, email, "How should
  we tell you" (email, text), a text-consent line ("Reply STOP to cancel; message and data rates may apply") when
  text is chosen, a note, and a required "I'm a person" check (a honeypot field plus a 5-second minimum fill time; no
  captcha service). Submit posts to `/api/book/{slug}` which:
  1. rate-limits per address (`allowPublic("book", 10, 10 min)`) and per slug (60 an hour);
  2. finds the customer by phone or email within the shop (normalised; an existing TRADE customer is refused), else
     creates one with `notifyBy` from the form and `recordConsent(source: "online booking")`; a chosen text channel
     records `smsConsentAt` only after the `consent_confirm` text is answered as the design already does for the
     counter;
  3. books with `bookAs`'s body under a system user context (`byUserId null`, `source "online"` on the appointment:
     `Appointment.source String @default("counter")`), re-checking the slot inside the transaction (the same
     `overlapCount` guard, so two customers can't take the last slot);
  4. queues the normal booking confirmation (`booking` kind), with a **manage link** `/book/m/{token}` (a 32-byte
     token hashed in a new `BookingLink` table, like estimate links) that lets the customer cancel or move it until
     the lead time, which runs through `setApptStatusAs` / `rescheduleApptAs`'s bodies;
  5. shows a confirmation page (what, when, where, "we'll remind you the day before").
- **Flow (class).** `/book/{slug}/c/{classId}`: the class, its meetings, fee, seats left or "waiting list"; the same
  form; `enrollIn` with the waiting list when full; the `class_signup` confirmation; the roster shows "online".
- **Staff side.** New online bookings appear on the calendar and in a "Booked online" pill; the Dashboard's today
  slot counts them; an admin can turn a type or class off for online booking at any time (existing bookings stay).
- **Abuse and privacy.** No customer data is ever shown on the public pages except the booker's own on the
  confirmation; the manage link shows first name and the booking only. Tokens expire with the appointment. Every
  public request is logged with its address for 30 days (`PublicRequest` rows are already kept for `/e`; reuse).
- **Gate.** Scheduling active, or the pages answer "Online booking isn't available right now. Call us at {phone}."

### Files

Schema (`Shop.bookingSlug`, `Shop.bookingSettings Json`, `AppointmentType.online`, `ShopClass.online`,
`Appointment.source`, `Enrollment.source`, `BookingLink`), `src/lib/online-booking.ts` (bodies: `publicShop(slug)`,
`publicTypes`, `publicClasses`, `publicFreeTimes`, `bookOnline`, `signUpOnline`, `manageByToken`, `cancelByToken`),
`src/app/book/[slug]/…` (outside `(app)`, no auth), `src/app/api/book/[slug]/route.ts`, `src/proxy.ts` allow list,
Settings page section and `src/actions/online-booking.ts`, `scripts/checks/online-booking.check.ts` (slots honour
lead time and capacity, the last-slot race, customer matching, consent, manage link, tenant: one shop's slug never
reaches another's types), `tests/online-booking.spec.ts` (a signed-out browser books and signs up; the roster and
calendar show them; the manage link cancels).

**Hosted first.** The hosted app has `PUBLIC_URL`; the Windows program gets it when the owner sets up a tunnel. The
Settings page spells both out.

---

## 3. An online shop from the inventory (package `online-shop`, scope only)

### What the owner described

Sell parts and supplies online from the shop's own inventory, with the stock and prices coming from Parts, offered on
the hosted version where it integrates easily.

### Scope for a first version (to be designed in full after 1 and 2 are built)

- **Catalog**: a part is listed when `Part.online` is on and it has a price and a description for customers
  (`onlineTitle`, `onlineText`, up to 4 photos reusing `MachinePhoto`'s storage pattern as `PartPhoto`). Stock shown
  as "in stock" / "out of stock" (never the count). Categories from `Part.kind` and the cross-reference's category.
  Search by number, brand, model (the Fits list) and words, which the register already does.
- **Pages**: `/shop/{slug}` on the public address (same allow-list mechanism as booking): list, search, item, cart,
  checkout, order status by token. Same plain look as the booking pages, embeddable.
- **Checkout and payment**: Stripe Checkout (Stripe's hosted page; no card data touches StitchBench) with a Stripe
  account per shop connected through Stripe Connect Standard, keys stored sealed like the mail password. Taxes through
  Stripe Tax or the shop's one rate (`Shop.taxRatePct`) as a setting. Fulfilment: pickup at the shop (default) or
  flat-rate shipping the shop sets. The webhook (`/api/shop/stripe`) confirms payment and creates the **Sale** in the
  register's books with tender `ONLINE`, lines decrementing stock as a register sale does (`completeSaleAs` with a
  system user), so sales reports, CSVs and consigned-stock rules need no second path. Out of stock at payment time:
  refund that line automatically and tell the customer.
- **Orders screen** for staff: `/register/online` listing paid orders to pack, "Picked up" / "Shipped (tracking)",
  refunds through the register's void or return as today. Email updates through Marketing's mail (order received,
  ready for pickup, shipped), kind `order_notice`, purpose notice.
- **Customers**: matched or created as in booking; an order creates the customer's account-less record only.
- **Hosted first**, like booking; the Windows program would need the tunnel and a reachable webhook, so the design
  should say plainly that the online shop is a hosted feature.
- **Not in the first version**: customer accounts and passwords, variants and options, gift cards, discount codes,
  marketplace-style selling between shops (the hub's market already covers shop-to-shop).

### Open questions for the owner

1. Pickup only, or shipping too, in the first version?
2. Does every shop connect its own Stripe account (Connect Standard), or does StitchBench collect and pay out?
3. Should online orders count toward the daily mail cap like marketing, or like notices?

---

## Build order and gates

`parts-in` first (small, no public surface). Then `online-booking` behind the Scheduling module. Then the full design
of `online-shop`, after the owner answers the questions above. Each package gets a check script with a tenant
section and a Playwright spec, as every package so far.
