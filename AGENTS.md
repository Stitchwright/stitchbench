<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# StitchBench notes for agents

- Multi-shop: every business query must filter by the signed-in user's `shopId` (`requireUser()` in `src/lib/session.ts`). Check ownership before touching any row by id.
- Server actions live in `src/actions/`, wrapped with `safe()` so `UserError` messages reach the UI; throw `UserError` for anything the user can fix.
- Money is integer cents. Tension values are grams-force.
- Manuals: the plan is a manual repository on StitchHub, filled by techs' uploads with notice-and-takedown. Build it
  only through `docs/plans/manual-repository-design.md`;
  until that design's packages land, manuals stay local. Never upload anything from a shop's library without that
  shop choosing the file (the sharing rule: chosen per item, never automatic).
- Tension specs come from the maintainer's manual library spreadsheet (Thread_Tension_Specs.xlsx); regenerate `prisma/seed-data/tension_specs.json` from that sheet, run `python scripts/library/fill_model_keys.py` (fills model keys for names without digits; lookups only match on keys), then `npm run db:seed`.
- Mirror the paper Machine Log's statuses and lists (`src/lib/constants.ts`).
- After any `npm install` on Windows, check `package-lock.json` still has `node_modules/@emnapi/core` and
  `node_modules/@emnapi/runtime` (npm on Windows prunes these Linux-only optional packages; `npm ci` on GitHub and
  Railway then fails). Put them back as in commit f295adb if they're gone.
