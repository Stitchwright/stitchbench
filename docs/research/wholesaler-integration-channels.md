# Wholesaler integration channels for StitchShop

Researched 3 Oct 2026 from public web pages and search summaries only (about 15 minutes). Nobody was contacted, nothing was signed up for. Builds on `fabric-wholesalers-and-patterns.md` (not repeated). "Not found" means the public search did not show it; it does not prove absence. Public EDI directories (SPS, TrueCommerce, DiCentral, Cleo, OpenText) are mostly behind a login or a search form, so I could not query them for each company; a listing there was not seen for any quilt maker.

## Table

| Wholesaler | EDI listed and documents | API / platform | File upload (quick order) | Catalog / price files | Best channel to start |
|---|---|---|---|---|---|
| Notions Marketing | Not on an official directory I could see. A third-party EDI vendor (eZCom) page lists 850, 810, 997 for it, and says EDI is offered to high-volume accounts | Virto Commerce B2B portal (June 2026), real-time ERP link, inRiver PIM; no public developer API stated. Has a private API arrangement with Rain (Order Assist, automated PO and receiving APIs) | Yes: CSV import, barcode scan, quick order by SKU, saved lists. Column format not published | Product data for 165,000+ items feeds Rain and Like Sew; no public file | Partner request for catalog feed and PO API; CSV import as the fallback |
| Checker Distributors | Not found | Not found publicly. Integrated by Like Sew and MicroBiz, so a private feed exists | Not found | Not found | Ask Checker for the feed MicroBiz and Like Sew use |
| Brewer | Not found | Not found; integrated by Like Sew and MicroBiz | Not found | Not found | Same request as Checker |
| United Notions / Moda | Not found | Own wholesale site (my.modafabrics.com); no API found. Like Sew imports Moda collections | Not found | Public downloads page: swatch PDFs, JPG zips per collection (images only, not price data) | Ask for the Like Sew style catalog feed; images from the downloads page with permission |
| Riley Blake | Not found | Own online wholesale ordering; no API found | Not found | Catalogs on Issuu; image repository on request | Written request for a data feed and images |
| Robert Kaufman | Not found | Customer login; no API found | Not found | Seasonal image folders on Dropbox (customers only) | Request data feed; images from Dropbox with permission |
| Andover | Not found | Registration page; no API found | Not found | Image zips per collection, no login | Request a feed |
| Jaftex group (FreeSpirit, Henry Glass, Studio E, Blank) | Not found | Online retailer account; no API found. Henry Glass is a Like Sew vendor partner | Not found | Not found | One conversation covers four lines; ask for the Like Sew feed |
| Northcott | Not found | No API found. Like Sew lists a Northcott catalog integration | Not found | Not found | Ask for the Like Sew style feed |
| Hoffman | Not found | Rep, phone or online after approval; none found | Not found | Not found | Phone or email request |
| Benartex | Not found | Retailer portal login; Like Sew vendor partner | Not found | Marketing assets behind login | Request a feed |
| Windham | Not found | Its site uses Shopify (the sign-in page is on a myshopify address); Shopify B2B has an API, but a retailer cannot use a brand's admin API without the brand granting access | Not found | Catalogs and lookbooks (PDF) | Request a feed; a Shopify based store might allow a customer-account export |
| Michael Miller | Not found | No API found. Like Sew lists a catalog integration | Not found | Not found | Ask for the Like Sew style feed |
| Art Gallery Fabrics | Not found | Registration then login; none found | Not found | Booklets per collection | Request a feed and image permission |
| Island Batik | Not found | Orders by phone, fax or email; no site API found. Like Sew vendor partner | Not found | Not found | Ask for the Like Sew feed |
| EE Schenck | Not found | Wholesale application then site account; none found. Like Sew and MicroBiz integrated | Not found | Not found | Same request as Checker |
| Faire | Not applicable (marketplace) | Retailer-side endpoints exist in the Faire External API v2 per a third-party profile, but sources say retailers cannot get tokens; retailer integrations go through POS partners (Shopify, Square, Clover, Lightspeed) | Not found | Product import into those POS systems | Not useful for core quilt fabric; see Faire section |

## 1. EDI

- No public EDI network directory entry was found for any of the listed quilt makers or distributors. The SPS directory and the others search by company and require their forms; search engines did not surface hits for Moda, Kaufman, Benartex or Riley Blake ([SPS find a partner](https://www.spscommerce.com/network/find-a-partner/), [likesew wholesaler list, no EDI mentioned](https://likesew.com/blog/wholesale-fabric-suppliers)).
- Only Notions Marketing has any EDI signal: eZCom, an EDI vendor, publishes a page for it listing 850 purchase order, 810 invoice and 997 acknowledgment ([eZCom](https://www.ezcomsoftware.com/retailer-edi/notions-marketing-edi/)). It is marketing from a third party, not Notions Marketing, and a search summary says EDI is offered to high-volume accounts ([PR Newswire](https://www.prnewswire.com/news-releases/notions-marketing-goes-live-on-virto-commerce-unlocking-247-self-service-for-thousands-of-retailers-302795307.html)). 855, 856, 832 and 846 for it: not found.
- Cost to join a network (published or third-party quoted, not confirmed on vendor pages): SPS Commerce lists entry tiers around $20, $99 and $349 per month, enterprise quoted, with per-partner setup fees often $900 to $1,500 ([Capterra](https://www.capterra.com/p/155593/SPS-Commerce/pricing/), [ERP Research](https://www.erpresearch.com/erp-add-ons/edi/sps-commerce)). TrueCommerce starts at about $20 a month, with real cost $500 to $3,000 a month once partners and volume count ([ERP Research](https://www.erpresearch.com/erp-add-ons/edi/truecommerce)). DiCentral (now TrueCommerce) from $30 a month ([SelectHub](https://www.selecthub.com/p/edi-software/dicentral/)). Cleo and OpenText: no published prices found ([OpenText](https://www.opentext.com/products/trading-grid)). These are review-site figures, not each vendor's price page; treat as rough.
- Note the direction: these networks are built for suppliers selling to big retailers. A POS vendor buying from wholesalers is the retailer side, which is not the usual model, and the wholesaler must agree to it.

## 2. APIs and platforms

- Notions Marketing: Virto Commerce portal with ERP connectivity, inRiver, Authorize.net, Klaviyo, UPS and Azure AD ([Virto Commerce](https://virtocommerce.com/blog/press-release-virto-commerce-notions-marketing)). No public developer docs found. It does run a private API with Rain: Order Assist, Automated Purchase Orders and Automated Receiving Orders APIs ([PRWeb 2018](https://www.prweb.com/releases/notions_marketing_integrates_with_rain_retail_software_making_their_165_000_items_available_in_the_rain_point_of_sale_system/prweb16046397.htm), [Rain](https://www.rainpos.com/notions-marketing-integration/)).
- Windham's wholesale login sits on Shopify ([Windham sign in](https://windhamfabrics.com/pages/sign-in)); the site is a storefront, and no public API for retailers was found.
- Moda: own site ([Moda wholesale info](https://my.modafabrics.com/about-us/wholesale-info)); minimum of $3,000 to open an account per search summary; no API found.
- NuORDER, Joor, RepSpark, Elastic Suite, Pepperi, BlueCart: no evidence found that any quilt maker or distributor on the list uses them.
- Everyone else on the list: no developer docs, API or partner program found.

## 3. File uploads and catalog files

- Notions Marketing is the only one with a confirmed quick order: "CSV import, barcode scanning, quick order by SKU, and saved purchasing lists" ([Virto Commerce](https://virtocommerce.com/blog/press-release-virto-commerce-notions-marketing)). The CSV column layout is not published.
- No CSV or Excel cart upload found for Checker, Brewer, EE Schenck, Moda, Riley Blake, Kaufman, Andover, Jaftex, Northcott, Hoffman, Benartex, Windham, Michael Miller, Art Gallery or Island Batik. Island Batik takes orders by phone, fax or email ([World Weidner summary of Island Batik](https://designers.islandbatik.com/about/)).
- Downloadable catalog or price files: no CSV or Excel feed found published anywhere. What exists are image zips and PDFs: Moda ([downloads](https://my.modafabrics.com/downloads)), Andover ([downloads](https://andoverfabrics.com/fabric-image-downloads/)), Kaufman (Dropbox), Windham (catalog PDFs).

## 4. Faire

- Faire has an External API v2 with brand-side endpoints (products, orders, inventory, shipments). A third-party profile says it also has retailer-side endpoints for browsing and ordering ([API Evangelist](https://github.com/api-evangelist/faire)), but the official docs I could read show only brand access tokens, obtained by emailing integrations.support@faire.com ([Sellercloud help](https://help.sellercloud.com/omnichannel-ecommerce/faire-account-integration/)). One summary states Faire gives retailers no API tokens, and retailer integrations go through Shopify, Square, Clover and Lightspeed Retail ([search summary of Faire support](https://www.faire.com/support/articles/360037248712)); the page itself returned 403 to me, so unverified.
- The retailer integrations import product details, photos and SKUs from orders into the POS and refresh every 30 minutes, with about 75,000 retailers using them ([Faire newsroom](https://www.faire.com/news/2026-03-31-faire-launches-lightspeed-integration), [Gifts and Decorative Accessories](https://www.giftsanddec.com/retail/faire-launches-lightspeed-integration-top-pos-providers/)). Ordering is still done on Faire. A path for a new POS to join that list: not found (ask Faire).
- Quilt fabric makers on Faire seen in search: Camelot (Emma and Mila fat quarters), Birch Fabrics, Mook Fabrics, Laundry Basket Quilts ([Faire quilting fabric](https://www.faire.com/discover/quilting-fabric), [quilting supplies](https://www.faire.com/discover/quilting-supplies)). None of the 17 listed wholesalers was seen on Faire.

## 5. How Like Sew, Rain and MicroBiz connect

- Like Sew: one-click import of whole collections from Moda, Checker, Brewer and Northcott, including descriptions and images ([Like Sew blog](https://likesew.com/blog/wholesale-fabric-suppliers), [integrations](https://likesew.com/integrations)). Technical method (file feed, API, EDI): not found.
- Rain: Notions Marketing product data for 165,000+ items, scan a barcode to fill a record, and Notions Marketing uses Rain's order and receiving APIs. So it is a vendor-built integration using the POS's own API, not EDI ([PRWeb](https://www.prweb.com/releases/notions_marketing_integrates_with_rain_retail_software_making_their_165_000_items_available_in_the_rain_point_of_sale_system/prweb16046397.htm)). Rain for Moda or Checker: not found.
- MicroBiz: one-click catalog add from Brewer, Checker, EE Schenck, Notions Marketing ([MicroBiz](https://www.microbiz.com/sewing-fabric-store-pos-system/)). Method not stated.
- Reading: the pattern is a catalog data file or database each distributor hands to a POS vendor under a private arrangement. No public standard channel.

## Sources

- https://www.ezcomsoftware.com/retailer-edi/notions-marketing-edi/
- https://virtocommerce.com/blog/press-release-virto-commerce-notions-marketing
- https://www.prnewswire.com/news-releases/notions-marketing-goes-live-on-virto-commerce-unlocking-247-self-service-for-thousands-of-retailers-302795307.html
- https://www.rainpos.com/notions-marketing-integration/
- https://www.prweb.com/releases/notions_marketing_integrates_with_rain_retail_software_making_their_165_000_items_available_in_the_rain_point_of_sale_system/prweb16046397.htm
- https://likesew.com/integrations and https://likesew.com/blog/wholesale-fabric-suppliers
- https://www.microbiz.com/sewing-fabric-store-pos-system/
- https://github.com/api-evangelist/faire, https://developers.faire.com/docs, https://help.sellercloud.com/omnichannel-ecommerce/faire-account-integration/
- https://www.faire.com/news/2026-03-31-faire-launches-lightspeed-integration, https://www.faire.com/support/articles/360037248712, https://www.faire.com/discover/quilting-fabric
- https://www.capterra.com/p/155593/SPS-Commerce/pricing/, https://www.erpresearch.com/erp-add-ons/edi/sps-commerce, https://www.erpresearch.com/erp-add-ons/edi/truecommerce, https://www.selecthub.com/p/edi-software/dicentral/
- https://www.spscommerce.com/network/find-a-partner/, https://www.opentext.com/products/trading-grid
- https://windhamfabrics.com/pages/sign-in, https://my.modafabrics.com/about-us/wholesale-info, https://my.modafabrics.com/downloads, https://andoverfabrics.com/fabric-image-downloads/

## Recommended connector plan

Principle: do not start with EDI. No quilt maker showed an EDI listing, and the cost and wholesaler cooperation needed are high. Start with channels shops already use.

1. **Notions Marketing**: ask for the same catalog feed and PO and receiving API that Rain uses; build a CSV export in their quick order format as the interim path (get the column layout from a shop's account, since it is not public). Highest return: one confirmed API partner, CSV, 600+ brands.
2. **Checker, Brewer, EE Schenck** (distributors): ask each for the catalog file Like Sew and MicroBiz receive. Catalog first; ordering by exported PO the shop sends or uploads.
3. **Moda / United Notions**: ask for the Like Sew style collection feed; until then, load images from the public downloads page after written permission. Orders stay on the Moda site.
4. **Jaftex group**: one request covers FreeSpirit, Henry Glass, Studio E and Blank; use Henry Glass's Like Sew listing as the opening.
5. **Riley Blake, Robert Kaufman, Andover, Benartex, Northcott, Michael Miller, Windham**: written request for data feed and image permission (draft 1 in the earlier file); meanwhile a shop-entered or spreadsheet import with the PO printed or emailed.
6. **Hoffman, Art Gallery, Island Batik**: phone and email ordering; manual entry plus emailed purchase orders from StitchShop.
7. **Faire**: low priority for quilt fabric (small makers only). Ask Faire whether a new POS can join the retailer integration list; otherwise offer import of Faire order files if the shop can export them.
8. **EDI last**: only if a wholesaler asks for it; budget roughly $20 to $349 a month plus per-partner setup, quoted by review sites, confirm with the vendor first.
