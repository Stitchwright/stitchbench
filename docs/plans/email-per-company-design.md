# Email addresses unique per company (round 3 W1: L7 and L31)

Status: design, 6 Oct 2026, not built. This is the billing design's later package `hub-email-identity`
(`docs/plans/hub-accounts-billing-design.md` section 7 item 6, owner question 11). The owner decided "yes" on 30 Sep.
Build it after package 4 and batches C and E, because it edits the same sign-in files.

## 1. The problem and the rule

`User.email` is unique across the whole install (`prisma/schema.prisma:204`). On a hosted install a tech who works for two
shops cannot have a login in both. Worse, shop A's admin can park `bob@shopB.example` and shop B can never add Bob, and
"That email already has an account." lets any admin test which addresses exist elsewhere.

New rule: an email is unique inside one company. The same address may have a login in several companies, each with its
own password, role and sessions. Nothing else about a login changes (the session still carries the login's `id` and
`shopId`, so every `shopId` filter stays correct).

## 2. Schema and migration

- `User`: replace `email String @unique` with `@@unique([shopId, email])` and add `@@index([email])` (sign-in and reset
  look up by email alone, so they need the index).
- Migration `<timestamp>_email_per_company`: `DROP INDEX "User_email_key"`, `CREATE UNIQUE INDEX "User_shopId_email_key"
  ON "User"("shopId","email")`, `CREATE INDEX "User_email_idx" ON "User"("email")`. No data changes.
- Existing rows stay valid: they were unique across the install, so they are unique per company. The new indexes
  cannot fail on any install, and the old one is gone, so a rollback to the old build is only safe until a second company
  gets the same address (note in the release text).
- Emails are stored lowercase (`normalizeEmail`), so a plain index is enough. The Windows program (one company, one
  database) behaves as before.
- Prisma then stops compiling every `findUnique({ where: { email } })`, which is the safety net for section 9.

## 3. Sign-in with one email in several companies

Recommended flow:
1. The sign-in form stays one email and one password. The server loads every active login with that email and checks the
   password against each (bcrypt per login).
2. Exactly one matches: signed in, as today. Two or more match: a "Choose a company" step lists the matching companies
   (names only). Nothing matches: the same "wrong email or password" answer as today.
3. The choice is carried by a signed ticket (HMAC with `AUTH_SECRET`, 5 minutes, holds the matching login ids and their
   `sessionVersion`), so the password is not resent or kept in the page. Auth.js `authorize()` accepts either
   `{ email, password }` (signs in only when exactly one login matches) or `{ ticket, userId }` (verifies the
   ticket, that the login is still active and its `sessionVersion` is unchanged). `/api/auth` stays the one door.

- No enumeration: company names appear only after a correct password for two or more logins. A wrong password gives
  the same answer for unknown email, one login and many. Timing: always run three bcrypt compares (dummy hashes pad
  the missing ones), so one login and three cost the same; a fourth login adds one more compare (accepted).
- Pacing: the per-email queue, the 20-waiting cap and the per-address limit keep keying on the normalized email (one
  person guessing at an address is slowed in every company at once). Tries count per attempt, not per login compared.
- Known-device cookie (`src/lib/known-device.ts`): the entry becomes per login, not per email. The mac covers
  `userId` and that login's `sessionVersion` (key text `v3`, so every browser is "unknown" once after the release and
  owners just sign in the normal way). `knownDeviceFor` is tried for each login found by the email; any hit uses the
  device's own failure count. `rememberThisDevice` takes the login id (`src/app/login/page.tsx:50`,
  `src/actions/password-reset.ts:28`, which gets the id back from `finishReset`).
- The login that is chosen is the only one signed in. A person in two companies signs out and in to switch. A
  company switcher inside the app is out of scope (question 2).

## 4. Password reset

- Request page (`requestResetFor`, `src/lib/password-reset.ts:103`): look up all active logins with the email. For each
  one `issueResetLink` makes its own link (one use, one hour; it already retires that login's older links). One mail
  lists each company with its link. Same on-page answer, same limits (3 mails an hour per email, no matter how many
  logins).
- `/reset?t=` and `finishReset` already work per login (the link row holds `userId`); `finishReset` returns the login id
  as well as the email.
- Administrator "Reset link" and the hub reset grant are already per company (`ownerResetLinkFor` takes a `shopId`;
  `hub-reset-grants.ts:148` and `:235` filter by `shopId`), so they only switch to the compound key.

## 5. The administrator's reserved emails

`PLATFORM_ADMIN_EMAILS` hands out install-wide rights by address, so a reserved address must stay unique install-wide.
Keep today's refusals (`createShopWithOwner` reserved check, `addPersonAs`, `/signup`, the move import) and add one
rule: a reserved address may have a login in a second company only when made by the administrator themselves
(`allowReserved`), never by anyone else. A check script asserts a non-administrator cannot create a reserved login in
any company even when the address is free there. The administrator's login in several companies is allowed (they can add
their own address to a company they create); it is how they would see each company as a user.

## 6. Sign-up and adding people

Refuse only inside the same company, with the existing words. `/signup` (`src/app/signup/page.tsx:45`) and
`createShopWithOwner` (`src/lib/shops.ts:62`) create a company, so an address that exists elsewhere is fine and no
longer a probe. `addPersonAs` (`src/lib/people.ts:29`) checks `{ shopId, email }`, so People still says "already in
People: use Restore access" for the same company. `setUpSewingShop` (`src/actions/partners.ts:161`) drops its check
(the new company has no users). The provisioning API (`platform-api.ts:102`) no longer answers 409 for an address that
is an owner elsewhere; it still does for a reserved one, and reads the new owner by `shop.id` and email.

## 7. The move import

Refusal 4 (`src/lib/move/import.ts:381-389`, "already used on this install") is removed: the imported company is a new
company, so its logins cannot clash. The reserved-address refusal stays. The import report line "Everyone signs in again
here, with the same email and password" (`:530`) stays true; people who already have a login in another company on this
install now see "Choose a company" at sign-in. The refusal 4 text in `docs/` and `scripts/checks/move-import.check.ts:430`
and `:576` change with it.

## 8. The hub's identity

The hub account is per email and already holds several shops (`StitchHub src/accounts.mjs:255, 304, 327`): a shop is tied
to one account, and an account may have many shops; door 1 for an address that already has an account answers "use a link
code". So an owner with two companies and one address gets one hub account and connects the second company with a link
code. No hub change is needed ("StitchHub: none"). In the program, the hub account email stays the owner login's email of
that company (question 11 of the billing design stays: recommended yes). `hub-account.ts:266` (the company's owner
email) is already per shop. Per-company owner emails may now differ from the hub account email later, but this package
does not build that.

## 9. Every place that looks a user up by email alone

| Where | Now | Change |
| --- | --- | --- |
| `src/lib/sign-in.ts:97` (`passwordOk`) | `findUnique({ email })` | `findMany`, compare each, return matches |
| `src/lib/sign-in.ts:113` | sessionVersion by email, for the cookie | per login, from the same load |
| `src/lib/known-device.ts:110` | sessionVersion by email | by login id |
| `src/lib/password-reset.ts:103` | one user | all active logins, one mail |
| `src/lib/people.ts:29` | any user with the email | `{ shopId, email }` |
| `src/lib/shops.ts:62` | any user | remove (new company); keep reserved rule |
| `src/app/signup/page.tsx:45` | any user | remove; keep reserved rule |
| `src/actions/partners.ts:161` | any user | remove |
| `src/lib/platform-api.ts:109` | by email | by `shopId_email` (and the 409 test, `:102`) |
| `src/lib/hub-reset-grants.ts:148, :235` | shop plus email | already per company: compound key |
| `src/lib/move/import.ts:383` | raw SQL on `"User"` | remove; reserved check stays |
| `scripts/checks/plans.check.ts:47`, `hosted-provisioning.check.ts:343` | by email | by shop and email |
| `src/lib/session.ts:18` and every `shopId` query | by id | none |

The `isPlatformAdmin(user.email)` calls (11 files) read the logged-in login's own address, so they stay correct.

## 10. Tests

Change: `tests/auth.spec.ts` (the pace and flood specs use one login per email, they stay), `signup.check.ts`,
`signin.check.ts` (pacing keyed by email, cookie per login), the move import checks, and the two checks above.
Add: (a) same email in two companies, same password: choose-company step, the chosen login signs in; (b) different
passwords: each signs in straight; (c) a wrong password gives the same answer for 0, 1 and 2 logins; (d) the ticket is
refused after 5 minutes, after a password reset, and for a login not in it; (e) `addPersonAs` and `/signup` accept an
address used elsewhere and refuse it inside the company; (f) the reset mail lists two companies and each link resets only
its own login; (g) a reserved address cannot be taken by a non-administrator in a second company; (h) the migration
applies to a database with existing users; (i) a move import of a company whose tech address exists elsewhere succeeds.
Run the Playwright specs one at a time (Chrome crashes in parallel on this PC).

## 11. Effort and risks

Effort: about 3.5 days (migration and lookups 0.5, sign-in and ticket and cookie 1.25, reset and mail 0.5, sign-up,
people, provisioning, import 0.5, tests and check scripts 1, release notes and review 0.25).

Risks: (1) sign-in is the most sensitive code in the program; the ticket must be bound to `sessionVersion` and never
accepted without a prior right password. (2) Timing and count leaks need the padded compares. (3) Reset mail now names
a company chosen by another admin: a hostile admin could put misleading text in a shop name in a mail to an address they
added; the mail should show the company name plainly and say "Choose only the one you asked for". (4) The `v3` cookie
resets every browser's standing once. (5) A shared password between two logins of one person cannot be told apart by the
server: the chooser is the only way, which is intended. (6) Support: "which company is this login?" appears in
Settings, so show the company name in the sidebar footer (small, add to the build).

## 12. Questions for the owner

1. Same person, same password in two companies: show the chooser, or sign in to the oldest login? Recommended: the
   chooser (never guess which company holds the data).
2. A company switcher inside the app, so no sign-out is needed? Recommended: not now; sign out and in. Revisit after
   the first real two-company person asks.
3. Should one password reset set the password of all of a person's logins at once? Recommended: no, one link per
   login, so a company's owner never gets the power to change another company's login.
4. May the administrator keep a login in several companies on the same reserved address? Recommended: yes, only
   they can create it.
5. Reset mail wording: show company names? Recommended: yes, the names are needed to pick; keep the warning line.
6. Rollback: accept that, after the first duplicate address exists, going back to the old build needs one
   login renamed? Recommended: yes.
