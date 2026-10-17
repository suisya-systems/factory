# 1 周目の実行手順（窓口が sandbox 外で実行する）

工場の実行コマンドは `claude -p` で API を呼ぶ。ワーカーの sandbox からは API に出られないので、次の手順は窓口が sandbox の外で叩く。各段の停止点で出力をワーカーへ送ってもらい、ワーカーが集計と報告を担当する。

## 前提

- cwd: `<作業ディレクトリ>/factory/.worktrees/factory-lap-1`（以下、すべてこのディレクトリで実行する）
- Node 22.17 以上（`node --version`）、`/usr/bin/bwrap` があること。npm install は不要（依存ゼロ）
- 環境変数は特に要らない。`claude` は `~/.local/bin/claude` を使い、ログイン情報は `~/.claude/.credentials.json` を読み取り専用で渡す。env 認証を使う場合だけ `ANTHROPIC_API_KEY` か `CLAUDE_CODE_OAUTH_TOKEN` を渡す（工場はこれ以外の環境変数をモデル側へ渡さない）
- 工場の状態は `.factory/` に置かれる（git 管理外）。隠しシナリオは `.factory/vault/` にある
- 緊急停止: 別の端末から `npm run factory -- stop`（`.factory/STOP` を作る）または工場のプロセスに SIGTERM。どちらも進行中のモデル呼び出しを止め、その変更を失敗で終える

## 予算

1 周目の合計見積もり上限は $30（工場が `.factory/lap-ledger.json` で全コマンドの合計を数え、$30 に達したら次のモデル呼び出しを始めない）。内訳: 隔離確認 上限 $1 + 1 変更 上限 $28（`--max-cost 28`。下書きの費用もこの上限に含む。下書き単体は $10 まで）。金額は `claude -p` が返す `total_cost_usd` の合算（クライアント側の見積もり）。

## 手順

### 1. 検証（費用なし）

```bash
npm test
```

期待: `# pass` が全件、`# fail 0`、`# skipped 0`。

### 2. 隔離の確認（実モデル呼び出し、上限 $1）

```bash
npm run factory -- probe-isolation lap1-probe; echo "exit=$?"
```

作る役と同じ設定（書き込み可・全ツール許可）の `claude -p` に、保管庫のカナリア文字列とシナリオファイルを読ませようとする。

- 期待: `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: 隔離が破れている。ここで止めてワーカーへ連絡（以降を実行しない）
- `exit=2`（モデル呼び出し失敗）/ `exit=3`（費用上限超過）: ここで止め、出力をワーカーへ送る（sandbox 内で CLI が起動・認証できない可能性。ワーカーが直す）

**停止点 A**: 出力と `.factory/runs/lap1-probe/isolation-probe.json` の場所をワーカーへ送る。

### 3. 下書き（実モデル呼び出し、上限 $10）

```bash
npm run factory -- draft memo-api-1 --request requests/memo-api.md; echo "exit=$?"
```

- 期待: `drafted memo-api-1 (version <hash>). Factory stopped; waiting for human approval. Summary: <path>`、`exit=0`
- 失敗時（`exit=1`）: 出力をワーカーへ送る

**停止点 B（入口の承認、必須の人間ゲート）**: 工場はここで止まる。ワーカーへ「draft 完了」と送ると、ワーカーが `.factory/vault/memo-api-1/approval-summary.md` からオーナー向けの 1 画面要約を作って窓口へ送る。オーナーの承認を得るまで次へ進まない。

### 4. 承認（オーナーの判断を窓口が記録する）

```bash
npm run factory -- approve memo-api-1 --by <承認者名> --version <要約に書かれた version>
```

- 期待: `approved memo-api-1 by <name>; version <hash>`
- 要約を読んだ後に下書きが変わっていれば version 不一致で拒否される。その場合は承認せずワーカーへ連絡

### 5. 作る → 確かめる → 出す → 本番を見る（実モデル呼び出し、上限は下書きと合わせて $28）

出荷先は、ワークツリー内に置いた factory-practice-memo の clone（ワーカーが用意済み: `.factory/ship/factory-practice-memo`）。

```bash
npm run factory -- run memo-api-1 --ship-target .factory/ship/factory-practice-memo --max-cost 28 --port 8787; echo "exit=$?"
```

- 合格して出荷: `memo-api-1: shipped; attempts N`、`exit=0`。アプリは `http://127.0.0.1:8787` で動き続ける
- 失敗（費用上限・やり直し上限・緊急停止・エラー）: `memo-api-1: failed (<理由>); attempts N`、`exit=1`。これも正しい結果の 1 つで、人に聞かず、自動で再投入もしない
- 所要時間の目安: 1 回の作る役の呼び出しに数分〜20 分（上限 20 分）、最大 3 回

**停止点 C**: 出力 2 行をワーカーへ送る。記録は `.factory/runs/memo-api-1/run.json` と `.factory/prod/signals.json` にあり、ワーカーが読んで `docs/lap-1-report.md` を書く。

### 6. 後片付けと push（合格して出荷した場合）

アプリを止める:

```bash
kill "$(cat .factory/prod/server.pid)"
```

工場が積んだ commit を本物のリポジトリへ送る（工場は push しない）:

```bash
git -C <作業ディレクトリ>/factory-practice-memo pull --ff-only <作業ディレクトリ>/factory/.worktrees/factory-lap-1/.factory/ship/factory-practice-memo main
git -C <作業ディレクトリ>/factory-practice-memo push origin main
```
