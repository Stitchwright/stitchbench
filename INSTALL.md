# Installing StitchBench and StitchShop

There are two ways to run StitchBench. Each company picks one and pays its own costs. StitchShop, the same program
for sewing and quilt shops, runs the same two ways: see [Installing StitchShop](#installing-stitchshop-sewing-and-quilt-shops).

| | **Windows program** (on the shop PC) | **Railway** (hosted) |
|---|---|---|
| Monthly cost | none (your own PC) | about $5–10 to Railway |
| Where the data lives | on the shop PC | in Railway's database |
| Other devices | same Wi-Fi, or anywhere through Tailscale | anywhere, at its web address |
| Manuals | read from the shop PC's manuals folder, for every device | each PC connects its own manuals folder (Chrome or Edge) |
| Backups | automatic, every night | Railway database backups, or `pg_dump` |
| The PC has to stay on | yes, for other devices to use it | no |

Both can join the community hub, StitchHub (see [Joining the community hub](#joining-the-community-hub)).

---

## Option 1: Windows program

### You need
- Windows 10 or 11, 64-bit, with 8 GB of RAM recommended
- about 2 GB of disk, plus room for your manuals

### Install
1. Run **`StitchBench Setup <version>.exe`**.
   If Windows shows "Windows protected your PC", choose **More info → Run anyway**. If Smart App Control blocks
   it outright, the installer has to be code-signed (see [Building the installer](#building-the-windows-installer)).
2. Start **StitchBench** from the desktop icon. The first start creates its database, which takes about a minute.
3. The first screen asks for your company name, your name, your email and a password. That creates the company
   and your owner login. Sign-up then closes by itself. It only works in the program's own window on this PC,
   so nobody else on the network can create the company first.
4. When Windows asks whether StitchBench may use the network, tick **Private** only and click **Allow**. Set the
   shop's own Wi-Fi to *Private* in Windows (Settings → Network → Wi-Fi → the network → Private). Leave *Public*
   unticked, so a laptop running StitchBench on café or campground Wi-Fi doesn't serve it to strangers.

StitchBench starts with Windows and keeps running in the tray, next to the clock. Closing the window doesn't
stop it; **Quit StitchBench** in the tray menu does.

### Other devices
The tray icon's **Address for other devices** lists the addresses. Click one to copy it.
- **Same Wi-Fi:** `http://<pc-name>:3100` in any browser, on a laptop, tablet or phone.
- **On the road:** install [Tailscale](https://tailscale.com) (free) on the shop PC and on each laptop or phone,
  signed in to the same account, and use the *Tailscale* address from the tray.
- **Tablets and phones that scan with the camera, or use the copy buttons:** they need the *Secure (https)* address;
  see [HTTPS on the shop network](#https-on-the-shop-network-tablets-and-phones) below.

The Wi-Fi addresses are plain `http://`: sign-ins cross the network unencrypted, so anyone who can listen on that
Wi-Fi could read them. Use them only on a network just for the shop's own devices, with its own password. When
customers share the shop's Wi-Fi (no separate guest network), use the *Tailscale* address on every device instead;
Tailscale encrypts everything, even inside the shop. Wrong passwords slow one account down: after 5 wrong tries
in 15 minutes, further tries for that email are taken one at a time and each waits longer (up to 30 seconds), while
the right password still works. The Windows program has no limit per device, so a device on the Wi-Fi can keep
guessing at different accounts: that is one more reason to keep customers off the shop's own network.

Add each person under **Settings → People**. Everyone signs in with their own email and password.

### HTTPS on the shop network (tablets and phones)

Browsers allow two things only on a *secure* page (an `https://` address, or the shop PC's own window): the **camera
barcode scanner** (register, scan station) and the **one-tap copy buttons**. A tablet or phone on the plain
`http://<pc-name>:3100` address can't use them; the program says so where it matters, names the secure address when it
has one, and the handheld USB / Bluetooth scanners and typed codes keep working regardless. To give the tablets a
secure address:

**Preferred: Tailscale.** It gives the shop PC an `https://<pc>.<tailnet>.ts.net` address with a real certificate,
reachable from every device signed in to your Tailscale network (in the shop and on the road), with nothing to install
on the tablets but Tailscale itself. It's free for personal use and small teams.
1. Install [Tailscale](https://tailscale.com/download) on the shop PC and on each tablet or phone, and sign them all
   in to the same account (the same *tailnet*).
2. In the Tailscale admin console → [DNS](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and
   **HTTPS Certificates** (one click each; the tray item tells you if this is missing).
3. On the shop PC, open the tray menu → **Secure address for tablets (Tailscale)…** and press **Turn on**. The
   program runs `tailscale serve --bg --https=443 http://127.0.0.1:3100`, remembers the choice (`secureUrl` and
   `tailscaleServe` in the settings file), restarts its server for a few seconds, and copies the new address. From then
   on it is listed first under **Address for other devices**, as *Secure (https), for tablets and phones*. If Tailscale
   asks an admin to approve Serve the first time, the dialog shows the link.
4. On each tablet, open that address and bookmark it (add it to the home screen). The first visit can take a few
   seconds while Tailscale fetches the certificate. Sign in as usual; the camera and copy buttons now work.

The same tray item turns it off again (`tailscale serve --https=443 off`). Tailscale keeps the serve setting across
reboots on its own, and the program puts it back if something reset it. The address only answers inside your tailnet:
nothing is opened to the internet. Notes:
- The plain `http://` addresses keep working for the PC itself and for anything that doesn't need the camera.
- The program's own window on the PC is already a secure page; nothing changes there.
- If you also use **Tailscale Funnel** for customer links (`publicUrl`), it must not be on port 443, or the whole
  program would be on the public internet: the tray item refuses in that case. Run the funnel on another port, e.g.
  `tailscale funnel --bg --https=8443 http://127.0.0.1:3101`, and set `publicUrl` to the `:8443` address. The secure
  address and `publicUrl` must differ: `publicUrl`'s host serves only the customer pages.
- Running StitchBench and StitchShop on one PC? Only one program can have port 443. Turn the secure address on for
  one of them; the other can be served by hand on another port (`tailscale serve --bg --https=8444
  http://127.0.0.1:3110`) and its address written into that program's `secureUrl`.

**Fallback: your own certificate (shops without Tailscale).** A certificate the tablets are told to trust also makes
the address secure. The program does not make one itself yet (planned: an https listener on port 3443 with a
certificate the tray can export; it needs the proxy, the certificate generation and the tablet trust steps tested on
iPhone and Android, so it is more than a day and not in this version). Until then, a small reverse proxy on the shop PC
does it; [Caddy](https://caddyserver.com) is the simplest because it makes and trusts a local certificate authority on
its own:
1. Install Caddy on the shop PC (`winget install CaddyServer.Caddy`, or the download from caddyserver.com), make a
   folder such as `C:\Caddy`, and put a file named `Caddyfile` there with:
   ```
   https://<pc-name>:3443 {
     tls internal
     reverse_proxy 127.0.0.1:3100
   }
   ```
   `<pc-name>` is the name tablets reach the PC by (the one in the tray's *This PC's name* address). A fixed IP address
   works too, but the name is safer: certificates are tied to it.
2. In that folder run `caddy run` once as administrator (`caddy trust` installs its root certificate on the PC), then
   install it as a service so it starts with Windows: `caddy start` at login, or a service through `sc create` or
   Task Scheduler. Allow port 3443 on the *Private* network when Windows asks.
3. Copy Caddy's root certificate `%APPDATA%\Caddy\pki\authorities\local\root.crt` to each tablet and trust it:
   - **iPhone / iPad:** AirDrop or email the file, open it, then Settings → General → VPN & Device Management → install
     the profile, then Settings → General → About → Certificate Trust Settings → turn on full trust for it.
   - **Android:** Settings → Security → More security settings → Encryption & credentials → Install a certificate →
     CA certificate → choose the file (the wording differs a little per maker). Chrome trusts it after that.
   - **Windows / Mac laptops:** double-click the file and put it in Trusted Root Certification Authorities (Windows)
     or Keychain → System → Always Trust (Mac).
4. Put the address in the program's settings file, `"secureUrl": "https://<pc-name>:3443"`, and restart StitchBench.
   The tray lists it first and the program names it on tablets that are still on the plain address.

Caddy's root certificate is valid for ten years and the leaf certificates renew themselves. Keep the `pki` folder as
private as the backups: anyone with the root key can impersonate the shop PC to the tablets that trust it.

### When the internet is down
Everything the shop does all day is on the shop PC: tickets, customers, machines, the register, inventory,
manuals, partner jobs already received, and the community notes, links and parts already synced. None of it needs
the internet, and other devices on the shop's own Wi-Fi keep working. What needs the hub waits for the connection:
- Messages to partner shops (a machine taken in, a status change, an order) are kept and sent as soon as the hub
  answers again, in order. Nothing is lost; the other shop just hears about it later.
- Sharing a note, listing something on the marketplace, editing a manual link, "Download to library", and the
  barcode lookup say "No connection to the community hub" within a few seconds instead of hanging.
- The sidebar shows *Offline since <time>* while the hub is out of reach and clears itself once it's back.
- Emails and texts to customers wait in the outbox and go when the connection is back (see Messages below).

### Manuals
Keep manuals in `C:\Manuals` (or change `libraryDir` in the settings file). Every device opens them through
StitchBench, and scans made on any device are saved to `C:\Manuals\_inbox`.

### Backups and restore
- A backup runs every night after 1 am, and at start-up if the last one is more than a day old. The last 30 are
  kept in `Documents\StitchBench Backups`, in folders named `stitchbench-<date>-<time>` (StitchShop's are
  `stitchshop-…`, so both programs can share one backups folder; backups from before 1.4.2 are named `stitchbench-…`
  by both programs, and each program restores the ones in its own folder). `backupsToKeep` in the settings file
  changes how many are kept; `0` keeps them all.
- From the tray: **Back up now**, **Open backups folder**, and **Restore a backup…**. A restore stops StitchBench,
  backs up the current data, and only then replaces it. If that safety backup can't be made (the folder is on a
  drive that isn't connected, or the disk is full), nothing is restored.
- A backup holds the shop's data: customers, machines, tickets, photos, parts, people, prices, shared notes and
  marketplace listings and orders, plus the manual figures and machine pictures. So a backup restored onto a new
  PC brings all of it back. The community hub's shared notes, parts and photos aren't in it; they sync again.
- The tension specs, factory settings and manual list come with the program, not from a backup: a new install
  loads them on its first start, and an update brings in new ones. A restore leaves them as they are.
- Backups are not encrypted, and they hold everything the shop PC does: every customer's details, the staff logins
  (as password hashes, which can be cracked offline) and the key that lets this install act as your shop on the
  community hub and with its partner shops. Keep them as private as the shop PC itself. Don't put the backups folder
  where others can open it, and remember that Windows may sync `Documents` to OneDrive.
- Now and then, copy the backups folder to another drive or a NAS (a private one). You can also set `backupDir` to a
  NAS folder.

### Settings file
Tray → **Settings file** opens `%APPDATA%\StitchBench\config.json`. Restart StitchBench after changing it.
Windows paths need double backslashes in this file: `"libraryDir": "D:\\Manuals"`. If the file has a mistake,
StitchBench says so at start and offers to open it, or to start with the last settings that worked
(`config.json.bak`). The database password and sign-in secret are kept separately in `secrets.json`: don't edit
or delete that file, and include it if you ever copy `%APPDATA%\StitchBench` to another PC. (It also holds
`appDbPassword`, the password of `stitchbench_app`, the limited database login the web server uses; the program
makes it up if it is missing and resets the role's password to it at every start, so that one is never lost.)

| Setting | Meaning |
|---|---|
| `libraryDir` | manuals folder (default `C:\Manuals`) |
| `port` | web port for other devices (default 3100) |
| `backupDir`, `backupsToKeep` | where backups go and how many are kept (default 30; `0` keeps them all) |
| `platformAdminEmails` | emails that see the Companies page (only for hosting several companies) |
| `openAtLogin` | start with Windows |
| `publicUrl` | optional: the https address customers open for estimate and unsubscribe links (a tunnel pointed at the links port); see Messages below |
| `linksPort` | the port that serves only the public pages (default the web port + 1) |
| `secureUrl` | optional: the program's own https address for the shop's tablets and phones (camera, copy buttons); the tray's Tailscale item fills it in, or set it by hand for your own certificate. See [HTTPS on the shop network](#https-on-the-shop-network-tablets-and-phones) |
| `tailscaleServe` | set by the tray's **Secure address for tablets (Tailscale)** item: `true` while it is on (the program puts the serve back if Tailscale lost it) |

### Updating and uninstalling
- **Update:** install the newer version over the old one. The database updates itself on the next start.
- **Uninstall:** Windows Settings → Apps → StitchBench. Your data stays in `%APPDATA%\StitchBench` and your
  backups in `Documents` until you delete them.

---

## Option 2: Railway (hosted)

### You need
- a [Railway](https://railway.com) account (about $5–10 a month for StitchBench and its database)
- the StitchBench code (ask for access to the repository)
- [Node.js 22+](https://nodejs.org) and the Railway CLI (`npm i -g @railway/cli`), or you can do it all in the
  Railway dashboard instead

### Deploy
From the StitchBench folder:

```bash
railway login
railway init --name stitchbench
railway add --database postgres
railway add --service stitchbench \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --variables "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(33).toString('base64'))")" \
  --variables "AUTH_TRUST_HOST=true" \
  --variables "TRUST_PROXY=true" \
  --variables "SEED_SHOP_NAME=Your Shop Name" \
  --variables "SEED_OWNER_NAME=Your Name" \
  --variables "SEED_OWNER_EMAIL=you@example.com" \
  --variables "SEED_OWNER_PASSWORD=a-temporary-password"
railway up --service stitchbench --ci
railway domain --service stitchbench
```

In the dashboard instead: **New Project → Deploy from GitHub repo**, add **PostgreSQL**, set the same
variables on the StitchBench service, then **Settings → Networking → Generate Domain**.

On its first start, StitchBench creates the database tables and loads the factory specs and your owner login, so
the site takes a few minutes to answer. Every start applies database updates first, then skips data that's already
loaded.

Then open the address from `railway domain`, sign in with `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`, change
your password in **Settings**, and add your people under **Settings → People**.

### Variables
| Variable | |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in) |
| `AUTH_SECRET` | a long random secret (keep it private) |
| `AUTH_TRUST_HOST` | `true` |
| `TRUST_PROXY` | `true` on Railway: sign-in limits per device use the address Railway's proxy reports. Leave unset anywhere without a proxy in front |
| `SEED_SHOP_NAME`, `SEED_OWNER_NAME`, `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` | the company and owner login made on the first start |
| `ALLOW_SIGNUP` | leave unset. `true` lets anyone create a company at `/signup` |
| `PLATFORM_ADMIN_EMAILS` | optional: emails that can add companies from the Companies page (hosting several shops) |
| `APP_NAME`, `DEFAULT_SHOP_KIND` | `StitchShop` and `retail` for a StitchShop site (new companies start as sewing shops); leave unset for StitchBench |
| `SEED_SHOP_KIND` | optional: `repair`, `retail` or `both` for the first company (defaults to `DEFAULT_SHOP_KIND`) |
| `DEFAULT_HUB_URL` | optional: the hub a partner code joins when no hub is set (defaults to the StitchHub on Railway) |
| `UPC_LOOKUP`, `UPCITEMDB_KEY` | optional: `off` turns barcode lookups off; a UPCitemdb key uses a paid plan instead of 100 free a day |
| `PUBLIC_URL` | the site's own https address, for customer links (estimate approval, unsubscribe) |
| `SETTINGS_KEY` | a second long random secret: the mail password and Twilio secret are sealed with it (required before a shop can save them) |
| `MESSAGES`, `MESSAGE_WORKER_SECONDS`, `MESSAGE_BATCH`, `READY_NOTICE_DELAY_SECONDS`, `SMTP_ALLOW_HOSTS` | optional; see **Messages** below |

### Manuals on the hosted version
The server can't see your PCs. Each tech connects their manuals folder once in the browser (**My manuals →
Connect folder**, in Chrome or Edge), and StitchBench opens manuals from that PC. Manual figures come from the
community hub, or are drawn from the tech's own copy.

### Backups
Turn on database backups for the Postgres service in the Railway dashboard (on plans that include them). For your
own copies, give the database a public address (Postgres service → **Settings → Networking → TCP Proxy**), then
run `pg_dump` against it with the `DATABASE_PUBLIC_URL` that appears in its variables.

### Updating
Run `railway up --service stitchbench --ci` again, or push to GitHub if the service deploys from a repo. The new
version applies database updates when it starts. Railway switches to it only once `/api/health` answers (it waits up
to 10 minutes), so a version whose database update fails leaves the old one running; the failed deploy's log says why.

### Hosting other shops
One Railway StitchBench can hold several companies, each with its own separate data. Set `PLATFORM_ADMIN_EMAILS`
to your email, and use the **Companies** page to add a company and its owner login. Alternatively, give each
customer their own Railway project, which keeps the bills separate.

A repair shop that sets up **StitchShop** for its partner sewing shops usually hosts them this way: see
[A repair shop hosting StitchShop for its partner shops](#a-repair-shop-hosting-stitchshop-for-its-partner-shops).

---

## Installing StitchShop (sewing and quilt shops)

StitchShop is the same program set up for a sewing or quilt shop's counter: the register, inventory (notions,
fabric by the yard, thread, patterns), and the machines the shop takes in for its repair shop. It has the same two
ways to run, and each shop picks one:

| | **Windows program** (on the shop PC) | **Railway** (hosted) |
|---|---|---|
| Monthly cost | none (your own PC) | about $5–10 to Railway (one hosted copy can hold several shops) |
| Where the data lives | on the shop PC | in Railway's database |
| The register works when the internet is down | yes | no |
| Other devices | same Wi-Fi (`http://<pc-name>:3110`), or Tailscale | anywhere, at its web address |
| Backups | automatic, every night | Railway database backups, or `pg_dump` |

Either way, the shop connects to its repair shop with a **partner code** (see
[Connecting a sewing shop to its repair shop](#connecting-a-sewing-shop-to-its-repair-shop)). The two talk through
StitchHub, so neither needs to reach the other's computer.

### Option 1: StitchShop Windows program
1. Run **`StitchShop Setup <version>.exe`** (built with `npm run dist:stitchshop`, see
   [For maintainers](#for-maintainers)). The same code-signing note as StitchBench applies.
2. Start **StitchShop**. The first screen asks for the shop's name, the owner's name, email and a password; *What
   kind of shop* is already set to **Sewing / quilt shop**. Paste the **partner code** from the repair shop in the
   last box, and the two shops are connected as soon as the shop is created.
3. Allow it on the network when Windows asks (*Private* only, with the shop's Wi-Fi set to Private), so the counter
   tablet or a second PC can use it. The same Wi-Fi advice as StitchBench applies: if customers share the shop's
   Wi-Fi, have the counter devices use the Tailscale address.

It runs in the tray like StitchBench, keeps its own data in `%APPDATA%\StitchShop`, backs up nightly to
`Documents\StitchShop Backups`, and uses port 3110 (database 5449), so StitchBench and StitchShop can share a PC.
The register, repairs desk and inventory work with no internet (see [When the internet is down](#when-the-internet-is-down));
what's for the repair shop goes out when the connection is back.
- **Barcode scanner:** any USB or Bluetooth scanner that types the code and presses Enter works in the register's
  scan box. Phones and tablets can use their camera.
- **Receipts:** print from the receipt page to any printer; an 80 mm receipt printer set up in Windows works.
- **Cards:** run cards on your own card reader (Square, Clover, your bank's terminal) and choose **Card** on the
  register. StitchShop doesn't process cards itself.

### Option 2: StitchShop on Railway
Same steps as [StitchBench on Railway](#option-2-railway-hosted), with a different service name and two more
variables, so new companies start as sewing shops and the site is called StitchShop:

```bash
railway init --name stitchshop
railway add --database postgres
railway add --service stitchshop \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --variables "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(33).toString('base64'))")" \
  --variables "AUTH_TRUST_HOST=true" \
  --variables "TRUST_PROXY=true" \
  --variables "APP_NAME=StitchShop" \
  --variables "DEFAULT_SHOP_KIND=retail" \
  --variables "SEED_SHOP_NAME=Your Shop Name" \
  --variables "SEED_OWNER_NAME=Your Name" \
  --variables "SEED_OWNER_EMAIL=you@example.com" \
  --variables "SEED_OWNER_PASSWORD=a-temporary-password"
railway up --service stitchshop --ci
railway domain --service stitchshop
```

Sign in, change the password, and enter the partner code under **Partner shops → Enter a partner code**.

### A repair shop hosting StitchShop for its partner shops
A repair shop can run one hosted StitchShop and put each partner sewing shop in it as its own company (their data
stays separate), so the shops have nothing to install:
1. Deploy StitchShop on Railway as above, with `PLATFORM_ADMIN_EMAILS` set to your email and the first company
   named for your hosting (for example "Timing & Tension hosting").
2. For each sewing shop: in **your StitchBench** (wherever it runs) open **Partner shops → Make a code for another
   shop**, set the terms, and copy the code.
3. In the hosted StitchShop, **Companies → Add a company**: the shop's name, *Sewing / quilt shop*, the owner's
   name, email and a temporary password, and the partner code. The company is created already connected to you.
4. Give the owner the address and temporary password. They sign in, change it, accept the agreement under
   **Partner shops**, and add their staff under **Settings → People**.

If your StitchBench itself runs in the same hosted copy, **Partner shops → Set up StitchShop for a sewing shop** does
steps 2 and 3 in one form.

### Connecting a sewing shop to its repair shop
- The repair shop makes the code (**Partner shops → Make a code for another shop**), with the terms it offers:
  commission on repairs, consignment split, statements, notice. Codes work once and last 14 days.
- The sewing shop enters it: at sign-up, under **Partner shops → Enter a partner code**, or by the host under
  **Companies**. A shop that isn't on the community hub joins it for partners only; nothing else is shared.
- Both shops accept the agreement under **Partner shops → (the partner) → Agreement**. From then on, machines taken
  in, repair status, estimates, orders, consignment and statements flow between the two by themselves (about every
  minute).

---

## Joining the community hub
StitchHub is the shared community server: manual links, tech notes and photos, and manual figure snapshots. Its
code is public at https://github.com/bwattendorf/stitchhub.

In StitchBench, go to **Settings → Community hub**, paste the invite code (or open the `.stitchhub` invite file),
and press **Join**. StitchBench then syncs every 10 minutes. **Community chat** in the menu opens the community's
Discord.

---

## Your StitchHub account

A shop owner can have an **account on StitchHub**: an email address and a password. The account owns the shop (or
several, for a repair shop that hosts its quilt shops' StitchShop companies) and is where the shop subscribes when
subscriptions open; until then every shop is on a free trial or comped by the hub admin, and nothing changes in the
program. Staff logins inside the program are separate and stay as they are.

**Settings → Account** (owners only) is where it happens:
- **Create your StitchHub account**: your email, and a tick to accept the terms and privacy policy (both pages are on
  the hub and linked there). The hub emails a link to set a password; the page says "waiting for the email" until you
  have, with **Send it again** if nothing arrives. A program that isn't on any hub yet joins the community's hub as
  part of this, with no invite. If the address already has an account, the hub says so: use the next door.
- **I already have an account**: **Show a link code** gives a 10-character code good for 15 minutes. Sign in on the hub
  (the link is on the page) and type it under **Connect a shop**. This needs the program to be on the hub already.
- The page shows what the hub last said about the shop (trial, comped, last day) and what the program itself is
  licensed for, with **Check again** to ask the hub now. The hub tells the program at every sync; the program's own key
  arrives the same way once billing exists and needs no pasting.
- The Windows program also offers **Allow a password reset from my StitchHub account** (off by default; a later
  version uses it).

**If the program's key ever lapses** (a subscription that ended and its 14 days of grace ran out) the program becomes
**read-only**: every page, print and export still works, open tickets can be finished and closed, payments, returns
and voids go through, backups and syncs run; new tickets, sales, parts and edits wait for a new key, which comes from
the account at the next sync (or by email from StitchBench, pasted under Settings → Modules). Nothing is deleted. A
program that never connects to any hub keeps working as it always has.

**A forgotten owner password on the Windows program**: the tray menu's **Reset a password...** lists the logins; pick
one and a new password is made and shown once, on the shop PC's own screen. It needs the PC and nothing else.

---

## Paid modules

StitchBench's extra modules (Vac Shop, Small Appliance Repair, Scheduling, Marketing) are sold by StitchBench,
monthly or yearly. The program itself stays the same; a module is turned on by a **key**: about 350 characters
starting `SB1.`, made for one company and emailed to the shop.

### Adding a key (the shop)
Go to **Settings → Modules**, paste the key (or the whole email it came in) in the box and press **Add key**. That is
all. It works without the internet, on the Windows program and on a hosted copy alike. The page shows each module's
state (on, renewal due, grace period, ended), the key's last day and who it was issued to. A key is bound to the
Company ID shown on that page: it does nothing for another company, and a changed key is refused as damaged.

### Rollout checklist (the owner, before the first release with modules)
1. **Sales contact.** Fill `MODULE_SALES.email` (and `url`, if there is a pricing page) in `src/lib/module-info.ts`.
   While it is empty, the app shows no "Ask about it" link, only "Ask StitchBench about it."
2. **Owner key.** Run `npm run license:keygen -- --kid k1` on your PC. It writes `~/.stitchbench/license-k1.pem`
   (encrypted with the passphrase you type) and prints a `k1: { x: "…", scope: "any" },` line. Paste that line into
   `LICENSE_PUBLIC_KEYS` in `src/lib/license-keys.ts`, commit, and release (Railway and new installers). Until a
   release carries the line, no pasted key works anywhere except on a development server.
3. **Hosting key** (required on the hosted app before modules are released there: it signs the Companies page's
   switch, and its presence turns test keys off). Run `npm run license:keygen -- --kid h1 --hosted`, commit the
   printed `h1` line, and set two Railway variables on the hosted service: `LICENSE_HOSTED_KEY` (the printed base64)
   and `LICENSE_HOSTED_KID=h1`. The first time a server process needs the hosting key, it logs one line if the
   variable doesn't match the compiled `h1`: "LICENSE_HOSTED_KEY doesn't match kid h1 in license-keys.ts: the
   Companies switch can't turn modules on." It keeps running either way.
4. **Selling a module.** The shop presses "Ask about Vac Shop" in Settings → Modules, which emails you with the
   Company ID filled in. Paste that email into `npm run license` (it asks the rest step by step), then send the shop
   the email file it writes.
5. **Self-hosted shops** (their own Railway project, or the Windows program) use pasted keys only. Their Companies
   page explains this; the switch there is for the hosted StitchBench alone.

### The command-line tools
All of them live in `scripts/license/` and run from the repo folder. Only `dev.ts --grant` and `resign-grants.ts`
touch a database.

| Command | |
|---|---|
| `npm run license:keygen -- --kid k1` | the owner's signing key, encrypted; `--out <file>` to put it elsewhere (never inside the repo) |
| `npm run license:keygen -- --kid h1 --hosted` | the hosting key, plain, plus the `LICENSE_HOSTED_KEY` value for Railway |
| `npm run license:keygen -- --dev` | the development key `scripts/license/dev-key.json` (committed on purpose) |
| `npm run license` | asks step by step: Company ID (or the shop's pasted email), name, modules, plan, start date, email, note |
| `npm run license -- --shop <Company ID> --name "…" --modules vac,appliance --plan monthly\|yearly\|trial` | one key from flags; also `--from`, `--until`, `--grace`, `--email`, `--note`, `--key <pem>`, `--log <csv>` |
| `npm run license -- --trial --shop <Company ID> --modules vac` | 14 days from today, no grace |
| `npm run license -- --renew <keyId or Company ID>` | the next period of that customer's latest key: same name, modules, plan and anchor day |
| `npm run license -- --due 30` | keys ending within 30 days with no later key, each with its `--renew` command |
| `npm run license -- --renew-due 7` | `--renew` for every one of those within 7 days |
| `npm run license -- --resend <keyId>` | prints that key and its email again, from the log |
| `npm run license -- --check <key>` | decodes a key and verifies it against `src/lib/license-keys.ts` |
| `npm run license -- --retire-list k1` | the `retired` entry for `k1` (last day and allow list) from the log |
| `npx tsx --conditions=react-server scripts/license/dev.ts --grant <Company ID> --modules vac --from … --until …` | inserts a development key straight into a local database (for tests) |
| `railway run npx tsx --conditions=react-server scripts/license/resign-grants.ts` | re-signs the hosted switch rows after a hosting key rotation (below) |

Renewals keep the customer's **anchor day**: a key that started Jan 31 renews to Feb 27, then Mar 30, then Apr 29, so
the date never drifts. `--until` can override the last day; `--grace` the days after it (default 14, trial 0).

### Where the files live
- `~/.stitchbench/license-<kid>.pem`: your signing key, encrypted with a passphrase. The passphrase is asked for
  each time (nothing is echoed), or read from `STITCH_LICENSE_PASSPHRASE`. Back up the file and keep the passphrase
  somewhere else (a password manager): anyone with both can make keys. `issue` picks the newest `.pem` whose kid is
  in `license-keys.ts` and not retired; `--key` names one explicitly.
- `~/.stitchbench/licenses.csv`: the sales log, one row per key (issued, keyId, companyId, name, email, modules,
  plan, from, until, grace, anchor, note, key). `--due`, `--renew`, `--resend` and `--retire-list` read it.
  `STITCH_LICENSE_LOG` or `--log` points elsewhere.
- `~/.stitchbench/keys/<date>-<keyId>-<name>.txt`: the ready-to-send email for each key.

### Rotating a signing key, and if one leaks
Kids are never deleted from `license-keys.ts`: a deleted kid turns every key it signed into "needs a newer version".
A kid is **retired** instead, keeping its public key:
`k1: { x: "…", scope: "any", retired: { lastDay: "2027-09-30" } }`. A key from that kid whose last day is later is
refused ("This key was replaced").

- **Normal rotation** (a new PC, or a new key every few years): make `k2` with keygen and add its line in a release;
  keep signing with `k1` for about 12 months, until offline Windows installs have updated; then sign with `k2` and
  retire `k1` with `lastDay` = the latest last day `k1` signed (from the sales log).
- **If your private key leaks:** release with `k2` added and `k1` retired with the whole entry printed by
  `npm run license -- --retire-list k1`. Its `allow` list holds the hash of every genuine key in the log, so your
  customers' keys keep working to their end dates while forged ones fail, even backdated ones. Issue `k2` keys at each
  renewal. A PC that hasn't updated yet shows "needs a newer version" on a `k2` key, which tells the shop what to do.
- **Hosting key rotation** (or a leak of it): release with `h2` added (keep `h1`); set the Railway variables
  `LICENSE_HOSTED_KEY` and `LICENSE_HOSTED_KID=h2` (rows signed with `h1` keep counting, because the server still
  holds a genuine hosting key); run `railway run npx tsx --conditions=react-server scripts/license/resign-grants.ts`,
  which re-signs the newest "on" row of every company and module with `h2` (same last day and grace, note
  "re-signed h1→h2", by "system"; running it twice changes nothing); in a later release, retire `h1` with `lastDay` =
  that day.

### Test builds
`STITCH_TEST_BUILD=1 npm run build` makes a build that accepts **development keys** (signed with the committed
`scripts/license/dev-key.json`), for the Playwright specs and local testing. The value is fixed when the app is built
(`next.config.ts`), so a normal build can't be put into test mode at run time. Even a test build accepts development
keys only with no `LICENSE_HOSTED_KEY`, against a database on the same machine (`localhost`), and not on the Windows
program, so the variable changes nothing on the hosted app. When it is on, the server logs
`TEST BUILD: development license keys are accepted` once, and Settings → Modules shows every admin a "Test build"
pill. `next dev` and the check scripts (`npm run check scripts/checks/<name>.check.ts`) accept development keys too.

---

## Messages (email and texts to customers)

With the **Marketing** module on, a shop can email and text its customers: "your machine is ready", estimate approval
by link, uncollected-machine notices, class and appointment confirmations and reminders, service-due and review
requests, and campaigns. With the **Scheduling** module on it gets the calendar, classes, appointments, staff shifts
and partner pickup runs. Everything below is set up by an owner or admin in **Settings → Messages**; nothing is sent
until email or texts are switched on there.

### Email

Any mail account with SMTP works. Pick the provider in Settings → Messages and fill in what it asks:

- **Gmail / Google Workspace**: turn on 2-step verification, make an *app password* (Google Account → Security →
  App passwords) and use that, not the account password. Host `smtp.gmail.com`, port 587, STARTTLS. Google allows
  about 500 messages a day from a normal account; the shop's daily cap (Settings → Messages → Rules) defaults to 300.
- **Microsoft 365 / Outlook.com**: `smtp.office365.com`, port 587, STARTTLS, with an app password when the account
  has multi-factor sign-in. "Authenticated SMTP" must be allowed for the mailbox (an admin setting).
- **Fastmail, a web host, or a transactional provider** (Postmark, SendGrid, Mailgun, Amazon SES): their SMTP host,
  port 587 (STARTTLS) or 465 (TLS), and the user name and password or API key they give you.

The **From address** is fixed in Settings (one per shop) and every email says who it is from. A **Reply-to** address
is optional for notices and required for marketing email on the Windows program: unsubscribe requests arrive there as
replies, and an admin ticks "Someone reads this mailbox at least once a week". Every marketing email carries the shop's
**postal address** (the law requires it): fill it in under Rules, or it uses the shop address from Settings.

Hosted (Railway): the mail server must be a public host with a certificate; a private or plain-text server is refused
unless the operator lists it in `SMTP_ALLOW_HOSTS`. Railway does not offer port 25: use the provider's submission port
(587 or 465) with a login, which every provider above does.

### Texts (Twilio)

Texts go through a Twilio account the shop owns. Settings → Messages asks for the Account SID, an Auth Token (or an
API key SID and secret) and the Twilio number; "Send me a test" proves it works. Before texts can be switched on an
admin confirms the shop's time zone, because texts only go out between 9:00 am and 8:00 pm shop time (quiet hours,
changeable under Rules).

- **Registration.** US carriers block business texts from unregistered numbers. A local (10-digit) number must be
  registered for **A2P 10DLC** in the Twilio console (a brand and a campaign; a sole proprietor option exists for very
  small shops); a toll-free number needs **toll-free verification** instead. Until that is done, sends fail with carrier
  error 30034 and the program pauses texts after five such failures in a day and says why.
- **Consent.** Notices about the customer's own repair or booking go to anyone who asked to be told by text. Marketing
  texts need the customer's prior written consent, recorded in the program (the counter tablet form or the paper form
  under Settings → Messages → Rules, with its code). An import never gives it.
- **STOP / HELP.** Every marketing text ends "Reply STOP to opt out." A STOP reply stops every text to that number,
  HELP gets the shop's name and phone, and any other reply shows under Messages → Replies for staff to read. Only the
  customer's START lifts a STOP.
- Marketing texts also respect the number's own time zone and go to US numbers only.

### The Windows program's public address

Customer links (estimate approval, one-click unsubscribe) need an address the customer's phone can open. The Windows
program serves **only the public pages** on a second port, the *links port* (`linksPort` in the settings file,
default the web port + 1, so 3101), and only when `publicUrl` is set. Point a tunnel at that port (Cloudflare Tunnel,
Tailscale Funnel, ngrok, or a port forward with a certificate) and put its https address in `publicUrl`. A Tailscale
Funnel must not be on port 443 if the tray's secure address for tablets is on (that one is the program itself, on 443):
use e.g. `tailscale funnel --bg --https=8443 http://127.0.0.1:3101`. Without a
public address everything still works: estimates say "reply to this text or call us", and unsubscribes arrive by
reply. Hosted installs set `PUBLIC_URL` to their own address.

### When the internet is down

- Messages wait in the outbox and go when the connection is back, in order; a ready notice is never lost.
- Reminders are only sent up to two hours before the class or appointment; after that they expire quietly.
- Texts held past quiet hours go out the next morning. Marketing older than 48 hours waits for a person to press
  "Send them" on the Messages page.
- Replies and delivery results are read when the connection is back; nothing is sent twice.

### What is kept, and for how long

The program keeps every message it sent or tried to send, every text reply, every consent event and every opt-out, and
does not delete them. Keep them: a texting dispute can be raised for **four years** (the TCPA's limitation period), so
`ConsentEvent` and `Suppression` must never be purged and the outbox (`OutMessage`) and replies (`InboundText`) should
be kept at least that long. Backups include them; a restore carries opt-outs across and puts marketing on hold until an
admin has looked.

### Variables for messages and scheduling

All optional. The Windows program sets the ones it needs from its settings file.

| Variable | Default | Meaning |
|---|---|---|
| `MESSAGES` | on | `off` stops every send path (timers, "Send now", tests): for a copy of the database you don't want to message anyone from |
| `MESSAGE_WORKER_SECONDS` | 30 | how often the worker looks for messages to send |
| `MESSAGE_BATCH` | 20 | messages per shop, per channel, per run |
| `READY_NOTICE_DELAY_SECONDS` | 120 | how long a ready notice waits so a mistaken status click can be undone |
| `PUBLIC_URL` | | the public https address for customer links, the booking page and the online shop (hosted installs; the Windows program takes it from `publicUrl`). Without it the hosted booking page and shop have no address and checkout refuses |
| `PUBLIC_LINKS_ONLY` | | `true`: requests whose Host is `PUBLIC_URL`'s host get only the public pages (always on in the Windows program) |
| `SETTINGS_KEY` | `AUTH_SECRET` | the key the mail password and Twilio secret are sealed with; **required on a hosted production build** |
| `SETTINGS_KEY_PREVIOUS` | | the old `SETTINGS_KEY` while rotating keys (read only; values are re-sealed with the new one) |
| `SMTP_ALLOW_HOSTS` | | `host:port` list of private or plain mail servers a hosted install may use (tests: the sink) |
| `TWILIO_API_BASE` | `https://api.twilio.com` | tests only: the Twilio mock |
| `STRIPE_SECRET_KEY` | | the hosted service's own Stripe account, for shops that choose "through StitchShop's account" in Settings → Online shop (with `STRIPE_WEBHOOK_SECRET`; its webhook is `/api/shop/stripe/platform`). Shops using their own Stripe account need neither |
| `STRIPE_WEBHOOK_SECRET` | | the signing secret of that platform webhook |
| `STRIPE_API_BASE` | `https://api.stripe.com` | tests only: the Stripe mock |

## For maintainers

### Building the installers on GitHub
The **Windows installers** workflow (`.github/workflows/installers.yml`) builds `StitchBench Setup <version>.exe`
and `StitchShop Setup <version>.exe` on GitHub's Windows machines: **Actions → Windows installers → Run workflow**
(or push a tag like `v1.4.1`), then download them from the run's **Artifacts** (kept 7 days). Set the version in
`desktop/package.json` first. From the command line: `gh workflow run installers.yml`, then
`gh run download <run id> -n installers`.

### Building the Windows installer
```bash
npm install
cd desktop
npm install
node prepare-app.mjs                 # builds the app into desktop/server (with the database migrations)
npm run installer                    # → desktop/dist/StitchBench Setup <version>.exe
npm run installer:stitchshop         # → desktop/dist-stitchshop/StitchShop Setup <version>.exe (same program, StitchShop name and defaults)
```

Set the version in `desktop/package.json`. Windows Smart App Control and SmartScreen block or warn about
unsigned installers, so sign them before shops install them.

#### Signing the installers

Two ways work with the GitHub workflow; the first is cheaper and needs no hardware token.

1. **Microsoft Trusted Signing** (about $10 a month; an Azure subscription and a verified identity, which takes a few
   days). Make a Trusted Signing account and a certificate profile in Azure, then an app registration with a client
   secret that has the "Trusted Signing Certificate Profile Signer" role. Add to `desktop/package.json` under `build.win`:
   `"azureSignOptions": { "publisherName": "<the name on the certificate profile>", "endpoint": "https://<region>.codesigning.azure.net", "certificateProfileName": "<profile>", "codeSigningAccountName": "<account>" }`,
   and give the workflow the secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (electron-builder reads
   them). Remove the `CSC_LINK` lines from the workflow in that case.
2. **A code-signing certificate file** (OV or EV from a certificate authority; since 2023 these come on a hardware token
   or in a cloud HSM, so a plain `.pfx` is only possible with some providers' cloud signing). Store the `.pfx` as base64
   in the repository secret `WIN_CSC_LINK` and its password in `WIN_CSC_KEY_PASSWORD`; the workflow passes them to
   electron-builder, which signs both installers. With the secrets empty the installers are built unsigned, as today.

Either way, the first signed release still shows SmartScreen's "unknown publisher" warning until the certificate has
built up reputation (EV certificates and Trusted Signing skip that). Keep signing every release with the same identity.

### Updating an installed program without a new installer
Stop StitchBench (tray → Quit). Copy `desktop/server` over
`%LOCALAPPDATA%\Programs\StitchBench\resources\server`, and every program file listed in `desktop/package.json`
(`build.files`: `main.mjs`, `migrate.mjs`, `backup.mjs`, `reference.mjs`, `app-role.mjs`, `links-gate.mjs`,
`tailscale.mjs`) into `%LOCALAPPDATA%\Programs\StitchBench\resources\app`, then start StitchBench again
(`scripts/local-test/update_installed.ps1 -Version <v>` does all of this). It applies
any database updates and new reference data by itself.

### Tools in `desktop/`
| Script | |
|---|---|
| `backup-now.mjs` | back up the running program's shop data |
| (all of them) | act on StitchBench; set `SB_FLAVOR=stitchshop` to act on StitchShop |
| `join-hub.mjs <hub url> <join key>` | join a community hub from the command line (an https address; http only for a hub on this PC) |
| `push-figures.mjs` | upload this program's figure snapshots to the hub |
| `import-from-dev.mjs <database url> [--replace]` | replace the program's shop data with another StitchBench database's (not a merge). A program that already has a company needs `--replace`, and its current data is backed up first |

### Reloading factory specs into a program
The program loads the specs, factory settings and manual list that ship with it by itself. To load a newer set
from the repo without a new version, take the program's database address from `dbPort` in
`%APPDATA%\StitchBench\config.json` and `dbPassword` in `%APPDATA%\StitchBench\secrets.json`
(`postgresql://stitchbench:<dbPassword>@127.0.0.1:<dbPort>/stitchbench`), then run:
```bash
DATABASE_URL=<that address> npx tsx prisma/seed.ts
DATABASE_URL=<that address> npx tsx scripts/library/upload-media.ts     # figures and machine pictures, if you have them
```
