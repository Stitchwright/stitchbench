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
   and your owner login. Sign-up then closes by itself.
4. When Windows asks whether StitchBench may use the network, click **Allow** with both *Private* and *Public*
   ticked, so other devices can connect.

StitchBench starts with Windows and keeps running in the tray, next to the clock. Closing the window doesn't
stop it; **Quit StitchBench** in the tray menu does.

### Other devices
The tray icon's **Address for other devices** lists the addresses. Click one to copy it.
- **Same Wi-Fi:** `http://<pc-name>:3100` in any browser, on a laptop, tablet or phone.
- **On the road:** install [Tailscale](https://tailscale.com) (free) on the shop PC and on each laptop or phone,
  signed in to the same account, and use the *Tailscale* address from the tray.

Add each person under **Settings → People**. Everyone signs in with their own email and password.

### Manuals
Keep manuals in `C:\Manuals` (or change `libraryDir` in the settings file). Every device opens them through
StitchBench, and scans made on any device are saved to `C:\Manuals\_inbox`.

### Backups and restore
- A backup runs every night after 1 am, and at start-up if the last one is more than a day old. The last 30 are
  kept in `Documents\StitchBench Backups`.
- From the tray: **Back up now**, **Open backups folder**, and **Restore a backup…**. A restore first backs up
  the current data.
- A backup holds the shop's own data: customers, machines, tickets, photos, parts, people, prices and shared
  notes. Factory specs come with the program.
- Now and then, copy the backups folder to another drive or a NAS. You can also set `backupDir` to a NAS folder.

### Settings file
Tray → **Settings file** opens `%APPDATA%\StitchBench\config.json`. Restart StitchBench after changing it.

| Setting | Meaning |
|---|---|
| `libraryDir` | manuals folder (default `C:\Manuals`) |
| `port` | web port for other devices (default 3100) |
| `backupDir`, `backupsToKeep` | where backups go and how many are kept |
| `platformAdminEmails` | emails that see the Companies page (only for hosting several companies) |
| `openAtLogin` | start with Windows |

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
| `SEED_SHOP_NAME`, `SEED_OWNER_NAME`, `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` | the company and owner login made on the first start |
| `ALLOW_SIGNUP` | leave unset. `true` lets anyone create a company at `/signup` |
| `PLATFORM_ADMIN_EMAILS` | optional: emails that can add companies from the Companies page (hosting several shops) |
| `APP_NAME`, `DEFAULT_SHOP_KIND` | `StitchShop` and `retail` for a StitchShop site (new companies start as sewing shops); leave unset for StitchBench |
| `SEED_SHOP_KIND` | optional: `repair`, `retail` or `both` for the first company (defaults to `DEFAULT_SHOP_KIND`) |
| `DEFAULT_HUB_URL` | optional: the hub a partner code joins when no hub is set (defaults to the StitchHub on Railway) |
| `UPC_LOOKUP`, `UPCITEMDB_KEY` | optional: `off` turns barcode lookups off; a UPCitemdb key uses a paid plan instead of 100 free a day |

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
version applies database updates when it starts.

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
3. Allow it on the network when Windows asks (both *Private* and *Public*), so the counter tablet or a second PC can
   use it.

It runs in the tray like StitchBench, keeps its own data in `%APPDATA%\StitchShop`, backs up nightly to
`Documents\StitchShop Backups`, and uses port 3110 (database 5449), so StitchBench and StitchShop can share a PC.
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
unsigned installers, so sign it with a code-signing certificate or with Microsoft's Trusted Signing service (see
electron-builder's `win` signing options).

### Updating an installed program without a new installer
Stop StitchBench (tray → Quit). Copy `desktop/server` over
`%LOCALAPPDATA%\Programs\StitchBench\resources\server`, then start StitchBench again. It applies any database
updates by itself.

### Tools in `desktop/`
| Script | |
|---|---|
| `backup-now.mjs` | back up the running program's shop data |
| `join-hub.mjs <hub url> <join key>` | join a community hub from the command line |
| `push-figures.mjs` | upload this program's figure snapshots to the hub |
| `import-from-dev.mjs <database url>` | copy shop data from another StitchBench database into the program |

### Reloading factory specs into a program
Take the program's database address from `%APPDATA%\StitchBench\config.json`
(`postgresql://stitchbench:<dbPassword>@127.0.0.1:<dbPort>/stitchbench`), then run:
```bash
DATABASE_URL=<that address> npx tsx prisma/seed.ts
DATABASE_URL=<that address> npx tsx scripts/library/upload-media.ts     # figures and machine pictures, if you have them
```
