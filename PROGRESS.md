# Progress

- 2026-10-31 issue 40 (pre-public review): report in the PR description; only trivial fix was an owner-private default path in `scripts/local-test/read_trace.py`. Owner decisions listed in the PR.
- 2026-11-01 nightly sweep: no needs-triage issues; tsc, lint (0 errors), 154 unit tests and the online-booking check pass on main. npm audit adds a dev-only minimatch (eslint) advisory to #71's list.
  Fix #70: the manage link's move (and its free times) only for a type still offered online, with a step in `scripts/checks/online-booking.check.ts`.
