<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# StitchBench notes for agents

- Multi-shop: every business query must filter by the signed-in user's `shopId` (`requireUser()` in `src/lib/session.ts`). Check ownership before touching any row by id.
- Server actions live in `src/actions/`, wrapped with `safe()` so `UserError` messages reach the UI; throw `UserError` for anything the user can fix.
- Money is integer cents. Tension values are grams-force.
- Manuals are local-only by design. Never add manual upload/storage to the server.
- Tension specs come from Bruce's manual library (C:\Manuals\_business-notes\Thread_Tension_Specs.xlsx); regenerate `prisma/seed-data/tension_specs.json` from that sheet, then `npm run db:seed`.
- Mirror the paper Machine Log's statuses and lists (`src/lib/constants.ts`).
- Work in progress (review fixes, new features): read `docs/HANDOFF.md` before starting.
