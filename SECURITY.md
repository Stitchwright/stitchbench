# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private reporting instead: on this repository,
**Security → Report a vulnerability**. Include what you found, how to reproduce it, and which version (Settings →
What's new in the program, or the image tag). We'll answer as soon as we can and credit you in the fix if you like.

Things worth reporting: reading or changing another company's data (every business query is scoped to the signed-in
user's shop), sign-in or password-reset bypasses, license-key or update-signature bypasses, and anything that exposes
the hosted app's secrets.

## What's committed on purpose

`scripts/license/dev-key.json` is a development signing key. It is public by design: keys it signs are accepted only
by test builds (`STITCH_TEST_BUILD=1`), never by a normal build. The release key in `desktop/release-key.mjs` is the
public half only.

## Supported versions

Only the latest release gets fixes.
