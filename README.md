# factory
L5 software factory prototype (spec + hidden scenarios -> build -> judge -> ship)

Design: `design/grand-design.md` in the suisya-systems/factory-notes repository. The first run (2026-10-17) is reported in [docs/lap-1-report.md](docs/lap-1-report.md); how it was run is in [docs/lap-1-runbook.md](docs/lap-1-runbook.md). The second run (an extension of the memo API, with split drafters) is run by [docs/lap-2-runbook.md](docs/lap-2-runbook.md) and reported in [docs/lap-2-report.md](docs/lap-2-report.md). The third run (change history and revert for the memo API, with a deliberately coarse spec) is run by [docs/lap-3-runbook.md](docs/lap-3-runbook.md) and reported in [docs/lap-3-report.md](docs/lap-3-report.md).

Emergency stop: `npm run factory -- stop` creates `.factory/STOP` (or SIGTERM the factory). While that file exists every command refuses to start; delete it by hand to resume.
Cost caps: per change (`--max-cost`, default $10, drafter spend included) and per lap ($30, `.factory/lap-ledger.json`, all commands).

## Terms

- **change**: one request taken through the loop (draft, approve, build, judge, ship, observe), identified by a change id such as `memo-api-1`.
- **spec drafter / scenario drafter**: since lap 2, two separate model sessions draft one change. The spec drafter writes the spec, the assumptions and the **interface** (endpoint, parameter and field names and response shapes only, no rules). The scenario drafter writes the hidden scenarios from the request, the existing app and the interface only. It never sees the spec or the spec drafter's other assumptions: in lap 2 those assumptions carried nearly every rule of the spec, so the owner decided on 2026-10-17 to pass the interface only. Since lap 3 the spec is deliberately coarse (owner decision 2026-10-17): it states only what the request says plus the interface, and lists every behaviour the request leaves open (defaults, status codes, boundaries, combinations) under a final `## Undecided` section without deciding it. The builder decides those points.
- **base**: for a change that extends an app, the commit of the ship target the drafters read (`draft --base`). It is part of the approved version, and `run` fails if the ship target has moved.
- **lap**: one owner-budgeted run of the factory; its ledger (`.factory/lap-ledger.json`) sums the cost of every model call of every change and command.
- **vault**: `.factory/vault/`, where the hidden scenarios and the approved set live. No sandboxed process (builder, judge model session, app code) can see it.
- **inSpec (self-report)**: per scenario, the drafter's own claim. In lap 1 it meant "the spec states this behaviour". Since lap 2 the scenario drafter cannot see the spec, so it means "the request states this behaviour". The two laps' self-reports answer different questions. It is not verified.
- **classification (independent label)**: per scenario, decided by a procedure instead of the drafter. A separate session sees only the spec, the existing app code and the scenario's requests (no expectations, ids, titles or summaries), and predicts each response. The scenario's checks are compared with the prediction mechanically. Labels:
  - `readable`: every check is satisfied. The basis is `spec`, `code` or `convention` (general HTTP habit). A claimed spec/code basis counts only if its quote is really in the spec/code.
  - `contradicts`: the spec or code says something else.
  - `unstated`: the spec leaves something the scenario checks open.
  - `unknown`: the classifier failed.

  It is fixed at approval (`classification.json` in the vault), and pass rates are split on it.
- **discrepancy list**: the part of the approval summary that lists `contradicts` scenarios, under (a), and `unstated` ones with the open checks, under (b). The factory never fixes them. The owner approves the set as it is, or drafts a new change.
- **canary**: a random string that `probe-isolation` plants in the vault. If it appears in the builder's reply or files, the vault leaked.
- **`ponytail:` comments**: mark a deliberate simplification with a known limit and the upgrade path.
