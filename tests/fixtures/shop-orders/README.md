# Shop order contract fixtures

One valid body per message type (`<type>.v1.valid.json`), the refused ones (`invalid.json`: name, type, sender, expected code, body) and a body
with a field outside the version (`unknown-fields.v1.json`). These are the files StitchHub tests against
(`test/fixtures/sync-orders/` in Stitchwright/stitchhub, `docs/hub-sync-design.md`); `tests/unit/shop-orders-contract.test.ts` reads them here.
Copy them over when the hub changes them; a change on one side fails the other's tests until both agree. (A shared `stitch-contracts`
repository does not exist yet.)

Updated 2026-10-31 for MakerFoundry's two decisions (shipping by the piece and the pick-up address in the catalogue; sales tax collected by
MakerFoundry, outside the shop's share): `catalog.v1.valid.json`, `order.placed.v1.taxed.valid.json`, `order.status.v1.empty-tracking.valid.json`
and more entries in `invalid.json`. These are the bodies of MakerFoundry's `docs/contract/shop-orders/` fixtures (SiteSentrix/makerfoundry PR #45)
as StitchHub tests them. MakerFoundry's own files still carry the first draft's envelope, `art_urls` and `preview.url`; see the plan.
