@AGENTS.md

# Start here

1. README.md says what StitchBench and StitchShop are (one codebase; StitchShop is a build flavor, `APP_NAME` and
   `DEFAULT_SHOP_KIND`) and INSTALL.md how to run them: as a Windows program, on the hosted service, or self-hosted.
   The community hub is a separate repository: https://github.com/{{ORG}}/StitchHub.
2. Checks before a commit: `npx tsc --noEmit`, `npx eslint src`, `npx next build`, and the Playwright specs
   (`docs/TESTING.md`). Local end-to-end testing against a test hub: `scripts/local-test/README.md` (run specs one
   at a time).
3. Secrets never go in the repository or in chat.
4. Maintainers: when the private `{{ORG}}/notes` repository is in this session, read its `CLAUDE.md` first. It holds
   the work log, the plans and the owner's decisions.
