# Launch checklist: the next two weeks (from 3 Oct 2026)

The goal: StitchBench and StitchShop running, the website live, billing ready, and one or two shops starting their
month of real use. Each step says who does it and roughly how long. "Claude" steps happen in a session with you at
the keyboard for anything that touches your accounts or deploys. Details for every step are in `docs/HANDOFF.md`.

## Week 1: get it running

**Order early (it takes days to arrive)**
- [ ] **Code-signing certificate** for the Windows installer (you, 30 min to order). An OV certificate from a
      reseller such as SSL.com or Sectigo; validation of your business takes several days, and certificates now come
      on a hardware token or a cloud signing service. Until it arrives the installer works but Windows warns "unknown
      publisher". Needs your business's legal name and address.
- [ ] **A lawyer** for the terms and privacy drafts (`docs/legal/`, with the questions marked `[LAWYER: ...]`). Book
      the review now; the manual-repository questions can come later.

**Day 1-2: review and deploy what's built** (you start it, Claude fixes)
- [ ] Run the code review on `review-part2` (`git checkout review-part2`, then `/ultrareview`), and on the work since
      (Claude splits it to fit). Claude fixes the findings.
- [ ] Push to main and deploy both hosted services (the commands are in the chat when it's time).
- [ ] Right after that deploy, at the PC's terminal (not over Remote Control), one read-only count for review item L6
      (prints three numbers per service; send them to Claude; if every "with no company" is 0 the fix isn't needed):
      `railway ssh -p 10264d2c-c4d5-4f20-9604-4f72c672005b -e production -s stitchbench -- node scripts/hosted/count-unassigned-market.mjs`
      and the same with `-p 2426d0d0-b2af-4f64-bff8-1db1ee1305ae` and `-s stitchshop`.

**Day 2: domains** (you, 30 min)
- [ ] Buy **stitchbench.app** and **stitchshop.app** at Namecheap; auto-renew on.
- [ ] Also buy **timingandtension.com** for the repair business (spelled timing-and-tension; it's on the business card
      and Denise's tour pitch will show it once it's yours). Same Cloudflare move.
- [ ] Make a free **Cloudflare** account and move both domains' nameservers to it (one setting each at Namecheap).

**Day 3: the website live** (together, 1 hour)
- [ ] A private GitHub repository for the site (`C:\Users\bwatt\stitchsite`), connected to Cloudflare Pages.
- [ ] stitchbench.app on the site, stitchshop.app redirecting to /stitchshop/. Fill in your business's legal name
      for the footer, and decide whether hosted costs the same $25 as Windows.
- [ ] Keep `LIVE = false` (search engines stay out) until the test month is done.

**Day 4-5: the hub goes live with accounts** (together, an evening)
- [ ] Email for the hub's account mail: a sending address (`MAIL_FROM`) and a mail service (`SMTP_URL`; a Gmail app
      password works to start, a service like Postmark or Resend is better for delivery).
- [ ] Point **hub.stitchbench.app** at the hub on Railway (`HUB_URL`).
- [ ] Generate the hub's signing key (Claude runs it and writes the private half to a file in your Documents, never
      into chat); you paste it into the hub's Railway variables; Claude adds the public line to the programs.
- [ ] Release both programs with that public key line, then merge and deploy the hub branch.
- [ ] Comp every shop already on the hub (the hub's admin page), so nobody gets a surprise when billing opens.
- [ ] Any time before 1 December: apply the Railway config (two commands, in `docs/HANDOFF.md` item 14).

## Week 2: ready for test shops and money

**Day 6-7: Stripe** (you in the dashboard, Claude alongside, an evening)
- [ ] Test mode first: the online shop's test purchase on hosted StitchShop (card 4242 4242 4242 4242).
- [ ] Hub billing: one product per plan with its prices (Solo $25/month and $250/year, Shop $45 and $450, and the
      four founding prices $15 / $150 and $30 / $300), their ids in the hub's eight `STRIPE_PRICE_*` variables (names
      in HANDOFF 2ad), the webhook to the hub with its **ten** events (the hub README lists them; `charge.dispute.closed`
      and `charge.dispute.updated` are new), the Customer Portal settings for switching plans (hub README). Test a subscription with a test card,
      including one during the trial (no charge until the trial ends). Then switch to live keys.
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

## Can wait until after the test month
- The manual repository's setup: register a copyright agent ($6 at the Copyright Office), a takedown email, the
  lawyer's answers on the repository questions.
- An Anthropic key on the hub for the Assistant.
- Stripe Connect for the online shop, Stripe Terminal card readers.
- Reward cards.

## Not your job
Everything else on the list (the Assistant, the later-round features, round-3 leftovers, tests) Claude keeps building
on the branch, and it waits for your review before it ships.
