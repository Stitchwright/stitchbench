# AI in StitchBench: scope and cost of the six candidates (2 Oct 2026, for the owner's decision)

HANDOFF 3.13 asks for the AI candidates to be scoped and costed first, then the one or two with the best return built.
This is that scoping. It ranks the owner's six candidates, designs the plumbing they all share once, and ends with
open questions and recommended answers. Nothing here is built. `assistant-design.md` (revision 1, 1 Oct) already
sketches the feature set in detail; this document is the step before it and changes three of its choices (section 7).

The owner's constraints, applied throughout: customer names and contact never leave the shop without an explicit
choice (the sharing rule, "offer", never automatic); the Windows program keeps working offline and AI features degrade
to "unavailable" cleanly; per-call cost belongs in a paid **Assistant** module, not the $25 base price; every call is
logged so a tech can check what was sent and what came back.

**Prices used.** Anthropic's pricing page, read 2 Oct 2026 (https://platform.claude.com/docs/en/about-claude/pricing),
per million tokens, input / output, with cache reads in brackets: `claude-haiku-4-5-20251001` $1 / $5 ($0.10);
`claude-sonnet-5-5` $2 / $10 ($0.20); `claude-opus-5-5` $4 / $20 ($0.20); `claude-fable-5-1` $10 / $50 ($0.25). A
5-minute cache write costs 1.25x input. Batch API halves both sides. A photo costs about width x height / 750 tokens
(the vision guide), so a 1280 x 960 plate photo is about 1,640 tokens. Models from 4.7 on use a tokenizer that makes
about 30% more tokens from the same text; the token counts below carry that margin. 1,000 tokens is roughly 700 words.

## 1. The six candidates

Each entry: what it does in the program's words; the exact data it needs and whether any of it identifies a customer;
how it degrades offline; the model; the cost per call with the arithmetic; the build in days (one package of the
current kind: lib + action + UI + check script + Playwright spec); and the return for a shop.

### 1.1 Write-ups ("Draft it")

- **What.** On a ticket, under "Work done" and "What we found": the tech's shorthand ("hook timing 2 mm late, bobbin
  case cracked, replaced, COA, test sewn") becomes 2-6 plain sentences in the shop's voice for the invoice, or an
  internal note. On a partner repair job: the note to the sewing shop's counter. On the estimate and ready notices:
  the body of the message, rendered through the existing templates (`src/lib/messaging/templates.ts`).
- **Data sent.** `Ticket.problem`, `diagnosis`, `workDone`, `notes` (the typed shorthand), `serviceRequested`, the
  `TicketLine` descriptions and amounts, `accessories`, `Machine.brand / model / machineType`, the kind's noun, the
  shop's name and its "how we write" sample. **Not sent:** `Customer.*`, the trade account's name, `Machine.serial`,
  payments, photos. Customer-identifying: none. Where the message needs a name, the draft carries `{first_name}` and
  `render()` fills it in locally, exactly as the notices do today.
- **Offline.** The button shows "Needs the internet" and the field works as before. Nothing else changes.
- **Model.** `claude-sonnet-5-5` (drafting in a voice; Haiku's prose is noticeably flatter for the same prompt).
- **Cost per call.** System prompt with the voice sample, cached: 900 tokens x $0.20 / 1M = 0.02 c. Ticket context
  and shorthand: 900 x $2 / 1M = 0.18 c. Output 250 x $10 / 1M = 0.25 c. **About 0.45 c** (0.6 c with no cache hit).
- **Build.** 1 day on top of the plumbing (section 2): four prompts, one draft box component, two ticket slots, the
  repair-job slot, the check script's fixtures.
- **Return.** Used on nearly every ticket. A tech types 3-5 minutes less per ticket and the invoice reads the same
  whoever wrote it; a 60-ticket month gives back 3-4 hours. The partner note stops being skipped because it was tedious.

### 1.2 Bench assistant ("What's likely wrong")

- **What.** A card on the ticket: up to five likely causes with the checks to make, each with where it came from (this
  shop's past tickets on that model, a `ModelNote` gotcha, a community `HubPost`, a `TensionSpec` or `FactorySetting`
  row), or marked "general knowledge". "Ask again with what I found" after the diagnosis is typed.
- **Data sent.** This ticket as in 1.1; the shop's last 20 closed tickets on the same `brand + modelKey` (number,
  dates, `problem`, `diagnosis`, `workDone`, PART and SERVICE line descriptions; no customer fields, no serials); the
  model's `ModelNote` rows; the `HubPost` rows for the `modelKey` (already community text); the matching `TensionSpec`
  (634 rows seeded) and `FactorySetting` rows. Each item carries a reference (`ticket:0123`, `gotcha:<id>`,
  `hubpost:<id>`, `spec:<id>`) the model must cite; unknown citations become "general knowledge". Customer-identifying:
  none after `redact()` (section 2.4) scrubs names, phone numbers and emails from free text.
- **Offline.** The card says "The Assistant needs the internet" with no spinner; past answers on the ticket still show
  from the log.
- **Model.** `claude-sonnet-5-5`. Opus 5.5 doubles the cost for a longer list, not a better one, on a 7,000-token
  context; keep it as the "think harder" option behind a setting, off by default.
- **Cost per call.** Input 7,000 x $2 / 1M = 1.4 c. Output 500 x $10 / 1M = 0.5 c. **About 1.9 c** (Opus 5.5:
  7,000 x $4 + 500 x $20 = 2.8 + 1.0 = 3.8 c).
- **Build.** 1.5 days: the context builder (one query per source, by `shopId`), the citation check, the card, the
  "helped / not useful" marks.
- **Return.** Biggest on models the tech sees twice a year. It turns the shop's own ticket history and the community's
  gotchas into something a tech reads at the bench instead of a search box nobody opens. Hard for anyone else to copy:
  the sources are the shop's. Risk: a confident wrong cause; the citations and the "general knowledge" label are the
  guard, and the tech still does the checks.

### 1.3 Intake helper ("Read the plate")

- **What.** A camera button beside Brand / Model / Serial on `/tickets/new` and the take-in form. One photo of the
  rating plate fills the three fields and the type when sure, with a yellow "Check these" note when it is guessing.
- **Data sent.** One photo (the intake form already shrinks photos in the browser) and the kind's brand list as hints.
  The serial is the point of the feature, so it comes back in the answer; it is written into the form only, and the log
  keeps the photo's size and the answer with the serial replaced by `[serial]`. No other photo ever goes
  (`MachinePhoto` rows stay in Postgres as today). Customer-identifying: a plate photo is not, unless the tech frames a
  claim tag or a name; the preview before sending shows the photo.
- **Offline.** The button is hidden; typing works as always.
- **Model.** `claude-haiku-4-5-20251001` with vision (extraction, JSON out). When Haiku answers "guess", the same
  photo can go once to `claude-sonnet-5-5` before the yellow note is shown.
- **Cost per call.** Photo 1,640 + prompt 360 = 2,000 x $1 / 1M = 0.20 c. Output 80 x $5 / 1M = 0.04 c. **About
  0.25 c** (the Sonnet retry adds 0.5 c).
- **Build.** 1 day: the button, the resize path (exists), the JSON parse, the two forms.
- **Return.** Saves a minute per check-in and most of the typos in serials and model numbers that later break spec and
  manual matching (`modelKey`). Cheap enough to be the free demo of the module (20 reads a month without a key).

### 1.4 Ask the manuals

- **What.** On the model page: "Where is the hook timing procedure for the MC6700P?" answered from the PDFs in the
  shop's own library with `[p. 47]` links that open the PDF at that page through the existing viewer.
- **Data sent.** The question, brand and model, and the text of the 12 best-matching pages of the model's manuals.
  Nothing about a customer or a ticket. **The manuals stay on the shop PC:** `desktop/index-manuals.mjs` extracts text
  per page with pdf.js (a dependency already) into `ManualPage(docId, page, text)` rows in the program's own database,
  lazily, the first time a model is asked about (a few seconds for a 200-page manual, with a progress line); page
  selection is Postgres full-text search on `text`, no embeddings, no second service. `LibraryDoc` supplies which files
  cover the model (`modelKeys`), and `library-dir.ts` the files themselves (`PRIVATE_FOLDERS` are never indexed).
- **Offline.** Indexing and search work offline; only the question needs the internet. The box says so and the page
  still lists the manuals and lets the tech open them.
- **Model.** `claude-opus-5-5`: this is the one candidate where reasoning across dense pages pays (a procedure split
  over a table, a note and a figure caption, and the answer must name the right page). Fable 5.1 costs 2.5x more for
  the same job and is not warranted; Sonnet 5.5 is the fallback if the owner wants it at half the price.
- **Cost per call.** 12 pages x 900 + 1,200 prompt = 12,000 x $4 / 1M = 4.8 c. Output 400 x $20 / 1M = 0.8 c. **About
  5.6 c** (Sonnet 5.5: 2.4 + 0.4 = 2.8 c; Fable 5.1: 12 + 2 = 14 c). Indexing costs nothing.
- **Build.** 3 days: the indexer in the Windows program, the `ManualPage` migration, page search, the question box,
  the page links into the viewer, a fixture manual for the check. Hosted shops with a browser-connected folder (the
  existing feature) would need the pages extracted in the browser and sent with the question: another day, later.
- **Return.** Finding one procedure in a 300-page service manual is 5-10 minutes of scrolling; this makes it one
  question, and the cited page means the tech reads the real procedure, not a summary. Windows-program shops only at
  first, which is where the libraries are. The largest build, so phase 2.

### 1.5 Parts

- **What.** (a) On a part with no cross-reference match, "Looks like" suggestions from the community cross-reference
  when `numberKey` matching fails (a Singer number typed as "Type 15J" and filed as "15J", or a description that
  matches an `XPart.name`); the tech confirms before `addPartToCrossRef` runs. (b) On a ticket, "Parts this job
  usually needs" from the shop's past PART lines on that model and the `XPart` fits. (c) On the hub, an owner's tool
  that lists likely duplicate `XPart`s (same brand, same fits, names a letter apart) for a person to merge.
- **Data sent.** (a) the part's number, alt numbers, description, brand, fits and up to 30 candidate `XPart` rows
  (name, numbers, fits). (b) the ticket's model and problem plus PART line descriptions from past tickets on that
  model. (c) `XPart` rows only (14,392 seeded; already community data). Customer-identifying: none; parts never carry
  customers.
- **Offline.** (a) and (b) hide their cards; the exact-number match and the local Fits fallback keep working. (c) runs
  on the hub.
- **Model.** (a) `claude-haiku-4-5-20251001` (pick from a list, JSON). (b) `claude-sonnet-5-5`. (c) Haiku through
  the Batch API, once.
- **Cost per call.** (a) 2,000 x $1 / 1M + 150 x $5 / 1M = 0.20 + 0.08 = **0.3 c**. (b) 5,000 x $2 / 1M + 300 x
  $10 / 1M = 1.0 + 0.3 = **1.3 c**. (c) about 2,000 candidate groups x 800 tokens = 1.6M x $0.50 / 1M = 80 c, plus
  200k output tokens x $2.50 / 1M = 50 c: **about $1.30 for the whole cross-reference**, run by the owner when wanted.
- **Build.** (a) and (b) 1.5 days together; (c) 1 day in the hub repo (a script and an admin list, no UI to merge
  beyond the existing `mergeCrossRef`).
- **Return.** (a) modest: `numberKey` already catches most matches, and `numberOwner` already refuses true duplicates
  by number. (b) useful on a slow afternoon of ordering, but the shop's PART history is thin until a model has been
  seen several times. (c) is a one-off clean-up. Nice to have, after the ticket features.

### 1.6 Counter

- **What.** (a) On the inventory import, when `guess()` in `import-items.tsx` leaves two or more needed fields
  unmapped, "Match the columns" proposes the header-to-field map and the user confirms in the existing picker. (b) A
  product's name and brand for a barcode the free UPCitemdb lookup does not know.
- **Data sent.** (a) the header row and three sample rows (parts data, no customers). (b) the 12-13 digit code.
- **Offline.** (a) the guess and the manual picker work as today. (b) the lookup already says "no internet".
- **Model.** (a) `claude-haiku-4-5-20251001`, JSON. (b) would need `claude-sonnet-5-5` with the web search tool
  ($10 per 1,000 searches), because no model knows UPC codes from memory and answering from memory would invent names.
- **Cost per call.** (a) 1,000 x $1 / 1M + 100 x $5 / 1M = 0.10 + 0.05 = **0.15 c**, and rare. (b) one search 1.0 c +
  4,000 result tokens x $2 / 1M = 0.8 c + 200 x $10 / 1M = 0.2 c = **about 2 c**, with no guarantee the result is the
  right product.
- **Build.** (a) half a day. (b) 1 day, not recommended: a UPCitemdb paid key (`UPCITEMDB_KEY`, already supported)
  answers the same question from a real database for less, and `barcode-lookup.ts` already caches and shares it.
- **Return.** (a) saves a few minutes on the first import a shop ever does; worth doing only because it is nearly free
  once the plumbing exists. (b) negative: a wrong product name in stock costs more than the lookup saves.

## 2. Shared plumbing, designed once

### 2.1 The Assistant module (id `assistant`)

- `MODULE_IDS` gains `"assistant"` (`src/lib/license.ts`, re-exported by `module-info.ts`); `MODULES.assistant =
  { label: "Assistant", href: "/settings/assistant", blurb: "Drafts the invoice and customer messages from a tech's
  notes, suggests likely causes from your own tickets and the community's gotchas, reads a rating plate from a photo,
  and answers questions from your manuals." }`. The key payload needs no change (`m` carries any module name; older
  programs show it as "needs a newer version"). Gate: `requireModule(user, "assistant")` in every action, `pageGate`
  on Settings -> Assistant, `shopsWithModule` nowhere (no worker calls the model on its own).
- Lapsed = the usual table (modules-design 6.4): the log stays readable and exportable, every "Ask" button is hidden,
  nothing else changes, because the Assistant never owns a record.
- Price (proposal for the owner): $15 a month or $150 a year on top of the $25 base, with 300 calls a month per
  company (about 10 a working day), then "You've used this month's Assistant calls" until the month turns in the shop's
  time zone or the owner adds a top-up. The mix below costs the owner about $3.60 a month at the full 300:
  150 drafts x 0.45 c = 68 c; 60 likely-causes x 1.9 c = $1.14; 60 plate reads x 0.25 c = 15 c; 30 manual
  questions x 5.6 c = $1.68. One runaway shop cannot cost more than the allowance allows.

### 2.2 The server-side proxy: the key lives on the hub

- The Anthropic key is `ANTHROPIC_API_KEY` on the **hub's** Railway service and nowhere else: not on a shop PC, not in
  the installer, and not on the hosted StitchBench or StitchShop services either. One path, one meter, one secret.
  The hosted services are hub members like any install, and the extra hop (tens of milliseconds) is nothing against a
  3-10 second model call. This departs from `assistant-design.md` section 4 (hosted direct, Windows via the hub).
- `POST /v1/assistant` on the hub, authenticated with the install key like every member call (the member middleware's
  regex gains it), body `{ shopRef, feature, model: "draft" | "suggest" | "read" | "manuals", system, messages,
  maxTokens, image? }`, at most 256 KB (the hub's body limits), one call in flight per shop. The program names a
  **model class**, not a model id; the hub maps class to id (`ASSISTANT_MODEL_DRAFT=claude-sonnet-5-5`,
  `..._SUGGEST=claude-sonnet-5-5`, `..._READ=claude-haiku-4-5-20251001`, `..._MANUALS=claude-opus-5-5`), so the owner
  moves every shop to a newer model by changing a variable, and a two-year-old installer keeps working when a model is
  retired. The hub adds `cache_control` to the system block, calls `POST /v1/messages` with `fetch` (no SDK, like the
  Twilio and Stripe clients), 30 s timeout (60 s for manuals), one retry on 429 / 5xx, and returns
  `{ text, usage: { input, cacheRead, output }, costMillicents, model }`.
- **Metering against the subscription** (`hub-accounts-billing-design.md`): the hub already knows each shop by
  `(install_id, shop_ref)` and, once `hub-modules` (its section 7 item 6) is built, which modules the subscription
  carries. The Assistant is the natural first module to sell on the hub subscription, because every call passes the hub
  anyway. Until `hub-modules`: the program sends its verified `assistant` key text once per session and the hub checks
  the Ed25519 signature against the same public keys (`license-keys.ts` has the public halves; a 20-line port with
  `node:crypto`), so the owner's emailed `k1` keys work from day one. Tables on the hub: `assistant_usage (shop_id,
  month, calls, input_tokens, output_tokens, cost_millicents)` and `assistant_calls (id, shop_id, feature, model,
  input_tokens, output_tokens, cost_millicents, ms, at, error)`. **No prompt or answer text is kept on the hub**: the
  hub never holds a shop's ticket text, redacted or not; it meters and forwards. Over the allowance: `402` with a plain
  message the program shows as the toast. The owner's admin page gets a per-shop usage column and a top-up button
  (another 300 calls, a Stripe price when billing is live, a comp before).
- Anthropic's API does not train on API inputs by default; the terms and privacy page (`terms-launch` package) gains a
  sentence saying what the Assistant sends and that it goes to Anthropic through StitchHub.

### 2.3 The log: `AssistantCall` (StitchBench migration, after the newest folder)

```prisma
// What the Assistant was asked and what it said, per company: the record a tech can check, and the month's count.
model AssistantCall {
  id            String   @id @default(cuid())
  shopId        String
  shop          Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  feature       String   // draft_work_done | draft_diagnosis | draft_estimate | draft_partner_note | likely_causes | read_plate | ask_manuals | xref_match | likely_parts | match_columns
  ticketId      String?  // what it was about: at most one of these is set
  repairJobId   String?
  machineId     String?
  partId        String?
  byUserId      String?
  model         String   // the model id the hub used
  request       Json     // the redacted request exactly as sent: { system, messages } (a photo as its size and hash)
  response      String   // the model's text, or the structured JSON as text; a serial masked as [serial]
  sources       Json     @default("[]") // [{ kind: ticket|gotcha|hubpost|spec|manual|general, ref, label }]
  inputTokens   Int
  cacheTokens   Int      @default(0)
  outputTokens  Int
  costMillicents Int     // thousandths of a cent (0.45 c = 450): money stays an integer, and a call is under a cent
  ms            Int
  accepted      Boolean? // "Use this" pressed, or "helped"; null for calls that only showed something
  error         String?
  createdAt     DateTime @default(now())

  @@index([shopId, createdAt])
  @@index([shopId, ticketId])
}
```

`Shop` gains `assistantMonth String?` (`"2026-10"` in the shop's zone) and `assistantCalls Int @default(0)`; the hub's
count is the authority, the local one is for the Settings page offline. The ticket history shows "Assistant: drafted
Work done (used)" lines; Settings -> Assistant lists the month's calls with "What was sent" expandable per row;
`/api/export/[what]` gains `assistant` (never module-gated, like every export).

### 2.4 The consent rule

- `redact()` (`src/lib/assistant/redact.ts`, pure, tested with a dozen shapes in `assistant.check.ts`) runs on every
  field before it leaves: email addresses, phone numbers (7+ digits with separators), the ticket's customer name, the
  trade account's name and the shop's known customer names become `[customer]`. Structured customer fields are never
  read into a request at all. Serials go only inside a plate photo (1.3). Photos other than the chosen plate never go.
- **The explicit choice**, in the sharing rule's words: Settings -> Assistant has one switch per feature, and a
  per-company "Offer customer first names to the Assistant for drafts" switch, **off** by default; with it off, drafts
  use `{first_name}` and the program fills it in. Nothing else about a customer can be offered; there is no switch for
  it. The first use on each ticket opens "What we'll send", the exact redacted text, with the internal notes and the
  bill untickable.
- A call is never made on a page load, a timer or a worker: only when a person presses Ask / Draft it / Read the plate.
  The model never changes a record; "Use this" fills a field and the form still has to be saved.

### 2.5 Offline and failure

`assistantAvailable()` is true when the module is active and the hub was reachable at the last sync (the layout's
offline pill already knows). When false, every entry point renders its disabled form ("The Assistant needs the
internet") and nothing spins. A call that fails mid-way (hub down, timeout, 402, a refusal stop reason) logs an
`AssistantCall` with `error` and shows one plain toast; the field keeps what the tech typed. `ASSISTANT=off` on a
server stops every call (the `MESSAGES=off` pattern) and the check scripts and Playwright spec run against
`scripts/test-mail/anthropic-mock.mjs`, which answers from fixtures so no test spends money.

### 2.6 The UI pattern (one component, every feature)

A `card card-pad text-sm` with a title ("What's likely wrong", "Draft it"), an **Ask** button (or Draft it / Read the
plate), an "Asking..." line while it runs (3-10 s), then the answer: the text or the list, each item followed by its
**sources** as links (ticket #0123 opens the ticket; a gotcha opens the model page at the note; a spec row opens
`/specs`; a manual page opens the PDF at that page; "general knowledge" is a plain label), then the buttons **Use
this** (fills the target field; records `accepted`), **Try again** with an optional one-line instruction ("shorter",
"mention the belt") and **Not useful**. First use per ticket shows `<details>` "What we'll send". The card prints
nothing (`no-print`). Techs and admins see the same card; only admins see Settings -> Assistant.

## 3. Ranking and recommendation

| # | Candidate | Model | Per call | Build | Why this place |
|---|---|---|---|---|---|
| 1 | Write-ups (1.1) | Sonnet 5.5 | 0.45 c | 1 d | Every ticket, every day; no customer data; lowest risk of a wrong answer doing harm (a person reads it before it prints) |
| 2 | Bench assistant (1.2) | Sonnet 5.5 | 1.9 c | 1.5 d | The differentiator: cites the shop's own tickets, the community's gotchas and the specs already in the database |
| 3 | Intake helper (1.3) | Haiku 4.5 | 0.25 c | 1 d | Cheapest, best demo, fixes the typos that break spec and manual matching; smaller daily gain than 1 and 2 |
| 4 | Ask the manuals (1.4) | Opus 5.5 | 5.6 c | 3 d | Highest value per use for Windows shops, but the biggest build and the only one needing the indexer; phase 2 |
| 5 | Parts (1.5) | Haiku / Sonnet | 0.3-1.3 c | 2.5 d | Modest: number matching already works; the duplicate finder is a one-off $1.30 job for the owner |
| 6 | Counter (1.6) | Haiku | 0.15 c | 0.5 d | Column matching is a freebie once the plumbing exists; the barcode idea should not be built |

**Build first: 1.1 Write-ups and 1.2 Bench assistant, as one package `assistant` with the plumbing (about 2 + 1 +
1.5 = 4.5 days).** They share the ticket page, the context builder and `redact()`, so the second costs little once the
first exists; together they are what a shop would pay $15 a month for, and a shop that tries the free plate reads has
a reason to buy. The intake helper (1.3) is the cheap third if the package has a spare day; manuals is its own package
after the hub's `hub-modules` metering exists. Order in the handoff: after the current scheduling and online packages
are tested, since the ticket page and templates they touch must be stable first.

## 4. Open questions, with recommended answers

1. **Price and allowance.** $15 a month / $150 a year with 300 calls, or fold the Assistant into a $35 base?
   Recommended: the module at $15 / 300. It keeps the $25 base promise, the owner's exposure is about $3.60 a shop a
   month at the full allowance, and a shop that never uses it never pays for it.
2. **All calls through the hub, hosted services included?** Recommended: yes (2.2). One key, one meter, one audit
   trail, and the hub picks the model id so old installers keep working.
3. **Does the hub keep prompt text?** Recommended: no, tokens and cost only; the program's `AssistantCall` holds the
   text, which is the shop's record and leaves with its export.
4. **Serial numbers.** Recommended: never sent except inside a plate photo, and masked in the log's answer. They help
   date a machine for likely-causes, but a serial can identify a person through warranty records.
5. **Customer first names in drafts.** Recommended: the per-company "offer" switch, off by default, with `{first_name}`
   filled locally otherwise (2.4).
6. **A shop's voice.** Recommended: a Settings -> Assistant field of three sample sentences that goes into the cached
   system prompt; cheap, and shops care how their invoices read.
7. **Free plate reads without the module.** Recommended: 20 a month, counted on the hub, about 5 c a shop a month to
   the owner; the best demonstration the program can give at check-in.
8. **Ask the manuals: Windows program only at first?** Recommended: yes; hosted shops with a connected browser folder
   later, if asked for.
9. **Model for the manuals: Opus 5.5 at 5.6 c or Sonnet 5.5 at 2.8 c?** Recommended: Opus 5.5; the cost difference is
   3 c on a call made a few times a week, and a wrong page reference wastes more than that.
10. **The barcode product lookup (1.6 b).** Recommended: do not build; buy the UPCitemdb key the code already supports.
11. **Duplicate cross-reference finder (1.5 c).** Recommended: an owner's script in the hub repo, run once a quarter,
    results reviewed by a person before `mergeCrossRef`; not a shop feature.
12. **When the hub is unreachable but the internet is up** (the hub is down, not the shop): Recommended: still
    "unavailable"; no fallback path that would put a key on a shop PC.
13. **Terms.** Recommended: the privacy page says what is sent and to whom (2.2), and Settings -> Assistant links it.
