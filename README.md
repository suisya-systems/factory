# factory
L5 software factory prototype (spec + hidden scenarios -> build -> judge -> ship)

Emergency stop: `npm run factory -- stop` creates `.factory/STOP` (or SIGTERM the factory). While that file exists every command refuses to start; delete it by hand to resume.
Cost caps: per change (`--max-cost`, default $10, drafter spend included) and per lap ($30, `.factory/lap-ledger.json`, all commands).
