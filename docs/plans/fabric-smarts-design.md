# Fabric Smarts: what sells, bolt ends, fat quarters, kits and reordering (design, 3 Oct 2026)

The owner's idea (3 Oct 2026, on a shop hop): help a quilt shop make more from its fabric. See what sells, turn bolt
ends and slow fabric into fat quarters, kits or markdowns before they go stale, suggest reorders while a collection is
still in print, build kits from patterns, show a picture of every fabric everywhere, and later order straight from the
big wholesalers.

The research behind it is in `docs/research/`:
- `fabric-merchandising-practices.md`: how shops handle fat quarters, bolt ends, kits and reorders today.
- `fabric-analytics-methods.md`: the formulas and default thresholds (section 9 below uses its table).
- `fabric-wholesalers-and-patterns.md`: manufacturers, distributors, images, patterns, three DRAFT outreach emails.
- `fabric-images-data-and-ai.md`: picture sources, bolt labels, AI reading of labels, copyright.
- `fabric-competitors-and-pain-points.md`: what Rain, Like Sew and others do, and what owners complain about.

Nothing here is built. It comes after the launch and the test month (HANDOFF item 19), unless the owner moves it up.

## 1. Why it matters

- Fabric is most of a quilt shop's sales (60 to 70% in business-plan sources; weak, but consistent with what owners
  say), and a collection is usually printed once: reorder it while it sells, or it's gone in about a year.
- Fat quarters bring in about 37% more per yard than the same fabric by the yard (online prices compared).
- No product found suggests markdowns or turns a bolt end into fat quarters with one action. Rain and Like Sew are one
  company (Like Sew is Rain's quilt-shop brand), from $99 a month on an annual plan with the higher tiers' prices
  hidden; reviewers praise "load a product once" and web sync and complain about price, slow reports, support delays
  and cancelling. PayGo and POSIM name bolts and fat quarters; Square, Lightspeed, Shopify and Clover are general.
  Nobody shows entering a whole collection at once. Clear prices and easy export are themselves a selling point.
- What StitchShop already has: yards on every fabric (`Part.qtyOnHand`, eighths of a yard), price and cost, a dated
  history of every receipt, cut and sale (`StockMove`, `SaleLine`), the maker (`brand`), supplier text and sources
  (`PartSource`), a reorder point, photos (`PartPhoto`, used by the online shop), and kinds FABRIC and PATTERN.

## 2. What the shop sees: a Fabric page

One page in StitchShop, for companies that sell retail, with five tabs. Every row shows the fabric's picture.

1. **Bolt ends.** Fabrics with 1 yard or less left and none on order. Each row offers:
   - **Cut into fat quarters**: "1 3/8 yd makes 5 fat quarters, with 1/8 yd left." One tap takes the yards off the
     bolt, adds them to that fabric's fat-quarter item (made the first time, priced at the yard price / 4 x 1.15,
     shop's setting), and records both moves. Half-yard cuts the same way.
   - **Mark down**: the next step on the shop's markdown ladder (20%, then 35%, then 50%, never below cost x 1.05).
   - **Use in a kit**: opens the kit builder with this fabric.
   - **Remnant bin**: moves it to a remnant item at a remnant price.
2. **Slow fabric.** Fabric received 90 days ago or more and less than 60% sold (first in, first out from the receipt
   history). The suggestion says which pays more, with the numbers: "Mark down 20%: $2.60 a yard margin. As fat
   quarters: $4.10 a yard. Cut it." At 180 days it suggests clearance.
3. **What sells.** Yards a week and weeks of supply for every fabric, best sellers on top; the same rolled up by
   maker, collection, designer, color and price band; margin return on inventory (GMROI) by maker and supplier; the
   A/B/C grade (the fabrics that make 80% and 95% of fabric margin).
4. **Reorder.** Fabrics worth reordering while still in print, with a suggested amount rounded to half bolts: expected
   sales over the supplier's lead time plus a safety margin, less what's on hand and on order. "Reorder now" when a
   fabric sold 60% within 28 days and will run out before the next delivery. Ticking rows builds a purchase order per
   supplier (section 5).
5. **Kits.** The kit builder (section 4) and each kit's sell-through.

The register's item search, the stock list, the kit builder and purchase orders show the fabric's picture too.

## 3. Pictures and fast data entry

Entering new fabric (number, name, collection, designer, photo) is the chore owners name most. In order of value:

1. **Photo of the bolt-end label fills in the fabric.** The label carries the maker's item number, color, width and
   content. The Assistant reads the photo (Claude Haiku 4.5 vision, about a third of a cent a photo: 5,000 fabrics
   for about $15) into a prefilled new-fabric form the shop checks and saves; the same photo can be the swatch. Part
   of the Assistant add-on (`docs/plans/ai-assistant-scope.md`), through the hub's proxy like its other calls.
2. **A shop's own picture zips.** Moda and Riley Blake publish collection picture zips for their retailers. The shop
   downloads them itself and drops the zip in; StitchShop matches pictures to fabrics by the maker's item number.
   Pictures stay the shop's own (no shared library on the hub: section 7).
3. **A whole collection at once.** New collections arrive as a dozen or more colorways. "Add a collection": the
   maker, collection and designer once, then a row per colorway (item number, color, yards received, price), filled
   from a label photo, the maker's picture zip or a pasted list. No competitor shows this.
4. **A phone photo helper.** "Take swatch photo" on a fabric: square crop, plain light tips, a ruler for scale.
5. **Color and theme tags** read from the picture (floral, batik, solid, holiday; main colors), so "What sells" can
   say "blues and batiks sell; holiday fabric sits". Part of the Assistant, a fraction of a cent per picture.

Later: "find fabric like this scrap" (dominant color first, image matching after), barcode lookup (bolts don't
reliably carry barcodes: the owner is checking bolt ends on the hop).

## 4. Kits

- A kit is a recipe: fabric cuts (fabric and yards each), a pattern (a PATTERN item, or a note of its source), notions,
  and a kit price. "Make 6 kits" takes the yards and items off stock and adds 6 to the kit's own stock item, which
  sells at the register and online like anything else.
- Price suggestion: the larger of cost / 0.5 (50% margin) and the parts' retail value less up to 10%.
- Block of the Month: a kit series (month 1 to 12) with sign-ups; it can reuse the classes' roster later.
- Pattern rights: using a pattern in kits needs the publisher's permission, and each publisher's terms differ (Moda
  Bake Shop patterns are personal use only). The kit records the pattern and its source; the shop handles permission.

## 4a. Suppliers of kits and pattern cards, and clubs (research: `docs/research/kits-patterns-and-money-makers.md`)

- **Pattern cards:** Villa Rosa Designs (4x6 postcard patterns; a wholesale site with account ordering and cards a shop
  can brand); small designers with low minimums (2 copies per pattern, or 5 to 8 per design), some with UPCs printed.
  Big publishers set minimums (It's Sew Emma: 3 per item, 12 items, prepaid). Distributors carry many designers:
  Checker, Brewer, United Notions/Moda, EE Schenck, Petersen-Arne, QuiltersWarehouse.com. No publisher offers pattern
  data (fabric requirements, UPC files): a pattern is entered like any item, its cover photo as the picture.
- **Ready-made kits:** Riley Blake, Andover (the only published kit terms: 50% non-refundable deposit on special-order
  kits and precuts), Moda, Hoffman, Benartex, Robert Kaufman, Island Batik. A bought kit is a plain stock item; a kit
  the shop cuts itself uses the kit builder (section 4).
- **Clubs and programs (package F7):** the steadiest money a shop has, and what the software must do for each:
  - *Fat quarter and fabric clubs* (about $40 a month): monthly billing with a card on file on the shop's own Stripe,
    a fixed bill date, pause and cancel, failed payments, a monthly pick list, ship or pick up per member.
  - *Block of the Month, kit of the month, mystery quilts* ($20 to $45 a month): a roster, the whole program's fabric
    reserved at sign-up, deposits or monthly billing, each month's handout marked done, a dated clue schedule.
  - *Retreats* ($150 to $450 a head): the classes' roster with capacity and waiting list, plus deposits, payment plans
    and refund rules.
  - *Longarm rental and quilting service* (rental $15 to $44 an hour; service 2 to 10 cents a square inch): machine
    booking on the calendar, a "certified to rent" flag on the customer, hourly billing, and a quilting work order
    that reuses the repair ticket (received, on the frame, ready, collected).
  - *Events* (Row by Row about $100 to join, said to bring about 200 new customers; shop hops said to lift sales 20 to
    25%): event kit items, and capturing new customers at the register (a quick "join our list").

## 5. Ordering

- **Now (no partners needed):** purchase orders per supplier from the Reorder tab or by hand: lines in yards or bolts
  with the maker's item numbers, emailed or printed for the rep, or exported as a spreadsheet; "Receive" on the order
  adds the yards (a RECEIVED move, which also starts the age clock) and records the supplier's lead time.
- **Next, with partners:** catalog import and electronic ordering. Notions Marketing already connects to Rain and Like
  Sew for catalog, purchasing and receiving and relaunched its wholesale site in June 2026 with spreadsheet import;
  Checker Distributors' catalog is already in Like Sew; Moda publishes collection pictures and in-store dates. The
  outreach drafts are in `fabric-wholesalers-and-patterns.md`, for the owner to send. Order of approach: Notions
  Marketing, Checker, Moda, Brewer, then the Jaftex group (FreeSpirit, Henry Glass, Studio E, Blank: one account).

## 5a. Connectors to wholesalers (research: `docs/research/wholesaler-integration-channels.md`)

One connector framework, one small adapter per wholesaler. Each adapter answers the same five things: catalog,
prices, stock, place an order, order status; anything it can't do falls back to the next channel down. The rest of
the program never knows which wholesaler it talks to.

- **Channels, easiest first:** (1) files: read the wholesaler's catalog spreadsheet through a column-mapping step,
  write orders in its cart-upload layout for the shop to upload on the wholesaler's site; (2) email: a formatted
  purchase order to the rep; (3) API, where a partner gives one; (4) EDI (850 order, 855 acknowledgement, 856 ship
  notice, 810 invoice) through a network, last: $20 to $3,000 a month plus per-partner setup, and no quilt wholesaler
  appeared on the public EDI directories.
- **Where they run:** files and email in the program. API and EDI on StitchHub, which holds the partner keys like the
  Assistant's proxy; the shop's account number with the wholesaler lives in the shop's settings. Never a shop's
  wholesaler password, and never logging in to a wholesaler's website to scrape it (their terms forbid it, and it
  would cost us the partnerships).
- **Order of work:** the generic file and email connectors first (they work with any wholesaler, no permission
  needed); Notions Marketing next (its Virto Commerce B2B site takes CSV import and quick order by SKU; ask for the
  column layout and for the same automated ordering and receiving Rain has); Checker and Brewer (ask for the catalog
  feed Like Sew and MicroBiz already receive); Moda; the Jaftex group (four lines, one conversation); written feed
  requests to Riley Blake, Kaufman, Andover, Benartex, Northcott, Michael Miller and Windham; EDI only if a partner
  requires it. Faire: skip (no retailer API, and the main quilt fabric makers aren't on it).

## 6. Data the program needs to add

- On a fabric (`Part`): collection, designer, color tags, bolt size (default 15 yd), in print (yes / no / unknown),
  and the fat-quarter and remnant items it feeds (links between items).
- On a supplier: lead time (days, learned from received orders), minimum order, contact for orders.
- `SaleLine`: the cost at the time of sale (today margin uses the current cost).
- New: `Kit` and its lines; `PurchaseOrder` and its lines (each a per-company table, so `src/lib/move/format.ts`
  carries them); a markdown record (price, from and to, when, why) so the markdown ladder knows the current step.
- New stock-move reason `CUT` (bolt to fat quarters, half yards, remnants, kits), with the from and to items linked.
- Every new action goes through `safe()` and `lapse-allow.ts` like the rest; money in integer cents; yards in eighths.

## 7. What not to do

- **No shared fabric library on the hub.** Hosting and handing manufacturer pictures across shops is the risky case
  (printed designs are copyrighted artwork; makers allow retailers to show them, not a software company to
  redistribute them). Each shop's pictures stay its own. Revisit only with a maker's written OK.
- **No price display beyond the shop's own prices**: Riley Blake and others have minimum advertised price policies.
- **No automatic markdowns or orders.** Everything is a suggestion with the numbers; the shop decides.

## 8. Packages and effort (after the test month)

| Package | What | Effort |
|---|---|---|
| F1 `fabric-basics` | the new fields, CUT moves, bolt ends with "cut into fat quarters / half yards / remnant", "add a collection", pictures in the register search and stock list | 4 to 5 days |
| F2 `fabric-insight` | What sells, Slow fabric, the markdown ladder and records, GMROI and A/B/C | 3 to 4 days |
| F3 `fabric-orders` | Reorder suggestions, purchase orders, receiving, lead times | 4 days |
| F4 `kits` | the kit builder, making kits, kit sell-through, Block of the Month series | 3 days |
| F5 `fabric-ai` (Assistant) | bolt-label photo to new fabric, picture-zip matching, color and theme tags | 2 to 3 days |
| F7 `clubs` | fabric clubs and Block of the Month with monthly billing on the shop's Stripe, reserved fabric, monthly pick lists; longarm work orders on the ticket system | 5 to 6 days |
| F6 `connectors` | the connector framework with the file and email connectors (any wholesaler); then one adapter per partner as each agrees (Notions Marketing first) | 3 days, then 1 to 3 per partner |

## 9. Default numbers (the shop can change every one)

From `fabric-analytics-methods.md` ("published" or "our default" is marked there): velocity over 12 in-stock weeks
(Croston method for lumpy sellers); a new fabric counts as early until 21 days, fully its own by 42; bolt end at 1 yard
or less; fat quarter = yard price / 4 x 1.15; aging watch 90 days, first markdown 120 days if under 60% sold, clearance
180 days; markdown steps 20%, 35%, 50%, floor cost x 1.05; reorder rounded to half bolts, in print only, safety stock
z 1.28 for collections and 1.65 for staples; "reorder now" at 60% sold in 28 days with supply under lead time plus 2
weeks; GMROI good at 3.0, review under 1.5; A/B/C at 80 and 95% of margin; kit price max(cost / 0.5, parts' retail
less up to 10%). Quilt-specific benchmarks barely exist (most come from one Riley Blake blog post and general apparel
retail), so these are starting points, and the first test shops' data should tune them.

## 10. Decisions for the owner

1. **Base or add-on?** Recommended: F1 to F4 in the base StitchShop. They're the core of what a quilt shop pays Rain or
   Like Sew for, and the strongest reason to switch. F5 rides on the Assistant add-on ($15). F6 included when a
   partner signs.
2. **Order of building:** recommended F1, F2, F3, F4, F5 after the test month; F1 could start during it on the branch.
3. **Outreach:** recommended the owner sends the Notions Marketing and Moda drafts once StitchShop has its first
   paying shops (a partner asks "how many shops?").
4. **Bolt barcodes:** the owner checks ten bolt ends on the hop; if most carry a UPC, scanning gets a package.
