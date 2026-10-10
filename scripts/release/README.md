# Publishing a program release

Design: `docs/plans/ease-of-use-design.md` section 1.

## One time

`node scripts/release/make-release-key.mjs`

Saves the private key to `Documents\StitchBench release key.txt` (it refuses if that file exists; never share it,
back it up somewhere safe) and writes the public key into `desktop/release-key.mjs`. Commit that file. Programs built
with a public key accept updates signed by it; a build with `null` refuses to update. If the key is lost, every
installed program has to be reinstalled by hand once.

## Each release

1. Bump `desktop/package.json` version, add the version's lines to `src/lib/whats-new.ts`, build both installers
   (GitHub Actions), download the `.exe` files.
2. For each program:
   `node scripts/release/publish-release.mjs --flavor stitchbench --version 1.7.1 --file "C:/path/StitchBench-Setup-1.7.1.exe"`
   (same with `--flavor stitchshop`). It signs the file, uploads it to the hub's storage and publishes it. Use
   `--url https://...` instead of uploading if the installer is hosted elsewhere; `--hub` points at another hub.
   The hub admin token is read from `Documents\StitchHub admin.txt` (or `HUB_ADMIN_TOKEN`) and never printed.
3. Within 6 hours owners and admins see "A new version is ready" in the program. The tray's "Check for a new
   version" does it at once.
