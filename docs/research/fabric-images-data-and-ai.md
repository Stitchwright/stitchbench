# Fabric pictures, product data and AI for StitchShop

Researched 3 Oct 2026 from public pages only. Nobody was contacted and nothing was signed up for. Where a page could not be read (Moda's downloads page returned 403), that is said. Terms I could not find are marked "not found", not guessed.

## 1. Existing image and data libraries

**EQ8 (Electric Quilt).** Ships with about 6,200 fabrics from Riley Blake, Robert Kaufman, Michael Miller, Moda, Hoffman, Island Batik, Northcott, RJR and others. More come as paid "EQ Stash Online" downloads, add-on fabric libraries, and a free "Fabric of the Month". Its own help tells users to download JPG swatches from manufacturer sites (Moda, Riley Blake) and import them. EQ licenses are single-user, 2 activations, non-transferable. The manufacturer deal terms are not public, and the format and use rights of the bundled libraries were not found. Not usable as a data source for a shop; it is closed software content.
- https://support.electricquilt.com/articles/eq8-fabric-library/
- https://support.electricquilt.com/articles/downloading-and-importing-a-manufacturers-fabrics/
- https://electricquilt.com/online-shop/category/digital-fabric-libraries/

**PreQuilt.** Has digitized the solid color cards of almost all big manufacturers (Kona, Bella, Art Gallery Pure Solids, Michael Miller Cotton Couture, Andover Century, Free Spirit Designer Essentials). For prints it has preloaded collections and tells users to download manufacturer swatches or import their own images. It says it works with online fabric shops for free and does not profit from the swatches. Its help does not state usage terms or manufacturer agreements. No public data export or API found.
- https://help.prequilt.com/prequilt-features/all-about-fabric
- https://help.prequilt.com/fabric-101/printed-fabric-swatches/find-printed-fabric-swatches

**Moda.** The retailer site my.modafabrics.com has a Downloads page listing every collection with designer, a swatch-page PDF, a zip of JPGs (each fabric scanned, plus precuts, quilts and collection shots), free patterns and in-store date. Moda says the JPGs are meant for blogs, websites and quilt design programs. I could not read the page directly (403), so the exact terms text is not confirmed.
- https://my.modafabrics.com/downloads?page=1 (from search snippet)
- https://my.modafabrics.com/2010/12/web-tips-jpg-images

**Riley Blake.** Storyboard pages offer a "Download Images" zip of 72 dpi collection images (with and without a ruler). Higher-resolution "approved images" need a request to a sales rep or customer care, who send a document with instructions. It encourages retailers to share images and tag the company.
- https://www.rileyblakedesigns.com/storyboards-2017
- https://www.rileyblakedesigns.com/wholesale-information

**Robert Kaufman (Kona).** 365 colors; a physical color card with real swatches, and a printed color chart panel. No downloadable swatch file for shops found. PreQuilt covers Kona digitally.
- https://www.robertkaufman.com/fabrics/kona_printed_color_chart/
- https://www.missouriquiltco.com/products/kona-cotton-365-colors-color-card

**Art Gallery.** Wholesale-only; the full wholesale portal needs an account. The public side offers inspiration booklets per collection. Image download terms: not found.
- https://liveartgalleryfabrics.com/most-asked-questions/

**Ruby Star Society.** Appears in Moda's downloads (Moda distributes it). Nothing separate found.

**Spoonflower.** A print-on-demand design marketplace, not a catalog of bolt fabric. Designers keep copyright; you may not upload designs you do not own or license. Third-party sites may use its API for publicly posted content. Not useful for a quilt shop's inventory.
- https://www.spoonflower.com/en/policies/terms
- https://support.spoonflower.com/hc/en-us/articles/204578884-What-Images-May-I-Print-with-Spoonflower

**Quilting Daily and fabric-finder sites.** Nothing found about a licensed fabric image or data library from either. Not researched in depth.

**Shared trade catalog.** No open, shared quilting SKU database found. What exists is commercial and locked into POS products:
- Like Sew: connects to vendor catalogs (Moda, Checker, E.E. Schenck, Notions Marketing) and imports data, images, descriptions and pricing. https://likesew.com/blog/quilt-store-pos
- MicroBiz: scan or type a UPC to import product data, plus one-click import from supplier electronic catalogs (variant, image, cost, MSRP, description). https://www.microbiz.com/sewing-fabric-store-pos-system/
- How a new entrant gets access to those distributor feeds: not found; it is a business deal.

Takeaway: the one public, free, per-collection source is the manufacturer's own retailer download page (Moda JPG zips, Riley Blake zips). Everything else is behind a retailer login or a vendor agreement.

## 2. Barcodes on bolts

- Bolt ends carry the width, content, price and usually manufacturer, designer, line name, item number, color and yardage. The Sew4Home article lists these and does not mention a barcode. https://sew4home.com/how-to-read-a-fabric-bolt/
- Item numbers are manufacturer-specific, for example RS5207-11 and 29217-11 (collection or pattern, then a color suffix). https://www.fatquartershop.com/quilting-fabric-by-the-bolt
- I found no source saying bolts routinely carry a UPC. My belief is that most quilting cotton does not, and shops print their own barcode labels for bolts (MicroBiz says it prints bolt labels). Treat this as unconfirmed; Bruce can check by looking at ten bolt ends.
- GTIN lookup: GS1 GEPIR only names the brand owner, not product data. Free databases (UPCitemdb, Open Food Facts) are unvalidated and cover food and general goods; nothing found covering fabric. https://product.okfn.org/gs1-data-resources/index.html
- Consequence: scan-to-lookup has little to look up for fabric. The useful key is the manufacturer item number, read from the label and matched against a manufacturer feed.

## 3. Photos the shop takes itself

- Window light, not direct midday sun; a sheer curtain to soften it; the main phone camera; shoot flat from above; a white bounce card opposite the light; check white balance; iron out wrinkles. https://sartorly.com/blog/how-to-photograph-fabrics-that-sell and https://shotkit.com/flat-lay-clothing-photography/
- My suggestions for StitchShop (not from a source): put a ruler or coin in frame for scale, shoot one flat swatch plus one wide fold, include a neutral gray or white card so color can be corrected later, same spot and time of day every time, crop square, store a small JPG (about 1000 px) for speed.
- Quilt shops mostly show manufacturer collection images on their sites and add their own photos for bolts, bundles and kits. Riley Blake explicitly invites this.

## 4. AI and vision options

**Cost math.** Per Anthropic's vision doc, an image costs ceil(width/28) x ceil(height/28) tokens. Models below Claude 4.7 (including Haiku 4.5) cap at 1568 tokens and a 1568 px long edge. A 1000x1000 image is 1296 tokens, about $1.30 per 1,000 images at Haiku 4.5's $1 per million input tokens. Output (Haiku 4.5 is $5 per million) adds about $0.001 for a 200-token reply. So roughly $0.002 to $0.003 per image. Limits: 10 MB per image on the API, up to 100 images per request for 200k-context models, JPEG/PNG/GIF/WebP. Claude may err on very small (under 200 px), blurry or rotated images. Images are not stored or used for training. https://platform.claude.com/docs/en/build-with-claude/vision (confirm current prices at claude.com/pricing before building).

**(a) "Find fabric like this scrap".** Claude can describe color and pattern but is a poor way to rank hundreds of stock items (every candidate image goes in each request: 100 images is about $0.13, and results are approximate). Better to compute a vector once per stock photo and compare numerically.
- Cheap and local: color histogram or dominant colors (k-means in Lab space). No API cost, runs in Node with sharp. Good for "something blue".
- Better for pattern: CLIP-style embeddings (open model such as open_clip, or an ONNX build). Store one vector per image and search by cosine distance in Postgres with pgvector. Near-zero cost per query on a CPU, but an unusual dependency for the installed desktop app. I did not benchmark fabric accuracy; scrap photos in shop lighting will differ from catalog images, so expect a useful shortlist, not an exact match.
- Claude's role: a second pass, sending the scrap and the top 5 candidates (6 images, about $0.01) to pick or explain.

**(b) Bolt end label to fields.** Strong fit. Printed text, one image, structured output (SKU, name, manufacturer, designer, line, content, width, price). About $0.003 per label with Haiku 4.5 at a 1000 to 1500 px photo. Needs readable text; resizing can blur small print, so tell staff to photograph the label close and straight. Always show the result for the user to confirm before saving.

**(c) Auto-tagging.** Color family, theme (floral, batik, solid, holiday, novelty, geometric), print scale. One call returns a fixed tag list as JSON, about $0.003 per image, so 5,000 bolts is about $15 once. Colors can be done locally for free with dominant color; Claude is only needed for themes. Good enough for "what sells" reports, since tags need only be consistent. Let staff edit tags.

## 5. Copyright

- Printed fabric designs are copyrighted artwork (the specific print is protected, not the idea of "a floral"). https://www.lexology.com/library/detail.aspx?g=f40060c7-8e95-41fa-8672-3bea89ac9a9c and https://tarareed.com/fabric-copyright-guide/
- Reselling fabric you bought is allowed (first sale). The concern in these sources is making and selling derived products; they do not address photographing fabric for sale. Licensed characters (Disney, NFL) carry stricter selvage notices.
- Manufacturers publish images for retailers to use on websites: Moda says its JPGs are for blogs and websites, and Riley Blake invites sharing. That is the clean path. A shop photographing its own bolts to sell them is ordinary practice and low risk; I found no manufacturer saying otherwise.
- Not legal advice. Risk grows if StitchShop or StitchHub itself hosts and redistributes manufacturer images for many shops. That is a bigger step than each shop using its own files. Get permission, or store only links and let each shop fetch its own.
- Designer-owned art on marketplaces like Spoonflower is different: the designer owns it, so do not reuse it.

## What StitchShop could build (ranked by value and effort)

1. **Bolt label photo to item (value high, effort low to medium).** Phone photo of the bolt end; Claude Haiku 4.5 reads SKU, name, collection, designer, content, width; the form is pre-filled for confirmation. About $0.003 each. Directly cuts the typing. Add a second photo of the fabric itself on the same screen, which is the shop's own picture.
2. **Image import from manufacturer zips (value high, effort low).** The shop picks a Moda or Riley Blake collection zip it downloaded itself; match filenames or item numbers to items and attach pictures in bulk. We host nothing, so no redistribution issue, and it fits the "chosen per item, never automatic" sharing rule.
3. **Photo capture helper (value medium, effort low).** In-app guidance (window light, flat, ruler in frame), square crop, resize to about 1000 px, optional gray-card color correction. Makes every later feature work better.
4. **Auto-tags for reports (value medium, effort low to medium).** Local dominant color plus one Claude call for theme; feeds "what sells by color and theme". About $0.003 per item once. Opt-in and editable.
5. **CSV and vendor catalog import (value high, effort medium to high, needs vendor deals).** What Like Sew and MicroBiz sell. Not possible without agreements; a later business task more than an engineering one.
6. **Find like this scrap (value medium, effort high).** Dominant-color search first (cheap, "blue florals"); embeddings and pgvector later; expect a shortlist. Fun at the counter but not the biggest time saver.
7. **Barcode scan lookup (value low, effort low).** Fabric UPC coverage looks poor. Do scanning only for the shop's own printed bolt labels.
8. **Shared fabric catalog on StitchHub (value high long term, effort high, legal risk).** Shops contribute items and photos; others reuse them. Would need the same notice-and-takedown design as the manual repository and the same per-item sharing rule; manufacturer permission is the open question.

## Open questions for Bruce

- Do bolts in your shop carry manufacturer UPC barcodes? Check a handful from Moda, Riley Blake, Kaufman and Art Gallery.
- Can you read the terms on Moda's retailer Downloads page when logged in? I could not.
- Which vendors have shops asked to import from?
