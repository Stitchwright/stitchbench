# A manual repository on StitchHub: design (3 Oct 2026, first draft for the owner and a lawyer)

HANDOFF.md section 3 item 18 (owner decision of 3 Oct 2026: the hub hosts manuals, including manuals repair techs
upload; the owner handles takedown notices himself), built on item 9 (sharing is chosen per item, worded "offer") and
item 12 (the download queue of 2 Oct). Nothing here is built. Where this says "decided", the owner may still say
otherwise; section 9 lists his questions with a recommended answer, section 10 the lawyer's. **Every legal point is
for a lawyer to check: this is a plan, not legal advice.**

Files relied on: `schema.prisma`, `manual-downloads.ts`, `safe-fetch.ts`, `library-dir.ts`, `local-manuals.ts`,
`hub.ts`, `hub-writes.ts`, `offer.ts`, `move/format.ts`, `manual-links.tsx`, `desktop/main.mjs`; C:\Manuals\CLAUDE.md
and `index.csv`; hub `README.md`, `server.mjs`, `checker.mjs`, `accounts.mjs`, `transfer.mjs`, migrations 001, 012,
016; `docs/legal/*-DRAFT.md`.

## 0. Decisions in one page

- **Storage**: Cloudflare R2, private, no download fees; bytes go between the program and R2 on presigned URLs, never
  through the hub's Railway service.
- **A file enters only when a tech chooses it** ("Offer this manual to the repository", one file, with its metadata
  and the tech's statement), from a company claimed by a verified StitchHub account, so strikes land on an account.
- **The owner reviews every upload** against a short published checklist (4.1) before any shop can download it.
- **Dedupe by sha256**; a removed file's hash is blocked; a work a notice named is flagged in any later copy.
- **Takedowns**: `/copyright` names the agent and takes notices, plus an email address; removal within a business
  day; counter-notices; restore 10 to 14 business days later; three strikes in 12 months end an account's uploading.
- **The operator uploads nothing of his own**: no bulk upload of his library; a seed of maker-published manuals only
  after the lawyer agrees.
- **Shops get files through the 2 Oct queue** (ManualLink rows with origin "repository", sha256 checked, filed with
  the library's naming); coverage pills count them. Free to hub members, members only, never a paid module.
- **Uploads stay off (`REPO_UPLOADS`)** until the agent is registered and named and a lawyer has reviewed the process.

## 1. The legal frame, in plain terms [LAWYER: all of this section]

**What the safe harbor gives.** Under 17 U.S.C. 512(c), a service that stores material "at the direction of a user"
is not liable for money damages because that material infringes, if it meets every condition below. It shields the
operator only while every condition holds. It does not make an upload lawful and does not protect the uploader.

**The conditions, and how the design meets each:**
1. **A designated agent** (512(c)(2)), registered in the Copyright Office's online DMCA Designated Agent Directory
   ($6 when last checked; lapses after three years unless renewed) and named, with address, phone and email, on the
   service. Design: `/copyright` and the hub's footer; no uploads while the agent details are unset.
2. **No knowledge** (512(c)(1)(A)): no actual knowledge that a particular file infringes, no awareness of facts that
   make it apparent (a "red flag"), and expeditious removal on learning. General awareness that some uploads infringe
   has been held not enough (Viacom v. YouTube, 2d Cir. 2012); there is no duty to monitor (512(m)). Design: the
   checklist doesn't judge rights; a work named in a notice is flagged in later copies; files marked confidential
   are refused (L1).
3. **No direct financial benefit where the operator can control the activity** (512(c)(1)(B)); courts have asked for
   "something more" than the power to remove (Viacom; UMG v. Shelter Capital, 9th Cir. 2013). Design: free, members
   only, no ads, not a paid module, not in sales copy (L3).
4. **Expeditious removal on a notice** (512(c)(1)(C)) with the six elements of 512(c)(3)(A): signature; the work;
   the material and where it is; contact details; a good-faith statement; accuracy and authority under penalty of
   perjury. Design: the form asks for each; emailed notices are logged alike; removal within one business day.
5. **Counter-notices** (512(g)): tell the uploader promptly; on a counter-notice with the 512(g)(3) elements
   (signature; the file and where it was; a good-faith belief, under penalty of perjury, that it was removed by
   mistake or misidentification; name, address, phone; consent to a federal court's jurisdiction; accepting service),
   send the complainant a copy and restore the file 10 to 14 business days after receipt unless the complainant says
   it has sued. This also shields the operator from the uploader's claims over the removal (512(g)(1)).
6. **A repeat-infringer policy** (512(i)(1)(A)), adopted, told to users and reasonably implemented: one on paper
   only has cost a service the harbor (BMG v. Cox, 4th Cir. 2018). Design: strikes applied by the hub (4.2).
7. **Standard technical measures** (512(i)(1)(B)) not interfered with (none known for PDFs). Knowingly false notices
   and counter-notices make the sender liable (512(f)); both forms say so.

**Two places the design stays inside the frame on purpose.**
- **The harbor covers what users upload, not what the operator uploads.** Files the owner uploads, copies in or
  seeds are his own acts. So: no seed until L2 is answered, then only manuals makers publish for free download, as
  "maker mirror" rows with the verified source URL, removed at once if a maker objects. The owner's library
  (C:\Manuals: 12,482 PDFs; its own rule: "OEM manuals are copyrighted: fine to keep for repair reference, do not
  repackage or sell") is never bulk-uploaded, and the hub refuses user uploads from `REPO_OPERATOR_ACCOUNTS`.
- **Don't invite infringement.** Encouraging users to upload particular copyrighted works has cost a service the
  harbor (Columbia Pictures v. Fung, 9th Cir. 2013). The model page keeps "add a link" and "offer a file you may
  share"; no "wanted" lists of OEM manuals, no Discord posts about repository files, no sales copy about them.

**Outside the frame.** The harbor is about copyright (a trade-secret or dealer-agreement claim over a dealer-only
manual is other law, L9) and it is US law (members and complainants elsewhere, L6).

**Background only: right to repair.** The section 1201 repair exemptions (renewed every three years, most recently
2024) allow getting around digital locks to repair devices, not distributing manuals. State laws since 2022 (New York,
Minnesota, California, Colorado, Oregon and others) make makers of covered products offer manuals to owners and
independent shops; they license nobody to redistribute them (L9). Their effect: more makers publish manuals freely, so
more can be a link or a maker mirror. Fair use for whole manuals is untested; nothing here relies on it.

## 2. Storage

**Cloudflare R2**, one private bucket (`stitchhub-manuals`): no egress fees (shops downloading is the main traffic),
the S3 API, presigned URLs, lifecycle rules by prefix, CORS. Considered: Backblaze B2 (free egress up to three times
what is stored), Amazon S3 (about 9 cents a GB out), a Railway volume (every byte through the hub). **No SDK**:
endpoint `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`, region `auto`; `src/r2.mjs` signs AWS Signature
V4 with `node:crypto` (about 120 lines: presigned GET and PUT; signed HEAD, ranged GET, CopyObject, DeleteObject);
`aws4fetch` (MIT, no dependencies) is the fallback. Tested with the presigned-URL example in AWS's documentation (its
published signature) and against a mock.

| Prefix | What | Lifecycle |
|---|---|---|
| `incoming/<uploadId>.pdf` | where the program PUTs | deleted after 1 day (abandoned slots) |
| `files/<sha256>.pdf` | verified: waiting for review or published (the database says which) | kept |
| `held/<sha256>.pdf` | removed after a notice, kept for a counter-notice | deleted after 120 days |
| `retired/<sha256>.pdf` | replaced by a better scan | deleted after 30 days |

Rejected files are deleted at once. Objects carry `Content-Type: application/pdf` and `Content-Disposition:
attachment; filename="<library name>"`, set when the hub copies them out of `incoming/`. **Presigned URLs**: PUT for
15 minutes, one key, `Content-Type: application/pdf`; GET for 5 minutes, with the content-type and disposition
overrides. Never logged. No public access (r2.dev off, no custom domain): files are served only from R2's own host,
never from the hub's or a hosted service's origin.

**Sizes**, from the owner's library (`index.csv`, 12,482 PDFs, 43.5 GB): mean 3.6 MB, median 1.7 MB, 95th percentile
14 MB, 99th 31 MB, largest 146 MB (two over 100 MB). 2,238 files (18%) are byte-for-byte copies of another: what
sha256 dedupe saves. **Decided: 150 MB per file** (`REPO_MAX_MB`).

**Cost** (R2 Standard as listed mid-2026, check before relying: $0.015 per GB-month after 10 GB free; writes $4.50 and
reads $0.36 per million after 1 million and 10 million free a month; no egress fees):

| Files | at the library's mean (3.6 MB) | if uploads skew to big scans (8 MB) |
|---|---|---|
| 10,000 | 36 GB: about $0.40 a month | 80 GB: about $1.05 a month |
| 50,000 | 180 GB: about $2.55 a month | 400 GB: about $5.85 a month |

Operations stay in the free tier (an upload is about three writes and two reads; a hundred shops each downloading
50,000 files is five million reads and about 18 TB, which would cost about $1,600 in S3 egress and nothing on R2). The
hub's one verifying read per upload is inbound to Railway. **Under $10 a month at 50,000 files.** R2 holds the only
copy of the bytes (no second copy at launch); the hub's export carries the tables, not the bytes; a moved hub keeps
the bucket.

## 3. Offering a manual from the program

**Where**: "Offer this manual to the repository" on one library file (My manuals, the model page) or `_inbox` file.
One file per offer, each with its own statement; nothing automatic (item 9; AGENTS.md). **Who**: OWNER and ADMIN
users; TECH users only when the owner turns on "Techs may offer manuals" (Settings → Community hub, off by default),
since strikes land on the owner's account. `requireHubWrites` applies; a read-only (lapsed) company can't offer.

**The dialog**: category, brand, models, doc type from the library's vocabulary (ServiceManual, TechnicalManual,
MaintenanceManual, PartsList, OperatorManual, ErrorCodes, WiringDiagram, Schematic, Firmware, Training, Bulletin),
year (optional), language (default English), title (optional); pre-filled from the LibraryDoc row or a
`Brand_Model_DocType_Year.pdf` name, blank for an `_inbox` file. The statement, ticked for each file:
> I may share this file with every shop on StitchHub: its maker publishes it for anyone to download, or my shop made
> it, or its copyright owner allows sharing. If its owner sends a valid copyright notice, StitchHub removes it and
> this account gets a strike; three strikes in a year end this account's uploading. [LAWYER: wording, L5]

Also shown: "The hub's owner reviews it before other shops can download it. Other shops don't see who offered it."
The statement's version (`REPO_STATEMENT_VERSION`) and time are stored. **Checks, then the upload** (Windows: the
server reads the file through `resolveInLibrary`, which already refuses `_business-notes` and `_own-notes`; hosted:
5.4):
1. A PDF by its first bytes (`%PDF-`), not encrypted, at most 150 MB, and the structural check of 6.4 (a quick
   answer; the hub repeats every check).
2. sha256, computed streaming. `POST /v1/repository/uploads` answers **duplicate** (already there or waiting: nothing
   sent; the LibraryDoc gets the repository id and hash so the queue never downloads it back), **blocked** (removed
   after a notice: "can't be offered again"), **refused** (no verified account, uploads off, a refused brand, a
   limit), or **a slot** with a PUT URL.
3. The PUT runs in the background (a `ManualOffer` row, SENDING; retried with a new slot after a restart), only to an
   https host ending in `.r2.cloudflarestorage.com` (or `FETCH_ALLOW_HOSTS` in tests), resolved through the
   safe-fetch lookup, so a hub can't aim a shop's file at the shop's own network.
4. `POST /v1/repository/uploads/:id/sent`: the hub checks size, sha256 and structure from the stored object; the
   offer waits for review.

**Limits on the hub**: 25 offers a day per company, 100 and 2 GB a day per account, 50 waiting per account (counted
from `uploads`, so a restart doesn't reset them). **Recorded** with each upload: the account, the hub shop (install +
shopRef from X-Shop-Ref), the person's name, the metadata as offered, the original file name, the statement version
and time; no IP address. **The tech sees** the company's offers and their state (sending, waiting, published, not
accepted and why, already there, removed after a notice with the counter-notice link), refreshed at each sync.

## 4. Review and moderation

### 4.1 The review queue
The admin page's **Repository** section lists each waiting file: metadata as offered, the automatic checks, a preview
(a 5-minute inline URL in the browser's own PDF viewer), other files for the same brand, model and doc type, and any
notice that named this work. **Approve** (with corrected metadata), **Reject** (a reason the uploader sees; optionally
block the hash), **Merge** (the same manual as a published file: keep the better, retire the other).

**Decided: always review**, at least until L1 is answered and volume calls for more. The checklist, published on
`/copyright`, screens; it doesn't clear rights:
(1) a manual, readable and whole; (2) brand, models, doc type and year right (corrected if not; the file name is
composed from them); (3) nothing private in it (customer details, a shop's own notes or prices); (4) the automatic
checks passed (6.4); (5) not a duplicate of a better file; (6) not a work an earlier notice named (flagged); (7) not
marked confidential, dealer-only or not for distribution [LAWYER: keep item 7 as the red-flag safeguard?].

Beyond 6 and 7 the reviewer does not ask whether the uploader holds the rights (512(m)). Review is the last defence
against a malicious PDF every shop's "Download everything" would fetch, and against mislabelled or private files.
Screening every upload for illegal content did not cost Motherless the harbor (Ventura Content v. Motherless, 9th Cir.
2018); moderators choosing posts on their substance raised the question for LiveJournal (Mavrix v. LiveJournal, 9th
Cir. 2017). If L1 favours it, later: auto-publish for trusted uploaders (20 approved, no strikes).

### 4.2 Takedowns, counter-notices, strikes
**Two ways in**: the `/copyright` form (public, no account; a field per 512(c)(3) element; 5 an hour per address, a
honeypot field, 16 KB) and the copyright email address (the owner pastes an emailed or posted notice into "Log a
notice"). Each new notice is emailed to the owner (`REPO_NOTICE_EMAIL`) and shows its age in business days.
**States**: new → incomplete (the owner asks for what's missing; one that substantially complies is acted on) →
actioned, or rejected (names nothing here; reason kept) → countered → restore due → restored, or lawsuit (the
complainant says it filed; the file stays down) → closed.

**Removal** (per file, or every file the notice names), within one business day of a complete notice: status held, so
no new download URLs (open ones expire within five minutes); the object to `held/`; the hash into `blocked_hashes`;
the feed tells every install it is gone (why: copyright); a strike for the account whose upload was published
(others who offered the same bytes are told, no strike); the uploader is emailed and the program shows the work, the
complainant's name or organisation (not its contact details) and how to counter-notify.

**Counter-notice**: from `/account/repository`, a field per 512(g)(3) element; before sending, the form says the
whole counter-notice, name, address and phone included, goes to the complainant. The hub emails the complainant a
copy and the 10-business-day statement and computes the window (weekends and US federal holidays skipped): earliest
day 10, latest day 14. The owner is reminded on day 10 and presses **Restore** unless the complainant has said it
filed: object back to `files/`, block lifted, strike withdrawn, back in the feed. **Decided: restored by the owner
with reminders**, not automatically. **The notice log** keeps every notice and counter-notice with its timeline
(never edited, notes appended), with a CSV export for the lawyer.

**Repeat-infringer policy** (on `/copyright` and in the terms): a strike per file removed on a notice, withdrawn if
the file is restored after a counter-notice. Three strikes within 12 months: the account can no longer offer
(`accounts.repo_uploads_off`), its waiting offers are rejected and its published files reviewed again; the owner can
end uploading at once in a flagrant case. A new account made to dodge this is refused by install
(`installs.repo_uploads_off`). [LAWYER: is ending uploading enough, or must the hub account end? L4]

**A maker asking for all its manuals to go** names no particular work, but the owner may honour it: "Remove every
<brand> file" and "Refuse offers for <brand>" (a list on the admin page). **Figures** (item 17): the same form takes
notices about figure pictures; removal uses the existing admin delete (L11).

## 5. Downloading into shops' libraries

**5.1 Its own feed.** `GET /v1/repository/changes?since=N` (the same `change_seq`, its own cursor
`HubState.repoCursor`), so old programs are untouched and an updated program reads the repository from 0 without
re-reading every link. Each item: id, category, brand, models, modelKeys, docType, year, language, title, fileName
(composed `Brand_Model_DocType_Year.pdf`), sizeBytes, pages, sha256, sha1, sourceUrl (maker mirrors); or `{ id,
removed: true, why: "copyright" | "replaced" | "withdrawn" }`. A 404 from an older hub means "no repository".

**5.2 ManualLink rows** with `origin = "repository"` (id `repo_<file id>`; url `stitchhub:repository/<id>`, never
opened as a web link; status always "ok"). A removal deletes the row; for copyright it also marks the LibraryDoc that
came from it (`withdrawnAt`): the model page says "removed from the repository after a copyright notice" and offers
**Delete my copy**. The program never deletes a shop's file on its own (L7).

**5.3 The queue** (`manual-downloads.ts`) changes in one place: for a repository row, `downloadLink` asks the hub for a
URL (`POST /v1/repository/files/:id/url`), fetches it with `fetchPublic` (R2's host is public, so the SSRF guard passes
unchanged), checks `%PDF-` and the sha256 against the feed's (a mismatch saves nothing), and files it with
`fileDownload` (the sidecar adds sha256 and origin). The hub requires category, brand, models and doc type, so
`canFile` holds and nothing lands in `_inbox`. A 1-second pause between repository files; a 429 puts the row back for
the next hour; `reportLink` and the checker don't apply.
- **Dedupe by hash**: LibraryDoc gains sha256 (downloads, offers) and sha1 (already in the Python index;
  `build_library_docs.py` carries it); `alreadyHave` matches either, so a file held under another name isn't fetched.
- **Volume guard**: the "Download everything" confirm states the total ("1,240 files, about 4.4 GB"); queueing and
  each file check free disk space (`fs.statfs`) and stop with a message below 5 GB free.
- **Coverage** (item 12c) gains the state "repo" ("in the repository, not downloaded"), counted as available;
  "missing" reads "Nobody has shared a link or a file for this yet."

**5.4 Hosted** (no LIBRARY_DIR). Download: the server action gets the URL; the browser fetches it (bucket CORS allows
GET from the hosted origins) and saves it with `saveToLibrary` into the tech's folder, else as a plain download.
Offer: the browser reads the file (`getLocalFile`), checks and hashes it (`crypto.subtle`); the server action gets the
slot; the browser PUTs to R2 (CORS PUT for the hosted origins); the server action says sent. The install key never
reaches the browser. **Download limits**: 300 URLs an hour and 3,000 a day per install; counted per file per day for
the admin page; no per-shop download log.

## 6. Data, API, security, privacy, legal text

**6.1 Hub tables** (migrations 017 and 018, or the next free numbers; the assistant package adds one too):
- `manuals`: id, category, brand, models, model_keys, doc_type, year, language, title, file_id (current), origin
  (user | maker-mirror), source_url, status (published | removed), timestamps, seq.
- `manual_files`: id, sha256 unique, sha1, size_bytes, pages, object_key, status (pending | published | held |
  retired | rejected), manual_id, checks jsonb, timestamps.
- `uploads`: id, file_id, account_id, shop_id, install_id, shop_ref, by_name, offered jsonb, original_name,
  statement_version, statement_at, state (slot | sent | duplicate | refused | pending | approved | rejected |
  removed), reason, timestamps. `blocked_hashes`: sha256, why, notice_id, file_id, created_at, lifted_at.
- 018: `takedown_notices` (kind notice | counter, parent_id, via form | email | post, complainant jsonb, work,
  locations, file_ids, the sworn statements, signature, raw text, status, the dates of 4.2, notes appended only) and
  `strikes` (account, install, shop, notice, file, created_at, withdrawn_at).
- `repo_downloads` (file_id, day, n); `accounts.repo_uploads_off`, `installs.repo_uploads_off`; settings rows for the
  refused brands and the agent's details. `transfer.mjs` exports and imports all of them.

**6.2 The program** (one migration): ManualLink gains `origin` (default "link"), `sizeBytes`, `sha256`, `sha1`, `year`,
`language`, `pages`; LibraryDoc gains `sha256`, `sha1`, `withdrawnAt`, `withdrawnWhy`; HubState gains `repoCursor`;
Shop gains `techsOfferManuals` (default false); new `ManualOffer` (shopId, userId, path, sha256, sizeBytes, the
offered fields, statementVersion, hubUploadId, state, reason, timestamps), listed in `src/lib/move/format.ts` for the
company move. Code: `src/lib/manual-repository.ts`, `src/actions/manual-repository.ts` (`safe()`, `requireUser`,
shopId on every query), the branch in `manual-downloads.ts`, `manual-links.tsx`, the dialog.

**6.3 API.** Member routes (install key; X-Shop-Ref names the company; partner and pending scopes refused):

| Route | Answer |
|---|---|
| `POST /v1/repository/uploads` | `{ duplicate, id }`, `{ blocked }`, or `{ uploadId, putUrl, expiresAt }` |
| `POST /v1/repository/uploads/:id/sent` | `{ state }` once the hub has verified the object |
| `GET /v1/repository/uploads?shopRef=` | this company's offers and their states |
| `GET /v1/repository/changes?since=N&limit=` | `{ manuals, next }` |
| `POST /v1/repository/files/:id/url` | `{ url, expiresAt, sha256, sizeBytes }`, published files only |

Public: `/copyright` and its form. Account (session): `/account/repository` and its counter-notice. Admin
(ADMIN_TOKEN) under `/v1/admin/`: the repository queue and file actions (preview, approve, reject, merge, remove,
restore, edit), notices (log, action, forward, restore, close, note), strikes, blocked hashes, settings. The code
lives in `src/repository.mjs` and `src/takedown.mjs`, each registered from `server.mjs` with one line (as
`registerMoves`); `maxBody`'s 64 KB default holds, since no file passes through the hub.

**6.4 Security.**
- **PDFs only**, checked by the program and again by the hub: the first bytes; not encrypted; refused if it contains
  `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia` or `/XFA`, searched in the raw bytes and in Flate
  streams inflated with `node:zlib` up to 64 MB a file (object streams hide names otherwise). A file the check can't
  read is flagged for review, not refused. The refusal suggests saving it again with Microsoft Print to PDF; nothing
  ever suggests removing a protection (L10).
- **Virus scanning: not at launch.** The structural check, the review, R2's separate origin and Windows Defender
  scanning each file the program writes cover the realistic risk (a PDF exploit). Revisit, as ClamAV in its own
  Railway service (1 to 2 GB of memory), if uploads pass about 50 a day or one bad file gets through.
- **Headers**: `Content-Type: application/pdf` and `Content-Disposition: attachment` stored and forced again on every
  download URL; served only from R2's host. **URLs**: short-lived, one key each, never logged; the program checks the
  host before every PUT and GET. **Keys**: R2 credentials only in the hub's Railway variables (`R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`), the token scoped to the one bucket.

**6.5 Privacy (the uploader's identity).** Stored: account, shop, install, the person's name, the statement and time;
no IP address. Shown to the owner only, never to other shops. Disclosed to a complainant only inside a counter-notice
the uploader chooses to send (the form says so), or under a subpoena (512(h)) or court order. A complainant's contact
details stay in the notice log; the uploader sees its name or organisation. Kept: uploads while the file is in the
repository plus [3] years; notices, counter-notices and strikes [3] years after closing [LAWYER, L8].

**6.6 What the drafts in `docs/legal/` must add.**
- Terms 10: "holds manual links (never the manuals themselves)" and "don't share manuals or large parts of them" give
  way to the repository: what may be offered, the statement, the uploader's licence (store, copy and distribute to hub
  members while the file is there), the uploader's warranties, the review, no promise to keep any file. Its [LAWYER]
  note about a DMCA agent is answered by a **new section after 10, "Copyright and the manual repository"**: the agent,
  how to send a notice, counter-notices and the 10-to-14-day restore, the repeat-infringer policy, 512(f).
- Terms 9: no files you have no right to share or that carry scripts or malware. 16: ending uploading (or the
  account, per L4) for repeat infringers. 19: repository manuals may be incomplete, mislabelled or out of date. 22:
  what you offered to the repository. 1 and 26: the agent and the copyright address.
- Privacy 2 and 4: "Manuals stay on your PC in every case" gains "unless you offer one to the repository". 5.3:
  repository offers, what's stored, who sees it. 5.9 and 7: Cloudflare (R2) as a provider; complainants receive
  counter-notices; legal process. 8: retention rows for uploads, notices, counter-notices, strikes. Also the legal
  README's checklist; and, with package 2, the hub README ("The hub never stores manuals"), its home page, the
  header comment of `server.mjs` and HANDOFF section 5's "Manuals stay local".

## 7. Packages, in build order, with gates

Each in its own worktree and database. Hub packages: the hub's tests on a test database. Program packages: a check
(`npm run check <file>`, with a tenant section) and a Playwright spec on the local test hub (:3200) and app (:3300),
run one at a time. The hub ships first: its routes are new and old programs ignore them.

1. **`repo-storage`** (hub, 1 day). `src/r2.mjs`; `test/r2-mock.mjs` (an in-memory S3 subset checking signatures and
   expiry, as `stripe-mock.mjs` does for Stripe). Test `test/r2.mjs`: the AWS documentation's example yields its
   published signature; presigned PUT, HEAD, ranged GET, copy, delete against the mock; an expired or altered URL
   refused. Gate: `npm test`, `test/r2.mjs`, one 1 MB round trip against the real bucket.
2. **`repo-hub`** (hub, 3 days). Migration 017; `src/repository.mjs` (slots, the verifying read, duplicates, blocked
   hashes, limits, the account rule, operator accounts, `REPO_UPLOADS`), the feed, download URLs, the admin queue,
   `transfer.mjs`, README. Test `test/repository.mjs`: no or unverified account, partner scope → 403; slot → PUT →
   sent → pending; wrong hash, non-PDF, encrypted, JavaScript → refused, object deleted; same bytes → duplicate;
   blocked hash → refused; the 26th offer of a day → 429; approve → in the feed, named; reject → object gone;
   URLs only for published files; company B can't list A's offers; export and import. Gate: `npm test`, `test:db`.
3. **`repo-takedown`** (hub, 2.5 days). Migration 018; `src/takedown.mjs`; `/copyright`; the admin page's Notices,
   Strikes and Blocked sections; mails (`MAIL_DEV_LOG`); `/account/repository` and the counter-notice; business days;
   refused brands. Test `test/takedown.mjs`: an incomplete notice; a complete one → removed in the feed, object in
   `held/`, hash blocked, strike, uploader mailed; same bytes → refused; counter-notice → complainant mailed, window
   right across Thanksgiving (26 Nov 2026); restore → unblocked, strike withdrawn, republished; third strike →
   uploads off; the form's per-address limit. Gate: as package 2.
4. **`repo-program`** (this repo, 3 days). Migration, lib, actions, dialog, offers list, the feed in `syncHub`, the 5.3
   branch, hash dedupe, disk guard, coverage, withdrawn marking, the Settings switch, `format.ts`, sha1 in
   `build_library_docs.py`. Check `scripts/checks/manual-repository.check.ts`: offers refuse a non-PDF, a private
   folder, over 150 MB, encrypted; nothing reaches the hub without the offer action; duplicate and blocked answers in
   words; a feed item becomes a repository ManualLink; a wrong sha256 saves nothing, a good file lands at
   `Category\Brand\Brand_Model_DocType_Year.pdf`; coverage counts it; a removal marks the LibraryDoc; a TECH can't
   offer until the switch; tenant: B can't see or act on A's offers. Spec `tests/manual-repository.spec.ts` (test hub
   with `R2_*` at the mock, `FETCH_ALLOW_HOSTS`): offer an `_inbox` PDF, approve via the admin API, sync, "Download
   all", the file on disk and "in the library"; a notice via the admin API, sync, the row says removed. Gate: tsc,
   eslint, the check, `manual-downloads.check.ts`, the move checks, `hub.spec.ts`, smoke.
5. **`repo-hosted`** (this repo, 1.5 days). 5.4's browser paths; R2 CORS in INSTALL.md. Check
   `manual-repository-hosted.check.ts` (server actions, tenant); spec `tests/manual-repository-hosted.spec.ts` (the
   folder-input fallback via `setInputFiles`; offer, approve, download). Gate: as package 4.
6. **`repo-legal-text`** (docs, half a day; folded into `terms-launch` if still open): 6.6, `/copyright`, the statement.
7. **`repo-seed`** (hub, 1 day, only after L2): "Mirror from the maker" on the admin page (fetched with the checker's
   private-address guard, checked like an upload, stored with its source URL); a maker's objection removes all its
   mirrors. Test `test/seed.mjs` with a local file server.

**Effort: 11.5 days, 12.5 with the seed**, plus the ultra review before each deploy.

**Launch gate** (`REPO_UPLOADS=on`): packages 1 to 4 deployed; the agent registered and named on `/copyright`; the
copyright address working (a test notice arrives); the lawyer has reviewed sections 1 and 4, the statement and the
terms; the owner has run a takedown and a restore on the test hub. Until then the program says "The manual repository
opens soon" and offers nothing. **In the queue**: after the billing packages (accounts must be live; the terms pages
come with `terms-launch`); beside the assistant package only with different hub migration numbers.

## 8. What the owner must do

1. **Register the DMCA agent** in the Copyright Office's DMCA Designated Agent Directory: the provider's legal name and
   the names it goes by (StitchHub, StitchBench, StitchShop), the agent (he can be his own), a postal address, phone
   and email; pay the fee; a reminder to renew before three years. Enter the same details in the hub.
2. **Name the takedown address** (e.g. copyright@ his own domain), read every business day. Give the hub its own
   domain first (the hub README already advises it), so `/copyright` and the address never change.
3. **Cloudflare**: an account; an R2 bucket (private, r2.dev off); an API token with Object Read & Write on that bucket
   only; lifecycle rules (`incoming/` 1 day, `held/` 120 days, `retired/` 30 days); CORS for the two hosted origins
   (package 5); a billing notification. The `R2_*` variables on the hub's Railway service only; the secret in
   `Documents\StitchHub admin.txt`, never in chat or the repo.
4. **A lawyer's review** of sections 1 and 4, the statement, the terms and section 10, before uploads open.
5. **Decide who covers takedowns when he is away**: a notice can't wait two weeks.
6. **Never offer OEM files from his own shop or library**; his account goes in `REPO_OPERATOR_ACCOUNTS`.
7. After L2: the maker-published manuals to mirror, each with its verified URL (`C:\Manuals\*\SOURCES.md`).

## 9. Open questions for the owner, each with the recommended answer

1. **Review.** Recommended: always review. Alternative: trusted uploaders auto-publish after 20 approvals, no strikes.
2. **Who may offer.** Recommended: owners and admins; techs when the owner switches it on. Alternative: everyone.
3. **Size and limits.** Recommended: 150 MB a file (nothing in the library is bigger); 25 offers a day per company,
   100 and 2 GB a day per account, 50 waiting. Alternative: 300 MB, the download cap.
4. **Uploader shown to other shops.** Recommended: no. Alternative: the shop's name, as notes show it.
5. **Access.** Recommended: hub members only, free; no Discord posts about repository files. Alternative: public.
6. **Restore after a counter-notice.** Recommended: by the owner, with reminders. Alternative: automatic on day 12.
7. **A shop's copy after a takedown.** Recommended: marked, with Delete my copy. Alternative: deleted by the program.
8. **Virus scanning.** Recommended: the structural check now, ClamAV on the stated trigger. Alternative: ClamAV now.
9. **Seed.** Recommended: none until L2, then maker mirrors only. Alternative: no seed; links only for maker files.
10. **"Download everything".** Recommended: includes the repository, with the size total and the disk guard.
11. **Strikes and removed files.** Recommended: three strikes in 12 months; removed files held 120 days.
    Alternatives: two strikes; deleted at once (a restore then needs a new offer).

## 10. Questions for the lawyer (and what the design assumes meanwhile)

- **L1** Does reviewing every upload against the 4.1 checklist put "at the direction of a user" at risk, or give
  red-flag knowledge of each approved OEM manual (Mavrix; Motherless)? Keep item 7? Assumed: review, item 7 kept.
- **L2** May the operator mirror manuals makers publish for free download (implied licence, site terms)? Assumed: no.
- **L3** The hub is free, but the same business sells subscriptions to the programs: is keeping the repository free,
  unmarketed and outside the paid modules enough for 512(c)(1)(B)? Assumed: yes.
- **L4** Is ending an account's uploading (not its hub account or program licence) "termination" under 512(i)? Is
  three strikes in 12 months reasonable? Assumed: yes to both.
- **L5** The statement, the uploader's licence, warranties and indemnity. Does a statement many OEM uploads can't
  truthfully make expose the operator (willful blindness; inducement as in Fung)?
- **L6** The counter-notice window as computed; complainants and uploaders outside the US; Canadian members.
- **L7** Copies already in shops' libraries after a takedown: is marking them enough, or must the program delete them?
- **L8** Disclosing the uploader only through a counter-notice or legal process; showing the uploader the
  complainant's name; how long to keep uploads, notices, counter-notices and strikes (assumed 3 years).
- **L9** Claims outside copyright (trade secrets or dealer agreements for dealer-only manuals; maker logos); whether
  any state repair law reaches sewing or embroidery machines.
- **L10** Refusing encrypted PDFs, and advising "Print to PDF" for files with scripts: any section 1201 issue?
- **L11** Figures (item 17) are sent automatically, so may fall outside "at the direction of a user": is the same
  takedown process enough, or should figures become an offer?
- **L12** The agent's address (may it be a P.O. box?), and whether the open-source hub's README should tell other
  hub operators they need their own agent and process.
