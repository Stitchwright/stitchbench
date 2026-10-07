# Fabric inventory analytics for a small quilt shop: methods and defaults

Researched 3 Oct 2026 for StitchShop. Purpose: pick analytics that can be computed from our data (qtyOnHand in eighths of a yard, price and cost per yard, dated stock moves RECEIVED/SOLD/ADJUSTED, brand, supplier, reorder point, sales lines with price, discount, date).

## How to read this document

- "Published" means a source states the number. "Our default" means I chose it, usually by adapting general retail practice to fabric. Every default must be a shop setting.
- Honest limits of the evidence: quilt-specific published numbers are few. The Fabric Shop Network benchmark article (2003) gives the formulas but its benchmark table is not in the text I could read. The numbers most often quoted for quilt shops (50% margin, 4 to 6 turns, 3 to 6 months on the shelf) come from one distributor blog (Riley Blake Designs). Sell-through thresholds and markdown ladders are general apparel retail, not quilt-specific. Nobody publishes a quilt-shop sell-through benchmark that I found.
- Units: work in yards as a decimal (eighths are 0.125). Money in integer cents. Where a formula needs "average inventory", use time-weighted daily balances rebuilt from the stock-move history, not the start and end snapshots.

## Notation

```
q(d)      yards on hand at end of day d (rebuilt from RECEIVED/SOLD/ADJUSTED history)
sold(a,b) yards SOLD between dates a and b (exclude ADJUSTED, count returns as negative sales)
cost, price  per yard, cents
age       days since the first RECEIVED of the current bolt/lot (see section 3)
```

## 1. Sell-through rate and weeks of supply

**Sell-through (plain words):** the share of what you had available in a window that you sold. Published form: units sold divided by units received (or by beginning-of-period units on hand), times 100.

```
sellthrough(item, window) = sold(window) / (q(start) + received(window))
sellthrough_lot(item)     = yards sold since lot received / yards in the lot received
```

For fabric use the lot form for a collection that prints once ("of the 60 yards I bought, how many have sold"), and the window form for staples.

Sources:
- Formula ST% = Units sold / BOP units on hand x 100, and the receipts variant: https://www.toolio.com/post/sell-through-rate-how-to-calculate-and-5-strategies-to-optimize and https://www.toolio.com/post/fundamental-retail-math-formulas
- Thresholds (general retail, not quilt): below 40% critically slow, 40 to 65% below target, 65 to 80% healthy, 80 to 90% strong (watch stockouts), above 90% excellent but may mean missed sales. Apparel 65 to 85%, home goods 55 to 75%: https://www.toolio.com/post/sell-through-rate-how-to-calculate-and-5-strategies-to-optimize
- A 60 to 70% sell-through by week 8 of a 12-week season is described as good: https://qoblex.com/blog/essential-retail-kpis-complete-guide-to-measuring-store-performance-in-2025/ (secondary source; treat as indicative).

**Weeks of supply (plain words):** how many weeks the stock on hand lasts at the current selling rate.

```
WOS = q_now / velocity_yards_per_week        (velocity from section 2)
turns_per_year = 52 / WOS
```

Sources:
- WOS = on-hand / weekly rate of sale; forward WOS uses a forecast rate: https://www.toolio.com/post/how-to-calculate-weeks-of-supply-and-set-target-levels and https://www.inventory-planner.com/weeks-of-supply/
- Target WOS should be at least supplier lead time plus a buffer (lead time x 1.25), and turns = 52 / WOS: https://www.toolio.com/post/how-to-calculate-weeks-of-supply-and-set-target-levels
- Compute the rate only over weeks the item was in stock, otherwise stockout weeks drag the rate down (the source's example understates demand by 30%+): same Toolio page.
- Quilt-shop turnover target 4 to 6 per year with a warning below 3, i.e. WOS of about 9 to 13 weeks; fabric should sell within 3 to 6 months: https://www.rbdblog.com/2025/02/11/the-numbers-behind-a-successful-quilt-shop-setting-yourself-up-for-success/ (Riley Blake Designs blog, a supplier's rule of thumb, not a survey).
- Shop-level turnover formula used by quilt-shop consultants: COGS / average inventory at cost (Laurie Harsh, The Fabric Shop Network, Craftrends Oct 2003): https://fabshopnet.com/wp-content/uploads/downloads/QuiltShopBenchmarks_2.pdf

Our default bands (adjustable):

| Measure | Healthy | Watch | Act |
|---|---|---|---|
| WOS (staples) | 8 to 16 | 16 to 26 | over 26 or under lead time |
| WOS (collections) | 6 to 20 | 20 to 34 | over 34 |
| Lot sell-through at 90 days | 60% or more | 40 to 60% | under 40% |
| Shop turns per year | 4 to 6 | 3 to 4 | under 3 |

Staples (solids, basics) tolerate longer supply than one-print collections; that split is my judgment, based on the Home Goods WOS band of 17 to 26 weeks in the Toolio table above for slow categories.

## 2. Velocity and smoothing for slow, lumpy sales

Fabric sells in lumps (a customer buys 3 yards for a quilt back, or a whole bolt). A 4-week average swings wildly. Use three layers.

**Layer A, in-stock trailing rate (simple, explain-able):**

```
days_in_stock(window) = days in window with q(d) > 0
velocity_wk = sold(window) / days_in_stock(window) * 7
use window = 12 weeks (84 days), shrink to age if the lot is younger
```

**Layer B, exponential smoothing on weekly buckets:**

```
v_t = alpha * sold_week_t + (1 - alpha) * v_(t-1)      alpha = 0.2 (slow items), 0.3 (steady)
```

**Layer C, for very lumpy items (more than about half of weeks have zero sales), use Croston with the SBA correction:** smooth the size of non-zero sales and the gap between sales separately, then divide.

```
size_t = a*z_t + (1-a)*size_(t-1)   only when a sale happens (z_t = yards in that sale week)
gap_t  = a*n_t + (1-a)*gap_(t-1)    n_t = weeks since previous sale
forecast_per_week = size / gap * (1 - a/2)              a = 0.1 to 0.3
```

Sources:
- Croston's method: separate exponential smoothing of non-zero demand and of intervals; plain exponential smoothing overestimates mean demand and understates variance for intermittent series: https://www.researchgate.net/publication/254044245_A_Review_of_Croston's_method_for_intermittent_demand_forecasting and https://www.researchgate.net/publication/251527888_Forecasting_the_intermittent_demand_for_slow-moving_inventories_A_modelling_approach
- Smoothing constants typically 0.1 to 0.3 and the (1 - alpha/2) bias factor (SBA): https://nixtlaverse.nixtla.io/statsforecast/docs/models/crostonoptimized.html
- Reference implementation: https://pkg.robjhyndman.com/forecast/reference/croston.html

**New fabric with little history.** A collection has a launch bump, so a short window overstates later demand and a zero-history item has no rate. Blend a prior with the observed rate, shifting weight to observed data as days pass:

```
prior_wk   = median weekly velocity of comparable items' first 8 weeks
             (same brand, same line, or same price band, from the last 2 years)
w          = min(1, days_in_stock / 42)               (fully trust own data after 6 weeks)
velocity   = w * own_velocity + (1 - w) * prior_wk
if no comparables: prior_wk = shop median velocity of items in the same price band
```

Mark any velocity with days_in_stock under 21 as "early" in the UI and suppress aging and markdown alerts for it.

Sources: analogous ("like-for-like") forecasting borrows a comparable item's demand pattern for new or low-history items, keeping each item's own history separate: https://www.toolio.com/post/like-for-like-forecasting-how-to-borrow-demand-history-for-new-products ; general approaches https://www.prediko.io/forecasting-demand-planning/demand-forecasting-new-products. The 42-day blend is our default.

## 3. Aging, markdown ladder, cost of holding, convert versus mark down

**Age (plain words):** days since the stock arrived. For fabric track the age of the current lot: reset when a new RECEIVED lands, and age the unsold remainder by FIFO (the oldest received yards are the last still on hand).

```
FIFO: unsold_lots = received lots minus sold yards taken from oldest first
age_days(lot) = today - lot.received_date
item_age = yard-weighted average age of unsold lots; also report oldest_lot_age
```

Published age thresholds:
- Buckets of 30, 60, 90, 180, 365 days; fashion retailers typically flag at 60 to 90 days, electronics up to 120; dead stock usually over 180 days (many treat 90 days with no sales as the line for fast goods): https://www.finaleinventory.com/guides/inventory-aging-report/ and https://www.kladana.com/blog/inventory-management/dead-stock/ (search summaries; the Finale page itself would not parse).
- A staged cadence: first markdown around day 30 to 60, test 14 to 21 days, escalate if sell-through misses, clearance around day 90, liquidate 120+: https://www.cleverence.com/articles/for-business/end-of-aging-stock-4927/ (secondary).
- Quilt-shop: fabric should sell in 3 to 6 months; older stock ties up cash and shelf space; do quarterly markdowns or bundle slow fabric with fresh arrivals: https://www.rbdblog.com/2025/02/11/the-numbers-behind-a-successful-quilt-shop-setting-yourself-up-for-success/
- "The first markdown is always the cheapest markdown"; mark down when sales start to slow, before the season ends; an example step of $25.00 to $19.99 (about 20%): https://www.americanquiltretailer.com/taking-the-mystery-out-of-markdowns/
- Bolt ends and remnant bins are usually discounted 20 to 30% (search result summarising independent shop practice, weak source): https://sewing.patternreview.com/SewingDiscussions/topic/100147

**Our default ladder (percent off regular price, adjustable). Trigger on age AND pace, so a fast mover is not marked down just for age:**

| Stage | Trigger (all must hold) | Action |
|---|---|---|
| Watch | age 90 days, WOS over 26 | flag, move to a front display, bundle with a new arrival |
| Markdown 1 | age 120 days, lot sell-through under 60% | 20% off |
| Markdown 2 | 30 days after step 1, still under 75% sold | 35% off |
| Clearance | 30 days after step 2, or age 180 days | 50% off, or convert (below) |
| Floor | never below cost x 1.05 unless the owner confirms (write-off) | |

Check each stage using the item's "early" flag (section 2) so new fabric is skipped. A collection no longer in print gets no extra markdown pressure while WOS is under 26 (scarcity helps it).

**Cost of holding dead stock (plain words):** capital tied up plus space and risk, per year, as a share of cost.

```
holding_cost_per_week = qtyOnHand * cost * carry_rate / 52         carry_rate default 0.25
dead_stock_value      = sum(qtyOnHand * cost) where days since last sale > 180
```

Sources: carrying cost typically 20 to 30% of inventory value per year, made of capital, service, risk and space costs: https://fitsmallbusiness.com/inventory-carrying-cost/ and https://www.shopify.com/blog/inventory-carrying-costs . A quilt-trade article claims poor inventory management can cost 20 to 30% of annual revenue (weakly sourced): https://likesew.com/blog/quilt-shop-inventory . Use 25% as the default; for a small shop with no warehouse the space part is small, so 15 to 20% is defensible as the shop's own setting.

**Convert to fat quarters or kits instead of marking down: compare margin per yard.** Compute what a yard earns each way, net of cutting time:

```
margin_per_yard_markdown = price * (1 - discount) - cost
margin_per_yard_fq       = 4 * fq_price - cost - cut_minutes_per_yard * labor_per_minute - packaging
margin_per_yard_kit      = kit_price_share_of_this_fabric - cost - labor   (section 8)
rule: convert when margin_per_yard_fq > margin_per_yard_markdown_at_next_step
      and expected extra weeks to sell the cut pieces <= weeks of supply you would have anyway
```

Example (our numbers, all assumptions): cost $6.00, price $12.00 per yard. Markdown 1 at 20% gives $9.60, margin $3.60 per yard. Fat quarters at $3.25 each give $13.00 per yard, less $0.50 cutting and bagging, margin $6.50 per yard before any extra markdown. So convert first, discount later, as long as the cut pieces actually sell. Precut pricing above yardage is normal because cutting and packing take labour: The statement that precuts cost more than yardage because of labour and packaging comes from a search summary of https://www.thequiltedcowgirl.com/quilting-faq-the-quilted-cowgirl/pre-cut-quilting-fabrics-faq-the-quilted-cowgirl (not verified on the page). The premium percentage is not published; 10 to 25% over the pure per-yard price is our default.

## 4. Bolt ends, fat quarters and half yards

**Geometry (published):** a fat quarter is 18 x 21 inches, "a quarter yard cut wide": https://www.missouriquiltco.com/blogs/missouri-star-blog/building-blocks-all-about-precut-fabric . It is cut by taking a half yard (18 x 42) and halving it across the width: https://www.fatquartershop.com/quilting-clearance-sale (and the Diary of a Quilter explanation at https://www.diaryofaquilter.com/what-is-fat-quarter/ ). So:

```
1 yard           = 4 fat quarters = 8 fat eighths-equivalents (9 x 21) = 2 half yards
fat_quarters_from(remainder_yards) = floor(remainder_yards * 4)       (leftover under 0.25 yd is scrap)
half_yards_from(remainder_yards)   = floor(remainder_yards * 2)
```

**When a remainder is too small to sell by the yard.** No source publishes a number. Our default: a remainder under 1.0 yard (8 eighths) cannot satisfy the usual minimum cut (customers buy for borders and backs by the yard, and the shop's minimum is typically half a yard or one yard), so treat anything under `bolt_end_max_yards = 1.0` as a bolt end. Then:

```
bolt_end if q <= 1.0 yd and the bolt has no more yards coming
fq_yield = floor(q * 4)           # to sell as fat quarters
sell_as   = "remnant bag / bolt end" if q < 0.5 else "fat quarters or one cut"
```

Check every bolt-end item for these actions: (a) cut to fat quarters if q >= 0.5; (b) price remainder as a "bolt end" at 20 to 30% off (published practice, weak source above); (c) pool ends of the same collection into a bundle.

**Pricing a fat quarter versus by the yard:**

```
fq_price_floor    = price_per_yard / 4
fq_price_default  = round_up_to_quarter_dollar( price_per_yard / 4 * (1 + fq_premium) )   fq_premium = 0.15
margin_check      = fq_price_default - cost/4 - cut_cost_per_fq   should be >= yard margin% target
```

Sources: precuts cost more than yardage because of the labour and packing (Quilted Cowgirl FAQ above); typical gross margin on fabric 40 to 50% (keystone pricing), 50% target: https://startupfinancialprojection.com/blogs/profitability/quilt-shop and https://www.rbdblog.com/2025/02/11/the-numbers-behind-a-successful-quilt-shop-setting-yourself-up-for-success/ . The 15% premium is our default.

Note on quantity: StitchShop stores eighths, so the quantity is always a multiple of 0.125; a fat quarter is exactly 2 eighths.

## 5. Reorder suggestions for collections that may not be reprinted

Standard reorder math, then fabric rules on top.

```
lead_wk        = supplier lead time in weeks (shop setting, default 2)
demand_LT      = velocity_wk * lead_wk
sigma_wk       = standard deviation of weekly sales over the last 12 in-stock weeks
safety         = z * sigma_wk * sqrt(lead_wk)        z = 1.28 (90%), 1.65 (95%)
cover_wk       = review_period_wk + lead_wk          (how long this order must last)
target_yards   = velocity_wk * cover_wk + safety
order_yards    = max(0, target_yards - q_now - on_order)
order_bolts    = round(order_yards / bolt_yards) to nearest half bolt, min 0.5 bolt
```

Sources: ROP = demand over lead time + safety stock; SS = Z x sigma x sqrt(lead time); Z 1.65 for 95%, 2.33 for 99%: https://www.netsuite.com/portal/resource/articles/inventory-management/safety-stock.shtml and https://www.netstock.com/blog/reorder-point-formula/ . WOS target at least lead time + 25%: https://www.toolio.com/post/how-to-calculate-weeks-of-supply-and-set-target-levels . Quilt-shop staples: keep at least 3 bolts per color for solids; seasonal collections get a lower threshold since they are not restocked year round; remind to order ahead of the selling season (for example June for fall fabrics): https://likesew.com/blog/quilt-shop-inventory .

Because StitchShop already has a per-item reorder point, show both the manual reorder point and the computed one, with the computed one as a suggestion only.

**Fabric rules on top (our design):**

1. **In print only.** Add an `inPrint` state per collection or item (unknown, in print, closed out). Suggest a reorder only when it is not "closed out". Until a supplier feed exists, the owner sets it, or `unknown` is allowed to suggest with a note "check the supplier".
2. **Rounding.** Round up to half bolts when the in-print window is short; when velocity is under about 0.5 yd per week, suggest half a bolt at most.
3. **Never reorder an aged item.** If age is over 120 days and lot sell-through is under 60%, skip the suggestion (that is the markdown ladder's job).
4. **Safety stock for a single-print collection.** Use z = 1.28 and cap cover_wk at what the remaining in-print window allows, since leftover stock after the reprint ends is dead stock.

**Flag "best seller, reorder now while available":**

```
best_seller = lot_sellthrough >= 0.6 within first 28 days
              OR velocity_wk >= 2 * median velocity of the same brand's first-6-week items
              OR ABC class A within the last 90 days
urgent      = best_seller AND WOS < lead_wk + 2 AND in-print != closed out
```

The best-seller thresholds are ours. Published support for the principle: sell-through above 90% "may indicate missed sales", i.e. stockouts of a winner are costly: https://www.toolio.com/post/sell-through-rate-how-to-calculate-and-5-strategies-to-optimize

## 6. Open-to-buy for a small shop

**Plain words:** the money you may still spend on new fabric this month so that stock at month end hits plan. It is a ceiling, not a target.

```
OTB_retail = planned_sales + planned_markdowns + planned_EOM_stock - BOM_stock      (all at retail)
OTB_cost   = OTB_retail * (1 - planned_margin)  - on_order_at_cost                  (cash to commit)
planned_EOM_stock = planned_next_month_sales * stock_to_sales      (stock_to_sales = target WOS / 4.33 months)
```

Sources: OTB = planned sales + planned markdowns + planned end-of-month inventory - beginning-of-month inventory; the planned EOM becomes next month's BOM; plans of six months, reviewed as often as weekly; example $7,000 BOM, $90,000 sales, $600 markdowns, $5,000 EOM = $88,600: https://fitsmallbusiness.com/open-to-buy-planning/ and https://www.shopify.com/blog/open-to-buy-plans ; the same formula with a worked example: https://koronapos.com/blog/what-is-open-to-buy/ . It is a ceiling that protects cash flow: Shopify page above.

Where our data feeds each term:
- planned_sales: same month last year x (1 + growth), else the trailing 3-month average; owner can override. Shops are seasonal (quilt-along, holiday, back-to-school), so use last year's month when it exists.
- planned_markdowns: the retail value of discounts in the ladder for the stock due to be marked down plus last year's markdown percent of sales (our default 5 to 8% of sales).
- BOM_stock: sum of qtyOnHand x price on the 1st (retail) from the rebuilt balances.
- planned_EOM_stock: by default target_WOS (say 14 weeks, 3.5 turns) times next month's planned weekly sales, a stock-to-sales ratio. At 4 turns a year, retail stock to monthly sales is about 3 months.
- on_order: open purchase orders at cost (a data gap for now; allow manual entry).

Retail-to-cost conversion uses the shop's blended margin; do not mix retail and cost in the same line.

## 7. GMROI, ABC and "what sells"

**GMROI (plain words):** gross margin dollars earned per dollar of average inventory at cost. Equals margin percent times turns on cost.

```
GMROI = gross_margin_$ / avg_inventory_at_cost            over 12 months (or annualise a shorter window)
      = (gross_margin_$ / COGS) x (COGS / avg_inventory_at_cost) = margin-on-cost x turns
gross_margin_$ = sum(line_net_price - qty_yards * cost_at_time_of_sale)   (discounts already in net price)
avg_inventory_cost = mean over days of sum(q(d) * cost)
```

Sources: GMROI = gross margin / average inventory cost; 3.0 or more is a common goal; GMROI = margin % x turnover: https://cashmarginpartners.com/blog/what-is-gmroi-a-retailer-s-definition , https://www.shipbob.com/blog/gmroi/ , https://quickbooks.intuit.com/r/midsize-business/gmroi-formulas-calculations-for-inventory-analysis-methods/ . Store-level GMROI hides weak categories (a store at 1.00 may hide categories below 0.60), so compute by vendor/brand and category: cashmarginpartners page above. A fast item at low margin can lose to a slower item at high margin, which is why we show GMROI beside turns.

Default bands: 3.0 or more good, 1.5 to 3.0 ok, under 1.5 review. For a shop that keeps fabric 3 to 6 months at 50% margin, expect about 2 to 4 (our arithmetic: 50% margin on price means 1.0 margin dollar per cost dollar sold, times 2 to 4 turns on cost).

**ABC (plain words):** rank by yearly value, cut at cumulative shares.

```
value(item) = 12-month net sales $ (or gross margin $; margin is better for ordering decisions)
sort descending; cum% = running share of total
A: cum% <= 80     B: 80 < cum% <= 95     C: rest
```

Sources: A is about 80% of value from 10 to 20% of items, B the next 15%, C the last 5%; cutoffs of 70/20/10 or 65/25/10 are used when skewed: https://www.getonecart.com/abc-analysis-inventory/ , https://www.mrpeasy.com/blog/abc-analysis/ , https://inventoryquick.com/blog/abc-analysis-inventory-worksheet . For fabric, rank by collection (brand + line) as well as by item, because individual SKUs of a printed collection sell as a family. Group levels our data supports now: item, brand (manufacturer), supplier. Collection and designer need a field we may not have (check the schema; a collection can be derived from a name prefix as a stopgap).

New items (under 42 days) are "unrated", not C.

**"What sells" views.** Our data allows now: brand, supplier, price band. Needs new optional fields: collection, designer, color family. Method:

```
group velocity = sum(sold yards in group) / sum(in-stock item-weeks in group)    (a rate per item, so groups of different size compare fairly)
sell-through by group = group yards sold / group yards received
price band = tertiles or fixed steps of price per yard ($8-10, 10-12, 12-14, 14+)
rank groups by GMROI and by sell-through; show the top and bottom 5
```

This answers "which brands/price bands should I buy more of" for the open-to-buy budget: allocate the cost budget across groups in proportion to GMROI x current share, within a cap (our design).

## 8. Kits and bundles

**Cost and price a kit from its components (plain words):** sum the cost of each fabric at the yardage the kit uses, add the pattern, notions, packaging and assembly time; price to the shop's margin target or at the sum of component retail less a bundle discount, whichever is higher.

```
kit_cost  = sum(yards_i * cost_i) + pattern_cost + notions_cost + packaging + assembly_minutes * labor_rate
kit_list  = sum(yards_i * price_i) + pattern_price + notions_price         (what the customer would pay separately)
kit_price = max( kit_cost / (1 - target_margin), kit_list * (1 - bundle_discount) )
kit_margin_% = (kit_price - kit_cost) / kit_price
```

Defaults: target_margin 0.50 (published fabric target), bundle_discount 0 to 10%, assembly 10 minutes per kit. Kits can carry a higher margin than yardage because of the convenience and curated value; one source puts an expected +15% margin impact from premium pricing and bundling, which is thinly supported: https://businessplan-templates.com/blogs/profits/quilt-shop . Fabric margins: https://www.rbdblog.com/2025/02/11/the-numbers-behind-a-successful-quilt-shop-setting-yourself-up-for-success/ . Quilt-trade advice to bundle slow fabric with fresh arrivals is in the same Riley Blake post.

Using a kit to clear slow fabric: the slow fabric goes into the kit at its current (marked-down) cost basis only for margin display; for the true comparison use the section 3 test, with the kit's per-yard share of price.

**Kit stock and sell-through.** Treat a kit as its own item with a recipe (components and yards). Two ways to run it:
1. Pre-assembled stock: assembling consumes components (an ADJUSTED or a new ASSEMBLED move) and creates kit units; kit sell-through = kits sold / kits assembled.
2. Made to order: the kit is a sales line that expands into component SOLD moves at the time of sale; there is no kit stock, so "kit sell-through" becomes the rate of kit sales per week, and the check is "can I make N more kits from the stock now": `makeable = min over components of floor(q_i / yards_i)`.

```
kit_sellthrough = kits_sold / kits_assembled
component_wos   = q_i / ((velocity_i) + kit_rate * yards_i)          # include planned kit demand
```

Track which collections feed kits so the "reorder while in print" rule (section 5) counts kit demand. There are no published sell-through benchmarks for kits; use the shop's own fabric thresholds (section 1) and review a kit when its sell-through is under 40% after 90 days.

## Data requirements and gaps

Needs only current data: sell-through, WOS, velocity, aging (FIFO), holding cost, bolt-end yield, ABC and GMROI by item/brand/supplier, reorder suggestion (with supplier lead time as a setting).

Needs a small addition: bolt size per item (yards), `inPrint` state, collection/designer/color fields, supplier lead time, open purchase orders, cost at time of sale (to compute margin when cost changes), and a "kit recipe".

Watch the data pitfalls: ADJUSTED moves are not sales; use them for shrink only. A cut that changes a bolt is a SOLD move, not an adjustment. Exclude stockout days from velocity. A return reduces sold yards.

## Proposed defaults for StitchShop

| Setting | Default | Basis |
|---|---|---|
| Velocity window | 12 weeks in-stock rate; EWMA alpha 0.2 | our default, smoothing per Croston literature |
| Lumpy items (over 50% zero weeks) | Croston-SBA, alpha 0.2, factor (1 - a/2) | published method |
| New item "early" until | 21 days; blend to own rate by 42 days | our default; analogous forecasting published |
| Weeks of supply, staples | healthy 8 to 16, review above 26 | turns 4 to 6 (published, supplier blog) |
| Weeks of supply, collections | healthy 6 to 20, act above 34 | our default |
| Lot sell-through at 90 days | good 60% or more, bad under 40% | general retail 40/65/80, adapted |
| Aging watch / markdown 1 / clearance | 90 / 120 / 180 days | 60 to 90 flag, 90 to 120 clearance (published, general), 3 to 6 months (quilt) |
| Markdown steps | 20%, then 35%, then 50%, floor cost x 1.05 | our default; 20% example published |
| Bolt end | q at or under 1.0 yd and no more coming; 20 to 30% off or fat quarters | published (weak) and our default |
| Fat quarter yield | floor(yards x 4); price per yard / 4 x 1.15 | geometry published, premium ours |
| Convert to FQ or kit instead of markdown | when margin per yard (after cut cost) beats the next markdown step | our method |
| Carrying cost | 25% of cost per year | published 20 to 30% |
| Safety stock | z 1.28 for collections, 1.65 for staples | published formula, z ours |
| Reorder rounding | nearest half bolt, minimum 0.5, in print only | our design |
| Best-seller alert | 60% sold in 28 days, or 2x brand median velocity, and WOS under lead + 2 weeks | our default |
| Open-to-buy | planned sales + markdowns + EOM stock - BOM stock; EOM at target WOS 14 weeks | published formula |
| Planned markdowns | 5 to 8% of sales | our default |
| GMROI | good 3.0 or more, review under 1.5; compute per brand/supplier | published goal 3.0 |
| ABC cuts | 80 / 95 on 12-month margin dollars; unrated under 42 days | published |
| Kit price | max(cost / 0.5, component retail less 0 to 10%) | published margin target, bundle rule ours |
| Shop turns | 4 to 6 good, under 3 warn | published (supplier blog) |
