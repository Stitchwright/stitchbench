# Shop order contract fixtures

One valid body per message type (`<type>.v1.valid.json`), the refused ones (`invalid.json`: name, type, sender, expected code, body) and a body
with a field outside the version (`unknown-fields.v1.json`). These are the files StitchHub tests against
(`test/fixtures/sync-orders/` in Stitchwright/stitchhub, `docs/hub-sync-design.md`); `tests/unit/shop-orders-contract.test.ts` reads them here.
Copy them over when the hub changes them; a change on one side fails the other's tests until both agree. (A shared `stitch-contracts`
repository does not exist yet.)
