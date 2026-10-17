# factory
L5 software factory prototype (spec + hidden scenarios -> build -> judge -> ship)

Design: `design/grand-design.md` in the suisya-systems/factory-notes repository. The first run (2026-10-17) is reported in [docs/lap-1-report.md](docs/lap-1-report.md); how it was run is in [docs/lap-1-runbook.md](docs/lap-1-runbook.md).

Emergency stop: `npm run factory -- stop` creates `.factory/STOP` (or SIGTERM the factory). While that file exists every command refuses to start; delete it by hand to resume.
Cost caps: per change (`--max-cost`, default $10, drafter spend included) and per lap ($30, `.factory/lap-ledger.json`, all commands).

## Terms

- **change**: one request taken through the loop (draft, approve, build, judge, ship, observe), identified by a change id such as `memo-api-1`.
- **lap**: one owner-budgeted run of the factory; its ledger (`.factory/lap-ledger.json`) sums the cost of every model call of every change and command.
- **vault**: `.factory/vault/`, where the hidden scenarios and the approved set live. No sandboxed process (builder, judge model session, app code) can see it.
- **inSpec**: per scenario, the drafter's claim that the spec states the behaviour. Pass rates are split on it. It is self-reported and not verified.
- **canary**: a random string that `probe-isolation` plants in the vault. If it appears in the builder's reply or files, the vault leaked.
- **`ponytail:` comments**: mark a deliberate simplification with a known limit and the upgrade path.
