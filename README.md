# Going open source: the kit and the owner's steps

Decided 11 Oct 2026: StitchBench/StitchShop (AGPL-3.0), StitchHub (already AGPL-3.0) and the website (code MIT,
words and pictures reserved) go public under the GitHub organization `sitesentrix`, owned by the company SiteSentrix.
The software is free; the business is hosting, support and YouTube.

They go public as **new repositories with no old history**: the old commits carry the owner's personal email, links
to private Claude sessions, old copies of the security review and text copied from manuals, and GitHub keeps old
pull-request pages forever. The old repositories stay private, archived, with everything in them.

## What the kit does

`./export.sh` builds, in `out/`, from the private clones' `main`:

- `out/public/stitchbench`, `stitchhub`, `stitchsite`: the code as it is today, minus the private papers; plus
  LICENSE, SECURITY.md, CONTRIBUTING.md and TRADEMARKS.md; public CLAUDE.md/AGENTS.md; the legal drafts without the
  reviewers' notes; links pointing at the organization; the company as the copyright holder and installer publisher.
- `out/notes`: the private papers (HANDOFF, plans, research, legal drafts, the security review, launch checklists,
  the owner's CLAUDE.md), for the private `sitesentrix/notes` repository.
- `out/data`: the four manual-derived files (factory settings, tension specs, manual list, link list), for the private
  `sitesentrix/stitchbench-data` repository. Official builds fetch them with `STITCH_DATA_TOKEN`.

Then `./check.sh` looks for anything private in the public copies (personal email, PC paths, private links, names
from the business notes, reviewer notes, the data files, secrets) and stops on any. `COMMIT=1` makes each folder a
repository with one first commit, authored with the GitHub no-reply address:

```bash
COMMIT=1 AUTHOR_NAME=bwattendorf AUTHOR_EMAIL=1148265+bwattendorf@users.noreply.github.com ./export.sh
```

Variables: `ORG` (sitesentrix), `HOLDER` (SiteSentrix: set it to the exact legal name, e.g. "SiteSentrix LLC"),
`CONTACT` (bwattendorfdev@gmail.com), `YEAR`, and `BENCH_REF` / `HUB_REF` / `SITE_REF` to export from a branch.

## The owner's steps, in order

**1. Merge the fixes first** (Claude prepares them on branches named `before-public`): the hub's security fixes and
StitchBench's. Merge and deploy as usual, and give the hub a day.

**2. The organization and its repositories** (done 11 Oct 2026): organization `SiteSentrix` with `StitchBench`,
`StitchHub` and `StitchSite` (public, the code) and `notes` and `stitchbench-data` (private for good). Delete
`StitchShop` (its code is StitchBench's) and `StitchFoundry`. For the organization's front page, add a public repository
named `.github`: the kit writes its `profile/README.md`. The Claude GitHub app is installed on the organization.

**3. Who pushes what.** A session that holds the old repositories can't also hold the new ones of the same name, so:
this session (or any with the old repositories) runs `COMMIT=1 ./export.sh`, pushes `out/notes` and `out/data` to their
repositories, and pushes the three code folders' commits to `notes` as branches `publish/StitchBench`,
`publish/StitchHub` and `publish/StitchSite`. A fresh session started on the SiteSentrix repositories then fetches
each `publish/` branch from `notes`, runs `./check.sh` on it once more, pushes it to its repository's `main`, and
deletes the `publish/` branches.

**4. The About boxes:** `templates/about.md` has the description, website and topics for each public repository.

**5. A token for the reference data:** github.com → Settings → Developer settings → Fine-grained tokens → Generate:
resource owner `sitesentrix`, only the `stitchbench-data` repository, Contents read-only, one year (put a reminder in
your calendar to renew it). Save it in your Documents with the other keys.

**6. The new `stitchbench` repository's settings** → Secrets and variables → Actions: the secret `STITCH_DATA_TOKEN`
(the token). If code signing is set up by then, copy the signing variables too (`SIGNING_ENABLED`,
`SIGNING_ENDPOINT`, `SIGNING_ACCOUNT_NAME`, `SIGNING_PROFILE_NAME`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`), and in Azure change the app registration's federated credential from
`bwattendorf/stitchbench` to `sitesentrix/stitchbench`.

**7. Railway**, for each of the three services: Settings → Source → connect `sitesentrix/stitchhub` (the hub) or
`sitesentrix/stitchbench` (the `stitchshop` and `stitchbench` services), branch `main`. On the stitchshop and
stitchbench services add the variable `STITCH_DATA_TOKEN`. Each one redeploys: open it, sign in, open a machine page
and check the factory specs are there. In each project's settings, make sure PR environments are off, so a
stranger's pull request can never deploy with your variables.

**8. The PC.** Rename the old folders (`stitchbench` → `stitchbench-old`, `stitchhub` → `stitchhub-old`), clone the
new repositories into `stitchbench`, `stitchhub` and `notes`, copy each `.env` across from the old folder, and run
`npm ci`. The installed program isn't touched.

**9. Public settings** (StitchBench, StitchHub and StitchSite; never `notes` or `stitchbench-data`). In each: Settings → Code
security → turn on private vulnerability reporting, secret scanning and push protection; Settings → Actions → General →
"Require approval for all external contributors" for workflows from forks; Settings → Rules → protect `main` from
force pushes and deletion.

**10. Tidy up.** Archive the old repositories (each: Settings → Archive): they stay private and read-only. GitHub
Settings → Emails: tick "Keep my email addresses private" and "Block command line pushes that expose my email", then
on the PC: `git config --global user.email 1148265+bwattendorf@users.noreply.github.com`.

## Not decided yet

- brandforge: stays as it is until the owner says.
- The company's exact legal name for the copyright lines (HOLDER).
- The free-software change itself (no add-on keys, trial or read-only lapse; billing for hosting and support; the
  site's pricing pages): designed and built after the switch, in the open.
