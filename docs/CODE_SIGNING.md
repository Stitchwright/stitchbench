# Code signing the installers

**Status:** 2026-10-20. Written with the workflow change; not yet run on GitHub (see "Test run" at the end).

The installers workflow (`.github/workflows/installers.yml`) signs the Windows and macOS programs. Signing credentials
live in the GitHub environment **`release`**, which allows only the `release` branch and `v*` tags and holds 12 secrets.
A run from any other ref, or with a secret missing, builds **unsigned** and shows a warning in the run's summary: it
never fails for want of a secret.

## The secrets (environment `release`)

| Used for | Secrets |
|---|---|
| Windows (Azure Artifact Signing) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE` |
| macOS (Developer ID, notarization) | `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` |
| macOS keychain | `KEYCHAIN_PASSWORD`: protects the temporary keychain the workflow imports the certificate into |

Secrets are never in the repository. Only the checking step and the signing steps receive them; the steps that install
packages (which run every dependency's install scripts) get none.

## Windows

Jobs: `build` (no secrets) makes the two programs **unpacked** (`npm run unpacked`, `unpacked:stitchshop`) and keeps them
for a day. `sign` (environment `release`):

1. signs `StitchBench.exe` and `StitchShop.exe` in the unpacked folders with `azure/artifact-signing-action`;
2. packs the NSIS installers from the signed folders (`electron-builder --prepackaged`, `installer:prepackaged`);
3. signs the two installers;
4. checks all four files with `Get-AuthenticodeSignature` (Valid and timestamped) and fails the run if any is not.

Not signed: the files that ship beside the program (the embedded Postgres, DLLs) and the uninstaller NSIS builds into
the installer. If Smart App Control objects to those, the next step is a signing hook in `win.sign` that signs every
file electron-builder packs.

## macOS

`mac` (environment `release`) first imports the certificate into a keychain of its own (`build.keychain`, protected by
`KEYCHAIN_PASSWORD`; electron-builder's own temporary keychain failed at `set-key-partition-list` on the runner in the
2026-10-20 test) and checks the Developer ID Application identity is in it. It then runs `electron-builder` with
`CSC_KEYCHAIN` (that keychain) and `CSC_NAME` (the identity), plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` =
`APPLE_PASSWORD` and `APPLE_TEAM_ID` for notarization. The keychain is deleted at the end of the job.
`desktop/package.json` (`build.mac`) turns on `hardenedRuntime` and `notarize`, with the entitlements Electron needs in
`desktop/build/entitlements.mac.plist` (JIT, unsigned executable memory, and library validation off so the program can
start its own Postgres). The job then mounts each `.dmg` and runs `codesign --verify --deep --strict`,
`stapler validate` and `spctl --assess` (it fails if Gatekeeper rejects the app). Notarization waits for Apple and can
take several minutes. Without the secrets the job passes `-c.mac.identity=null -c.mac.notarize=false`.

## Linux

Not signed. `SHA256SUMS.txt` on the release lists every file's checksum.

## How to check a signature

- Windows: right-click the file → Properties → Digital Signatures, or `Get-AuthenticodeSignature <file> | Format-List`.
- macOS: `codesign -dv --verbose=2 <app>`, `xcrun stapler validate <app>`, `spctl --assess --type execute -v <app>`.

## Repository variables the old setup used (delete them)

Settings → Secrets and variables → Actions → **Variables**: `SIGNING_ENABLED`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `SIGNING_ENDPOINT`, `SIGNING_ACCOUNT_NAME`, `SIGNING_PROFILE_NAME`. The repository **secrets**
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (the old certificate-file fallback), if present, are not used any more either.
The Entra app registration no longer needs its GitHub federated credential (the workflow no longer logs in with OIDC).

## Cost

Azure Artifact Signing Basic is about $9.99 a month; the Apple Developer Program is $99 a year. Check current prices.

## Revision history

- 2026-10-20: macOS imports the certificate into its own keychain (CSC_KEYCHAIN, CSC_NAME) after run 14's keychain failure.
- 2026-10-20: secrets in the `release` environment, programs signed before packing, macOS signed and notarized.
- Earlier: Windows installers only, OIDC login, repository variables.
