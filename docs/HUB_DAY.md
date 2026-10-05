# Hub day: StitchHub goes live with accounts (the owner's evening, with Claude alongside)

One evening. At the end: shops sign up and manage their accounts at hub.stitchbench.app, both programs carry the hub's
public key, today's branch work is deployed. **Billing stays closed** until Stripe day (no `STRIPE_*` variables yet).
Deploys and merges are yours: Claude gives each command; paste it with `!` in front (or run it in a PC terminal).

Before the evening: Claude has run the full checks on both branches; you've decided email (step 1).

## 1. Email for the hub (15 min)

Pick one:
- **Quick start: Gmail.** In the bwattendorfdev Google account: Security → 2-Step Verification on → App passwords →
  make one named "StitchHub". Hub variables (Railway → stitchhub project → stitchhub service → Variables):
  `SMTP_URL` = `smtps://bwattendorfdev%40gmail.com:<the 16-letter app password, no spaces>@smtp.gmail.com:465`,
  `MAIL_FROM` = `StitchHub <bwattendorfdev@gmail.com>`.
- **Better: Resend (free, 3,000 mails a month), sending as noreply@stitchbench.app.** Sign up at resend.com, add the
  domain stitchbench.app; Resend lists 3 or 4 DNS records: add each in Cloudflare (stitchbench.app → DNS → Add record,
  DNS only, grey cloud). When Resend says Verified, make an API key, then: `SMTP_URL` =
  `smtps://resend:<API key>@smtp.resend.com:465`, `MAIL_FROM` = `StitchHub <noreply@stitchbench.app>`.

Never paste the password or key into chat: type it straight into Railway.

## 2. hub.stitchbench.app (10 min)

1. Railway → stitchhub project → stitchhub service → Settings → Networking → **Custom Domain** → `hub.stitchbench.app`.
   Railway shows a CNAME target (something like `xxxx.up.railway.app`).
2. Cloudflare → stitchbench.app → DNS → Add record: Type CNAME, Name `hub`, Target = Railway's target, **DNS only (grey
   cloud)** so Railway issues the certificate. Save. Railway shows the domain as verified within minutes.
3. Hub variable `HUB_URL` = `https://hub.stitchbench.app`.

## 3. The hub's signing key (10 min)

1. Claude runs, on this PC: `npm run license:keygen -- --kid hub1 --hub` in the StitchBench repo, writes the private
   half to `Documents\StitchHub hub1 signing key.txt` (never into chat) and puts the public line into
   `src/lib/license-keys.ts` (the `hub1` entry) and commits it.
2. You open that file and paste into the hub's variables: `HUB_LICENSE_KEY` = the private key text, `HUB_LICENSE_KID`
   = `hub1`. Keep the file in Documents with the other admin notes.

## 4. Merge and deploy the hub (15 min)

```
! cd C:/Users/bwatt/stitchhub && git checkout main && git merge --no-ff hub-accounts && git push origin main
! cd C:/Users/bwatt/stitchhub && railway up --service stitchhub --ci
```
(Claude confirms the right Railway project link first.) The hub runs its migrations (accounts, billing, plans,
founding shops, disputes, the partnership rule) on start. Check: `https://hub.stitchbench.app/account` loads, and
`/admin` with your admin token. Billing shows as closed: correct until Stripe day.

## 5. Release the programs (30 to 45 min)

1. Claude merges nothing on its own; you run, after Claude's last check:
```
! cd C:/Users/bwatt/stitchbench && git checkout main && git merge --no-ff scheduling-features && git push origin main
```
2. Deploy both hosted services from main (the commands from 4 Oct, the StitchBench one links and links back):
```
! cd C:/Users/bwatt/stitchbench && railway up --service stitchshop --ci
! cd C:/Users/bwatt/stitchbench && railway link --project stitchbench && railway up --service stitchbench --ci ; railway link --project stitchshop --service stitchshop
```
   Both hosted services: set `HUB_URL` = `https://hub.stitchbench.app` if they don't already point there.
3. Right after: the marketplace count (L6), at the PC terminal:
   `railway ssh -p 10264d2c-c4d5-4f20-9604-4f72c672005b -e production -s stitchbench -- node scripts/hosted/count-unassigned-market.mjs`
   and the same with `-p 2426d0d0-b2af-4f64-bff8-1db1ee1305ae -s stitchshop`. Send Claude the numbers.
4. Installers: Claude bumps the version (1.7.0) on main for you to push, then starts the GitHub build.
5. The PC's own StitchBench: Claude backs it up (`node desktop/backup-now.mjs`) and updates it in place.

## 6. Comp the shops already on the hub (5 min)

`https://hub.stitchbench.app/admin` → Shops: give each existing shop free time (comp) so nobody sees "subscribe" when
billing opens. Mark your test-month shops as founding shops when they join.

## 7. Railway config (any time before 1 December, 10 min)

Per project (stitchshop as linked; stitchbench: link, apply, link back), from Bash:
```
powershell -NoProfile -Command '$env:_ = "$env:APPDATA/npm/node_modules/@railway/cli/bin/railway.exe"; railway config apply --yes; railway config migrate --apply'
```
Then delete `railway.json` and commit.

## If something goes wrong

- A deploy fails to build: nothing changes for users (Railway keeps the previous version running). Send Claude the log.
- The hub won't start after the merge: Railway → Deployments → the previous deployment → Redeploy (rolls back).
- Mail doesn't arrive: check spam; on the hub's admin page send a test mail; recheck `SMTP_URL`.
