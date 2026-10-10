# Launch checklist: the next two weeks (from 3 Oct 2026)

The goal: StitchBench and StitchShop running, the website live, billing ready, and one or two shops starting their
month of real use. Each step says who does it and roughly how long. "Claude" steps happen in a session with you at
the keyboard for anything that touches your accounts or deploys. Details for every step are in `docs/HANDOFF.md`.

## Week 1: get it running

**Order early (it takes days to arrive)**
- [ ] **Code-signing** for the Windows installer (you, 30 min to apply). First try **Azure Trusted Signing** (about
      $10 a month, no hardware, and GitHub's installer build can sign every release itself); Microsoft verifies the
      business, so apply as Timing & Tension or as yourself if the business is too new. If it says no: a Sectigo OV
      certificate through SSL.com (about $130 to $250 a year plus eSigner cloud signing or your own YubiKey 5 FIPS).
      Until it's done, test shops use the hosted version; an unsigned installer needs "More info", "Run anyway", and
      Smart App Control blocks it outright.
      Steps and the repo variables: `docs/CODE_SIGNING.md` (the workflow is ready, off until `SIGNING_ENABLED`).
- [ ] **A lawyer** for the terms and privacy drafts (`docs/legal/`, with the questions marked `[LAWYER: ...]`). Book
      the review now; the manual-repository questions can come later.

- [ ] **Register a copyright agent** at the US Copyright Office ($6, online) and set up a takedown email address; the
      lawyer's review should include the manual repository's questions. Both gate the repository, which comes right
      after the test month.

**Day 1-2: review and deploy what's built** (you start it, Claude fixes)
- [ ] Run the code review on `review-part2` (`git checkout review-part2`, then `/ultrareview`), and on the work since
      (Claude splits it to fit). Claude fixes the findings.
- [x] Push to main and deploy both hosted services (the commands are in the chat when it's time).
- [x] (Done 9 Oct 2026 through `scripts/railway-docker.ps1`: both services 1 company, 0 listings, 0 orders, so L6
      is moot.) Right after that deploy, at the PC's terminal (not over Remote Control), one read-only count for review item L6
      (prints three numbers per service; send them to Claude; if every "with no company" is 0 the fix isn't needed):
      `railway ssh -p 10264d2c-c4d5-4f20-9604-4f72c672005b -e production -s stitchbench -- node scripts/hosted/count-unassigned-market.mjs`
      and the same with `-p 2426d0d0-b2af-4f64-bff8-1db1ee1305ae` and `-s stitchshop`.

**Day 2: domains** (you, 30 min)
- [x] Buy **stitchbench.app** and **stitchshop.app** at Namecheap; auto-renew on. (Done 4 Oct 2026, $33.84 for all three.)
- [x] Also buy **timingandtension.com** for the repair business (spelled timing-and-tension; it's on the business card
      and Denise's tour pitch will show it once it's yours). Same Cloudflare move.
- [x] Make a free **Cloudflare** account and move the domains' nameservers to it. (Done 5 Oct 2026: all three on the
      bwattendorfdev@gmail.com Cloudflare account, free plan, nameservers dina and mario.ns.cloudflare.com.)

**Day 3: the website live** (together, 1 hour)
- [ ] A private GitHub repository for the site (`C:\Users\bwatt\stitchsite`), connected to Cloudflare Pages.
- [x] The site is live on stitchbench.app and www (5 Oct 2026): private repo bwattendorf/stitchsite, Cloudflare
      Pages project `stitchbench`, uploaded with wrangler from `out/`. stitchshop.app and www forward to
      stitchbench.app/stitchshop/ (the site's `functions/_middleware.js`; other paths keep their path). Fill in your business's legal name
      for the footer, and decide whether hosted costs the same $25 as Windows.
- [ ] Keep `LIVE = false` (search engines stay out) until the test month is done.

**Day 4-5: the hub goes live with accounts** (together, an evening; step by step in `docs/HUB_DAY.md`)
- [x] Email for the hub's account mail: a sending address (`MAIL_FROM`) and a mail service (`SMTP_URL`; a Gmail app
      password works to start, a service like Postmark or Resend is better for delivery).
- [x] Point **hub.stitchbench.app** at the hub on Railway (`HUB_URL`).
- [x] Generate the hub's signing key (Claude runs it and writes the private half to a file in your Documents, never
      into chat); you paste it into the hub's Railway variables; Claude adds the public line to the programs.
- [x] Release both programs with that public key line, then merge and deploy the hub branch.
- [x] (Done 9 Oct 2026: only the owner's own shops were on the hub.) Comp every shop already on the hub (the hub's admin page), so nobody gets a surprise when billing opens.
- [ ] Uptime alerts (you, 10 min, free): make an account at uptimerobot.com, then **Add New Monitor** three times,
      type HTTP(s), every 5 minutes, alert by email: `https://hub.stitchbench.app/health`,
      `https://stitchshop-production.up.railway.app/api/health`, `https://stitchbench-production-e554.up.railway.app/api/health`.
      You get an email when one stops answering and another when it's back.
- [ ] Any time before 1 December: apply the Railway config (two commands, in `docs/HANDOFF.md` item 14).
- [ ] `FEEDBACK_EMAIL` on the hub's Railway service (Variables): your address, so Help messages, ideas and ratings
      reach your inbox too (without it they show only on the hub's admin page).
- [ ] Back up `Documents\StitchBench release key.txt` off this PC (a USB stick kept away from the PC, or a secure
      note in your password manager; never a cloud folder). Lost key = every shop reinstalls by hand.
- [ ] The hub's file storage (you, 15 min, free; Claude can walk you through it): a Cloudflare account, an R2 bucket
      `stitchhub`, an API token with Object Read & Write on it, then on the hub's Railway service the variables
      `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. It keeps the program updates (and
      later the off-site backups and manuals). This is the same Cloudflare account as Day 8's downloads.
- [ ] Then the one-button update test (together, 20 min): Claude publishes the test 1.7.2 (built 10 Oct from branch
      `update-test-1.7.2`; its installers are kept until 17 Oct, rebuild after) with
      `scripts/release/publish-release.mjs`; you press **Update now** on this PC (on 1.7.1). Expected here: download,
      genuine-check and backup work, then Smart App Control blocks the unsigned installer. The last step needs a PC
      without Smart App Control, or the signed installers. Withdraw 1.7.2 on the hub's admin page afterwards.

## Week 2: ready for test shops and money

**Day 6-7: Stripe** (you in the dashboard, Claude alongside, an evening)
- [ ] Test mode first: the online shop's test purchase on hosted StitchShop (card 4242 4242 4242 4242).
- [ ] Hub billing: one product per plan with its prices (Solo $25/month and $250/year, Shop $45 and $450, and the
      four founding prices $15 / $150 and $30 / $300), their ids in the hub's eight `STRIPE_PRICE_*` variables (names
      in HANDOFF 2ad), the webhook to the hub with its **ten** events (the hub README lists them; `charge.dispute.closed`
      and `charge.dispute.updated` are new), the Customer Portal settings for switching plans (hub README). Test a subscription with a test card,
      including one during the trial (no charge until the trial ends). Then switch to live keys.
- [ ] Customer Portal: set plan switching to invoice immediately (or turn plan switching off there, so every switch
      goes through the hub's own Switch button, which charges an upgrade at once). Good to know: a full refund now
      cancels the shop's subscription; for a goodwill refund where the shop stays, refund part of the payment.
- [ ] In Stripe's Billing settings, turn on the reminder email before a free trial ends, so no shop is surprised by
      its first charge (a lawyer question too: some states require that notice for automatic renewals).

**Day 8: installers people can download** (together, 1 hour)
- [ ] An R2 bucket in Cloudflare for downloads; the StitchBench and StitchShop installers at
      downloads.stitchbench.app (signed once the certificate arrives).

**Day 8-9: check things on this PC** (you, an hour)
- [ ] The Tailscale tray item for tablets, a manual download, "Restore a company", the tray's password reset.
- [ ] Look over `C:\Manuals\_business-notes\Service_Modes.xlsx` and try the eight things its notes list on real
      machines when you have them on the bench.

**Day 10-14: the first test shops**
- [ ] Pick one or two shops (from the shop hop!). Set them up together: the founding-shop offer, their data
      imported from their spreadsheets, a 30-minute walkthrough.
- [ ] The month of real use starts. They run a fixed release; only fixes go out; Claude keeps building the queued
      features behind it.

**After hub day and Stripe day: reach out**
- [ ] Sewing Machine Repair Guy (Wes): email sent 5 Oct with the tech tour; follow up with a founding account offer.
- [ ] Sewing Doc Academy (you're a member and graduate): write to Andi Barney as a graduate who built StitchBench;
      offer her certified techs a founding-shop deal; later, StitchBench as the business school's recommended
      software. Meanwhile attend their free member open houses and listen.

## Can wait until after the test month
- An Anthropic key on the hub for the Assistant.
- Stripe Connect for the online shop, Stripe Terminal card readers.
- Reward cards.

## Not your job
Everything else on the list (the Assistant, the later-round features, round-3 leftovers, tests) Claude keeps building
on the branch, and it waits for your review before it ships.
