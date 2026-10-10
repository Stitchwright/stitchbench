# Ease of use: updates, What's new, Getting started, answers to Help (10 Oct 2026)

The owner asked for four things after the Help button (HANDOFF 2ao): ease of use is the point of all of them. The
staff are mostly older women who are not computer people: plain words, big targets (48px+), one main action per
screen, nothing that needs a manual.

## 1. A new version is ready (installed program only)

- The hub keeps the latest release per program: `GET /v1/releases/latest?flavor=stitchbench|stitchshop` (no key
  needed) answers `{ version, url, sha256, size, signature, notes: string[], publishedAt }` or 404 when there is none.
  `url` is either the installer's own https address or the hub's `/v1/releases/<id>/download`, which redirects to a
  short-lived R2 address when the hub stores the file itself (R2_* set).
- The app (Next server inside the installed program) asks the hub at most every 6 hours and compares with its own
  version. Owners and admins see a banner on every page: "A new version of StitchBench is ready." with one button,
  **Update now**, and a small **Later** (hides it for 3 days on that device). Hosted builds never show it (Railway
  deploys them). On a tablet or another computer the banner says to update on the shop's main computer instead.
- **Update now** is a program link (`/program/update`) that the program's window catches, like `/move-in?choose=1`.
  The program then asks the hub itself (never trusts the page), checks the version is newer, downloads the installer
  with a progress bar, checks its sha256 and size, checks the release signature (below), makes a backup, runs the
  installer silently (`/S --force-run`) and closes. The installer opens it again. Anything wrong: a plain message,
  "Nothing was changed."
- **Release signature**: Ed25519 over the text
  `stitch-release-v1\n<flavor>\n<version>\n<sha256 hex>\n<size in bytes>` (no trailing newline), base64. The public
  key is in `desktop/release-key.mjs`; the private key only in `Documents\StitchBench release key.txt` on the
  owner's PC. A hub admin token alone can't push a program to the shops.
- Owner's steps per release: build the installers (GitHub Actions), download them, then one command per program:
  `node scripts/release/publish-release.mjs --flavor stitchbench --version 1.7.1 --file "<the .exe>"` (uploads to the
  hub's storage, or `--url <https address>` if it's hosted elsewhere). The notes come from `src/lib/whats-new.ts`.

## 2. What's new

- `src/lib/whats-new.ts` exports
  `WHATS_NEW: { version: string; date: string; stitchbench: string[]; stitchshop: string[] }[]`, newest first: a few
  plain lines per version, "(you asked for this)" where an idea came from a shop.
- After an update, each person sees the lines for the versions since the one they last saw, once, in a friendly card
  with one button (**Got it**). Settings has a "What's new" page with every version. A brand-new person (first
  sign-in) doesn't get the card; they start at the current version.

## 3. Getting started

- On the home page, for owners and admins, a short list of ticks worked out from the shop's own data (first customer,
  first job/ticket, a tag or receipt printed, texting set up, backup checked ...), different per program. Each line is
  one big link to the page that does it. It goes away when everything is ticked, or with **Hide this list** (kept per
  shop).

## 4. Answers to Help

- On the hub's Help & ideas page the owner can **Write back** on an item: saved on the item, emailed to the reply
  address if the shop gave one, and the item is marked done.
- The program asks for answers at each sync: `GET /v1/feedback/replies?since=<iso>` (install key, `X-Shop-Ref`),
  answering `[{ id, kind, text, reply, repliedAt }]` (`text` is the first 200 characters of what they sent). The Help
  button shows a dot when there is an unread answer; the Help panel shows "We answered you" with the answer.
