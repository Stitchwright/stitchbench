<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# StitchBench notes for agents

- Multi-shop: every business query must filter by the signed-in user's `shopId` (`requireUser()` in `src/lib/session.ts`). Check ownership before touching any row by id.
- Server actions live in `src/actions/`, wrapped with `safe()` so `UserError` messages reach the UI; throw `UserError` for anything the user can fix.
- Money is integer cents. Tension values are grams-force.
- Manuals: the owner decided on 3 Oct 2026 to host a manual repository on StitchHub, filled by techs' uploads with
  notice-and-takedown (HANDOFF section 3 item 18). Build it only through `docs/plans/manual-repository-design.md`;
  until that design's packages land, manuals stay local. Never upload anything from a shop's library without that
  shop choosing the file (the sharing rule: chosen per item, never automatic).
- Tension specs come from Bruce's manual library (C:\Manuals\_business-notes\Thread_Tension_Specs.xlsx); regenerate `prisma/seed-data/tension_specs.json` from that sheet, run `python scripts/library/fill_model_keys.py` (fills model keys for names without digits; lookups only match on keys), then `npm run db:seed`.
- Mirror the paper Machine Log's statuses and lists (`src/lib/constants.ts`).
- Work in progress (review fixes, new features): read `docs/HANDOFF.md` before starting.
