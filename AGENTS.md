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
- After any `npm install` on Windows, check `package-lock.json` still has `node_modules/@emnapi/core` and
  `node_modules/@emnapi/runtime` (npm on Windows prunes these Linux-only optional packages; `npm ci` on GitHub and
  Railway then fails). Put them back as in commit f295adb if they're gone.
- Free program (owner, 15 Oct 2026): StitchBench and StitchShop cost nothing; YouTube and donations pay for them. While
  `PROGRAM_FREE` is on (the default; `src/lib/free-program.ts`) nothing lapses for want of a key, every add-on is on, and
  there is no Solo login limit. The key rules still exist and are tested: check scripts set `PROGRAM_FREE=off` (in
  `scripts/checks/lib.ts` and `tenant.ts`), and the end-to-end test server must be started with `PROGRAM_FREE=off`
  (`scripts/local-test/start_hubtest.bat` does). The hub (StitchHub, `src/free.mjs`) comps every shop the same way.
- Work in progress (review fixes, new features): read `docs/HANDOFF.md` before starting.
