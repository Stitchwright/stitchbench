# StitchBench Assistant: a paid module that drafts, suggests and reads

Status: design, revision 1 (1 Oct 2026). Written for the owner's decision; nothing is built. It follows the shape of
`modules-design.md` (a module `assistant` gated through `requireModule`) and reuses the messaging foundation's templates
and the equipment framework. Where this document says "decided", it is a proposal the owner can overrule.

## 0. Why, in one page

The two products already hold what makes an AI helper useful and hard to copy: the shop's own tickets, notes and
photos; the community's gotchas and cross-reference; the factory specs; and (on the shop PC) the service manuals. A
general chatbot has none of that. The Assistant module sells on three everyday moments:

1. **Write it for me.** A tech types shorthand on a ticket ("hook timing off 2mm, bobbin case cracked, replaced,
   cleaned, test sewn") and gets the invoice's "Work done", the estimate wording and the customer's text or email,
   in the shop's voice, one tap from the ticket. Cheapest to build, used on nearly every ticket.
2. **What's likely wrong.** From the model and the problem reported, a short list of likely causes and the checks to
   make, each with where it came from: this shop's past tickets on that model, the community's gotchas, the factory
   spec table. The differentiator: it cites the shop's own history.
3. **Ask the manuals** (phase 2). "Where is the hook timing procedure for the MC6700P?" answered from the PDFs in the
   shop's own library with page references. The library stays on the shop PC, so the indexing runs there.

Also in scope, small: the **intake helper** (a photo of the rating plate fills brand, model and serial on check-in)
and **smarter import** (column guessing on spreadsheet import). Out of scope for this build: anything that talks to
customers on its own, anything that changes a record without a person pressing Save, parts ordering, pricing advice.

**Pricing** (decided): the module is $15/month or $150/year on top of the $25 base, with a fair-use allowance of 300
assistant calls a month per company (about 10 a day); above that, calls pause until the next month or the owner buys a
top-up. Per-call cost to the owner is cents; the allowance keeps a runaway loop from costing more than the module earns.
Hosted: the owner's API key, billed to the owner. Windows program: the same (the key is never on the shop PC; calls go
through the hub, section 4), so a shop needs the internet for the Assistant and nothing else changes offline.

## 1. Rules (binding)

- **Nothing private leaves the shop without a choice.** Customer names, phones, emails and addresses are stripped from
  every request before it leaves (`redact()`, section 5). The ticket number, machine, problem text, diagnosis, notes
  and the shop's name go. The tech sees exactly what will be sent ("What we'll send") before the first use on each
  ticket, and can edit it.
- **A person presses Save.** The Assistant writes into a draft box; the tech copies or accepts it into the ticket field.
  No action is taken by the model: no status changes, no messages queued, no records created.
- **Everything is logged** on the ticket (an `AssistantCall` row: what was sent, what came back, who asked, when, the
  tokens used). "Assistant" appears in the ticket's history. The log is exportable (`/api/export/assistant`).
- **Offline degrades to "unavailable".** Every entry point checks `assistantAvailable()` first and shows "The Assistant
  needs the internet" instead of a spinner. The Windows program keeps working without it.
- **Gated like every module.** `requireModule(user, "assistant")`; the Settings → Modules row, the key format and the
  Companies switch work unchanged (`MODULE_IDS` gains `"assistant"`).
- **Cited or marked.** A suggestion either cites where it came from (ticket #, gotcha, spec row, manual page) or carries
  the label "general knowledge". The UI never shows an uncited claim as a fact.
- **Model and prompts are the owner's.** Prompts live in `src/lib/assistant/prompts.ts`; the model id is one constant.
  Use the latest Claude Sonnet-class model for drafting and suggestions (cost) and the Opus-class model only for
  "Ask the manuals" (long context). Both through the Anthropic API with the owner's key.

## 2. Where it appears

| Place | What | Module gate |
|---|---|---|
| Ticket page, "Work done" and "What we found" | **Draft it**: turns the tech's shorthand (the field as typed, plus the problem reported and the lines on the bill) into customer-facing text; the draft shows in a box with "Use this" and "Edit" | assistant + the ticket workable (equipment gate) |
| Ticket page, estimate (estimate-links package) | **Write the estimate note**: a short note for the estimate message from the lines and diagnosis | assistant + marketing (sending) |
| Ticket page, right column | **Likely causes**: a card "What's likely wrong" with up to five causes, each with its checks and sources; "Ask again with what I found" after the tech types a diagnosis | assistant |
| Partner repair job (StitchShop side), note to the sewing shop | **Draft the note**: what it needs, what it costs, when it's back, in plain words for the counter | assistant |
| Check-in and take-in | **Read the plate**: a photo button next to Brand / Model / Serial; fills the three fields and the type when sure | assistant (free trial of 20 reads a month without the module, decided: it is the best demo) |
| Model page | **Ask the manuals** (phase 2): a question box; answers quote the manual with page links that open the PDF at that page through the existing manual viewer | assistant, Windows program (or hosted with a connected library folder) |
| Inventory import | **Match the columns**: when the guess is poor, the Assistant maps headers to fields and the user confirms | assistant |
| Settings → Assistant | the allowance used this month, the log, "What we send" explanation, a switch per feature | admins |

## 3. Data model (one new model, two fields)

```prisma
// What the Assistant was asked and said, per company: the record a tech can check, and the month's allowance count.
model AssistantCall {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  feature     String   // draft_work_done | draft_diagnosis | draft_estimate | draft_partner_note | likely_causes | read_plate | ask_manuals | match_columns
  ticketId    String?
  repairJobId String?
  machineId   String?
  byUserId    String?
  request     Json     // the redacted request as sent: { model, system, messages }
  response    String   // the model's text (or the structured JSON as text)
  sources     Json     @default("[]") // [{ kind: ticket|gotcha|spec|manual|general, ref, label }]
  inputTokens  Int
  outputTokens Int
  accepted    Boolean? // the tech used the draft (null for suggestions)
  error       String?
  createdAt   DateTime @default(now())

  @@index([shopId, createdAt])
  @@index([shopId, ticketId])
}
```

`Shop` gains `assistantMonthStart DateTime?` and `assistantCalls Int @default(0)` (the allowance counter, reset when the
month in the shop's time zone changes) and the back-relation. `MODULE_IDS` gains `"assistant"`; `MODULES.assistant` =
`{ label: "Assistant", href: "/settings/assistant", blurb: "Drafts the invoice and customer messages from a tech's notes, suggests likely causes from your own tickets and the community's gotchas, reads a rating plate from a photo, and answers questions from your manuals." }`.
The license payload needs no change (`m` already carries any module name; old versions show it as "needs a newer
version").

## 4. How calls travel

- **Hosted app:** `ANTHROPIC_API_KEY` on the Railway service; `src/lib/assistant/client.ts` calls the Messages API
  directly with `fetch` (no SDK dependency, like the Twilio client), 30 s timeout, one retry on 429/5xx.
- **Windows program:** the key never leaves the owner's infrastructure. The program posts the redacted request to the
  hub (`POST /v1/assistant`, authenticated with the install key like every hub call), and the hub (`stitchhub` repo)
  forwards it to Anthropic with the owner's key, checks the company's module state (the hub already learns which
  modules a company has when it becomes the second key issuer, HANDOFF step 5) and counts the allowance. Until the hub
  has that, the Windows program shows "The Assistant runs on the hosted StitchBench for now" (decided: hosted first,
  Windows through the hub second; the request shape is the same so nothing is rewritten).
- Prompt caching: the system prompt (the shop's voice, the rules) and the per-model context (specs, gotchas) go in
  cached blocks; only the ticket's text changes per call. Keeps the per-call cost at cents.
- **Structured outputs:** `likely_causes`, `read_plate` and `match_columns` ask for JSON with a schema and are parsed
  defensively (`cleanJson()`); a parse failure shows "Couldn't read the answer; try again" and is logged.

## 5. `redact()` and context (what is sent)

`src/lib/assistant/context.ts` builds the request:

- **Always sent:** shop name; the kind's noun ("sewing machine"); brand, model, type; the problem reported, diagnosis,
  work done and internal notes of this ticket; the bill's line descriptions and amounts (never payment details); the
  accessories list; the tech's first name (for the voice).
- **Never sent:** customer name, phone, email, address; the trade account's name; serial numbers (a serial can identify
  a person through warranty records; decided: not sent); photos except the rating-plate photo the tech chose; other
  customers' tickets' customer fields.
- **Context for `likely_causes`:** the shop's last 20 tickets on the same brand + modelKey (diagnosis, work done, line
  descriptions, dates, no customer fields); the model's `ModelNote`s and the community `HubPost`s for the model
  (already public text); the `TensionSpec` and `FactorySetting` rows for the model. Each item carries a stable
  reference (`ticket:0123`, `gotcha:<id>`, `hubpost:<id>`, `spec:<id>`) that the model must cite; the answer's citations
  are checked against the list and anything unknown becomes "general knowledge".
- **`redact(text)`** also scrubs free text: email addresses, phone numbers (any 7+ digit run with separators), and the
  ticket's customer name and the shop's known customer names (word-boundary, case-insensitive) become "[customer]".
  Tested by `assistant.check.ts` with a dozen real-looking shapes.
- **"What we'll send"**: a `<details>` on the first use per ticket shows the exact redacted text; the tech can untick the
  internal notes or the bill before sending.

## 6. Features in detail

### 6.1 Draft it (`draft_work_done`, `draft_diagnosis`, `draft_estimate`, `draft_partner_note`)

- Input: the field's current text (shorthand), the ticket context (section 5), the target (the invoice's "Work done"
  prints for the customer; "What we found" is internal; the estimate note goes in a message; the partner note goes to
  a sewing shop's counter staff).
- Output: 2-6 plain sentences, no marketing, no promises of dates, no prices unless on the bill, past tense for work
  done, the shop's voice ("we", not "I"). Length caps: work done 600 characters, estimate note 400, partner note 300.
- UI: a "Draft it" button under the field (admins and techs). The draft appears in a box with "Use this" (fills the
  textarea; the form still has to be saved) and "Try again" (with an optional instruction: "shorter", "mention the
  belt"). Accepting records `accepted: true`.

### 6.2 Likely causes (`likely_causes`)

- Output JSON: `{ causes: [{ title, why, checks: [string], sources: [ref] }], note }`, at most five causes, checks are
  bench actions ("Check hook-to-needle clearance, spec 0.05-0.1 mm"), sources must come from the context list.
- UI: a card on the ticket's right column, collapsed by default on tickets opened before the module was on. Each
  source is a link (the past ticket, the gotcha, the spec row). A "This helped" / "Not useful" pair records
  `accepted`. Re-asked with the diagnosis once the tech has typed one ("Now that you found X...").
- Not shown for SITE tickets (installs) in this build.

### 6.3 Read the plate (`read_plate`)

- Input: one photo (shrunk in the browser to 1280 px as the intake form already does), the kind's brand list as hints.
- Output JSON: `{ brand, model, serial, type, confidence: "sure" | "guess" }`. "sure" fills the fields; "guess" fills
  them with a yellow note "Check these"; nothing on failure. Serial is filled locally and never logged in `request`.
- UI: a camera button beside the Brand field on `/tickets/new` and the take-in form. Free allowance: 20 reads a month
  without the module (decided), counted the same way.

### 6.4 Ask the manuals (`ask_manuals`, phase 2)

- Windows program only at first (the library is there). Indexing: `desktop/index-manuals.mjs` extracts text per page
  with pdf.js (already a dependency) into `ManualPage(docId, page, text)` rows in the program's database, for the
  LibraryDoc rows of the brand + model being asked about (lazy: the first question about a model indexes its manuals,
  a few seconds for a 200-page manual, with a progress line). No embeddings in this build: the question picks pages
  by keyword search (Postgres full-text on `text`) and sends the top 12 pages (about 10k tokens) to the Opus-class
  model with the question; the answer must cite `[p. 47]` markers that the UI turns into links opening the PDF at that
  page through the existing viewer.
- Hosted: only for shops whose browser has connected a library folder (the existing feature); the pages are extracted
  in the browser and sent with the question. Phase 2 decides whether that is worth it.

### 6.5 Match the columns (`match_columns`)

- Input: the header row and three sample rows of the pasted sheet; output: the field map the existing import UI
  expects. Only offered when the existing guess leaves two or more required fields unmapped. Cheap and rare.

## 7. Files

- `src/lib/assistant/{client,context,redact,prompts,allowance,features}.ts` (server; `features.ts` has one function per
  feature returning `{ text | json, sources, call }`), `src/lib/assistant/types.ts` (pure).
- `src/actions/assistant.ts` (`"use server"`, data actions returning `{ ...result } | { error }`; each: `requireUser()`,
  `requireModule(user, "assistant")` (except `read_plate` inside the free allowance), ownership by `shopId`,
  `allowance()`, then the feature).
- `src/components/assistant/{draft-button,likely-causes,plate-reader,what-we-send}.tsx` (client where they hold state).
- `src/app/(app)/settings/assistant/page.tsx`; `src/app/api/export/[what]/route.ts` gains `assistant`.
- Edits: `prisma/schema.prisma` + a migration; `src/lib/module-info.ts` (`MODULE_IDS`, `MODULES`); `tickets/[id]/page.tsx`
  (two slots: under "What we found" / "Work done", and the causes card); `repairs/[id]/page.tsx` (the partner note);
  `tickets/new/page.tsx` and `intake-form.tsx` (the plate button); `import-items.tsx` (match columns); `.env.example`
  (`ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_MODEL_LONG`); INSTALL.md.
- Checks: `scripts/checks/assistant.check.ts` (redact cases; citation checking; the allowance reset at the month's turn
  in shop time; `assistantAvailable()` false with no key or `ASSISTANT=off`; the client's retry and timeout against a
  local mock of the Messages API, `scripts/test-mail/anthropic-mock.mjs`, which answers from fixtures so the checks and
  the Playwright spec never spend money).
- Playwright `tests/assistant.spec.ts` on the test build against the mock: draft, use it, see the log; likely causes
  with a cited past ticket; the module off hides every button.

## 8. Cost and build order

- Build: about one package the size of `estimate-links` for 6.1-6.3 and 6.5 together (two to three days with the
  current approach), `ask_manuals` another package of the same size later.
- Running cost (owner's side, Sonnet-class pricing in 2026): a draft is about 2-3k input tokens with caching and 200
  output, well under a cent; likely causes 6-10k input, 400 output, about 1-2 cents; a plate read with a photo 1-2
  cents. 300 calls a month cost the owner a dollar or two per shop against $15 of revenue.
- Order: after `modules-crossover` (the ticket page is then stable), as its own package `assistant`, with the hub
  forwarding for the Windows program following in the StitchHub accounts work.

## 9. Open questions for the owner

1. Price: $15/month, $150/year, 300 calls, 20 free plate reads? Or fold the Assistant into the base price and raise
   it to $35?
2. Serial numbers: never sent (as proposed), or sent for likely-causes (they help date a machine)?
3. Hosted first, Windows through the hub second: acceptable that Windows shops wait for the hub work?
4. "Ask the manuals": Windows only at first?
5. The shop's voice: one house style, or a per-shop "how we write" setting (three sample sentences) that goes in the
   cached system prompt? (Proposed: the setting, it is cheap and shops love it.)
