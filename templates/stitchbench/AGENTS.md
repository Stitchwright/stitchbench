<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# StitchBench notes for agents

- Multi-shop: every business query must filter by the signed-in user's `shopId` (`requireUser()` in `src/lib/session.ts`). Check ownership before touching any row by id.
- Server actions live in `src/actions/`, wrapped with `safe()` so `UserError` messages reach the UI; throw `UserError` for anything the user can fix.
- Money is integer cents. Tension values are grams-force.
- Manuals stay in each shop's own library. Never upload anything from a shop's library, or share anything with the
  hub, without that shop choosing the item (the sharing rule: chosen per item, never automatic).
- The manufacturers' reference data (tension specs, factory settings, the manual list) is not in this repository; see
  INSTALL.md. Code must keep working when those files are absent: a missing file skips its set and never deletes rows.
- Mirror the paper Machine Log's statuses and lists (`src/lib/constants.ts`).
- After any `npm install` on Windows, check `package-lock.json` still has the top-level `node_modules/@emnapi/core` and
  `node_modules/@emnapi/runtime` entries (optional, MIT; npm on Windows prunes these Linux-only optional packages, and
  `npm ci` on GitHub and Railway then fails). Put them back if they're gone.
