# Code signing the Windows installers

The installers workflow (`.github/workflows/installers.yml`) can sign "StitchBench Setup <version>.exe" and
"StitchShop Setup <version>.exe" with Azure Trusted Signing (Microsoft now calls it Artifact Signing). It is switched
off until you set the repository variable `SIGNING_ENABLED` to `true`; until then builds are unsigned, as today.

## Your steps

1. **Azure subscription.** Create one at portal.azure.com (pay-as-you-go) if you don't have one.
2. **Trusted Signing account.** In the portal, create a "Trusted Signing Account" (or "Artifact Signing"). Pick a
   region and note its endpoint, for example East US is `https://eus.codesigning.azure.net/`. Use the Basic pricing tier.
3. **Identity validation.** In the account, choose Identity validations, then New, as an **organization** (Timing &
   Tension; needs a business that has existed a while and papers to match) or as an **individual** (your own legal
   name and a government ID). Microsoft checks it; this can take days. Do this first.
4. **Certificate profile.** After validation passes, create a certificate profile of type **Public Trust** linked to
   that validation. Note the account name and profile name.
5. **App registration.** In Microsoft Entra ID, create an app registration (no secret needed). Note its Application
   (client) ID and the Directory (tenant) ID. Under Certificates and secrets, Federated credentials, add one for
   **GitHub Actions deploying Azure resources**: your GitHub user or organization, this repository, entity type
   **Branch**, branch `main`. (The sign job then works when you start the workflow with Run workflow on `main`. Azure
   doesn't allow wildcards, so a push of a version tag would need its own credential, entity type Tag with that exact
   tag; easiest is to always release with Run workflow on `main`.)
6. **Role.** On the Trusted Signing account, Access control (IAM), add the role **Trusted Signing Certificate Profile
   Signer** for the app registration.
7. **Repository variables** (GitHub, Settings, Secrets and variables, Actions, **Variables** tab; none are secret):
   - `AZURE_CLIENT_ID`: the app registration's client ID
   - `AZURE_TENANT_ID`: the tenant ID
   - `AZURE_SUBSCRIPTION_ID`: the subscription ID
   - `SIGNING_ENDPOINT`: for example `https://eus.codesigning.azure.net/` (must match the account's region)
   - `SIGNING_ACCOUNT_NAME`: the Trusted Signing account name
   - `SIGNING_PROFILE_NAME`: the certificate profile name
   - `SIGNING_ENABLED`: `true` (set this last; set it to anything else to switch signing off)
8. **Run it.** Actions, Windows installers, Run workflow. The "sign" job signs both installers and fails the run if
   either one isn't `Valid`. Download the `installers` artifact, right-click an installer, Properties, **Digital
   Signatures** tab: you should see your name and a timestamp.

## What is signed

Only the two outer installers. The app's own `StitchBench.exe` / `StitchShop.exe` installed inside is not signed:
Microsoft's action signs a folder of finished files and can't be plugged into electron-builder's per-file signing hook.
SmartScreen reputation and the "unknown publisher" prompt are decided by the installer, so this is the main win. If
Smart App Control still objects to the installed program, the next step is a `desktop/sign-azure.mjs` hook that calls
Microsoft's signing tool (`signtool` with the Azure dlib) from electron-builder's `win.sign` setting.

The build job itself has no Azure access; only the separate `sign` job gets an OIDC token.

## Cost

Basic tier is about $9.99 a month (5,000 signatures a month, plenty). Check the current price on Azure's pricing page.

## Fallback: an SSL.com OV certificate with eSigner

If Microsoft won't validate you, buy an OV code-signing certificate from SSL.com (about $130 to $250 a year) with
eSigner cloud signing (hardware-token rules since 2023 mean the key can't be a plain file). That needs different
steps: SSL.com's CodeSignTool in place of the Azure steps, with credentials and TOTP secret stored as GitHub
**secrets**. The workflow's older hook still works for a downloadable certificate: electron-builder signs when the
secrets `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set (see INSTALL.md, "Signing the installers").
