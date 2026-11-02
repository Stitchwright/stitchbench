# Progress

- 2026-11-02 nightly sweep: no needs-triage issues; tsc, lint (0 errors) and 156 unit tests pass; npm audit unchanged (dev-only, #71). Filed #106.
  Fix #106: the three file-download routes share `headerFileName` (`src/lib/download-name.ts`), so the co-op proof keeps its letter r.
- 2026-11-01 issue 41: database checks now run in CI (`db-checks` job, 4 shards, one cloned database per check via `scripts/checks/run-ci.mjs`); 7 failing checks listed with reasons in `scripts/checks/ci-skip.txt`.
- 2026-10-31 issue 40 (pre-public review): report in the PR description; only trivial fix was an owner-private default path in `scripts/local-test/read_trace.py`. Owner decisions listed in the PR.
- 2026-11-01 nightly sweep: no needs-triage issues; tsc, lint (0 errors), 154 unit tests and the online-booking check pass on main. npm audit adds a dev-only minimatch (eslint) advisory to #71's list.
  Fix #70: the manage link's move (and its free times) only for a type still offered online, with a step in `scripts/checks/online-booking.check.ts`.
