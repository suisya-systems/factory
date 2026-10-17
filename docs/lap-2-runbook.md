# 2 周目の実行手順

工場の 2 周目を回す手順。1 周目（[lap-1-runbook.md](lap-1-runbook.md)）と同じ構成で、次の点が違う。

- 依頼は新規作成ではなく、1 周目で出荷したメモ API の拡張（[requests/memo-tags.md](../requests/memo-tags.md)）
- 下書きは 3 段で、それぞれ別セッションになる
  1. 仕様の下書き役
  2. シナリオの下書き役（仕様も仕様の下書き役の仮定も見ない。見るのは依頼文・既存アプリ・インタフェース（名前と形）だけ）
  3. 分類（シナリオ 1 本ごとに、仕様だけを見たセッションが応答を予測する）
- 入口の要約に、分類の結果と「食い違い一覧」が載る

担当は 2 人いる。

- **実行担当**: モデルの API に出られる普通の端末で、工場のコマンドを叩く人。
- **作成担当**: 工場を実装し、出力を集計して報告書を書くエージェント。作成担当の開発環境は sandbox の中にあり、API に出られない。そのため、実モデルを呼ぶ段は実行担当が受け持ち、各段の停止点で出力を作成担当へ渡す。

1 人で回す場合は、「作成担当へ送る」を「出力を確かめる」と読み替える。用語は [README](../README.md) の Terms にある。

## 前提

- **cwd**: このリポジトリ（suisya-systems/factory）を checkout したディレクトリ。以下のコマンドは、すべてここで実行する。
- **実行環境**: Node 22.17 以上（`node --version`）と `/usr/bin/bwrap` が要る。依存はゼロなので npm install は要らない。認証と環境変数の扱いは 1 周目と同じ。
- **状態ディレクトリは新しく始める**: lap 台帳（`.factory/lap-ledger.json`）には周の区別が無い。1 周目の `.factory/` が残っていると、1 周目の支出が 2 周目の上限 $30 に数えられてしまう。
  - 1 周目の保管庫も 2 周目の工場では読めない。承認の版に含めるファイルが増えたためで、1 周目の変更はもう走らせないので困らない。
  - 次の 2 通りのどちらかで始める。
    - 新しい checkout で始める
    - 状態ディレクトリを別名にする: `export FACTORY_HOME="$PWD/.factory-lap2"`。以後、同じ端末で実行する。`$HOME` の下にあることが条件で、外だと工場は起動を拒否する。
  - 以下では、状態ディレクトリを `$STATE` と書く（`.factory` か `$FACTORY_HOME` のどちらか）。
- **緊急停止**: 別の端末から `npm run factory -- stop` を実行するか、工場のプロセスに SIGTERM を送る。

```bash
STATE="${FACTORY_HOME:-$PWD/.factory}"
test ! -e "$STATE/lap-ledger.json" && echo "fresh state: $STATE"
```

期待: `fresh state: ...` が出る。出なければ、ここで止めて作成担当へ連絡する。

## 予算

1 周の合計見積もり上限は $30（lap 台帳で全コマンドの合計を数える）。内訳は次のとおり。

| 項目 | 上限 | 内容 |
|---|---|---|
| 隔離の確認 | $1 | |
| 1 変更 | $28（`--max-cost 28`） | 下書き（仕様・シナリオ・分類）と、作る役・判定役の費用をすべて含む。下書き単体は $10 まで |

分類は、シナリオ 1 本につき 1 回呼ぶ。1 回あたりの上限は $0.50 で、費用を報告しなかった呼び出しはこの $0.50 として計上する。

## 手順

### 1. 検証（費用なし）

```bash
npm test
```

期待: `# fail 0`、`# skipped 0`。

### 2. 出荷先の用意（費用なし）

出荷先は、練習用アプリのリポジトリ suisya-systems/factory-practice-memo の clone。2 周目の下書きはこの clone の HEAD を「拡張する元のアプリ」として読む。

```bash
git clone <factory-practice-memo の URL か手元の clone> "$STATE/ship/factory-practice-memo"
git -C "$STATE/ship/factory-practice-memo" log -1 --format='%h %s'
```

期待: `6d33b99 factory: builder attempt`（1 周目に工場が出荷した commit）。違えば、ここで止めて作成担当へ連絡する。

この clone は、run が終わるまで動かさないこと（pull しない、commit しない）。工場は下書き時の HEAD を承認の版に含める。run の時点で HEAD が違えば、作る前に失敗で終える。

### 3. 隔離の確認（実モデル呼び出し、上限 $1）

```bash
npm run factory -- probe-isolation lap2-probe; echo "exit=$?"
```

- 期待: `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: ここで止めて作成担当へ連絡する。以降は実行しない
- `exit=2` / `exit=3`: ここで止め、出力を作成担当へ送る

**停止点 A**: 出力と `$STATE/runs/lap2-probe/isolation-probe.json` の場所を作成担当へ送る。

### 4. 下書き（実モデル呼び出し、上限 $10）

2026-10-17 の 2 周目では、この段を最初は変更 id `memo-tags-1` で実行した。そのときシナリオの下書き役には、仕様の下書き役の仮定も渡していた。仮定に仕様の規則がほぼすべて入っていたため、オーナーは memo-tags-1 を承認しなかった。そのうえで、シナリオの下書き役には依頼文・既存アプリ・インタフェースだけを渡すように工場を直し、`memo-tags-2` で下書きし直すと決めた。経緯は [lap-2-report.md](lap-2-report.md) にある。以下は直した後の手順である。

```bash
npm run factory -- draft memo-tags-2 --request requests/memo-tags.md --base "$STATE/ship/factory-practice-memo"; echo "exit=$?"
```

- 期待: `drafted memo-tags-2 (version <hash>). Factory stopped; waiting for human approval. Summary: <path>`、`exit=0`
- 所要時間の目安: 下書き 2 回で数分、分類はシナリオ 1 本ごとに数十秒〜数分
- 失敗時（`exit=1`）: 出力を作成担当へ送る。費用は `$STATE/runs/memo-tags-2/draft-cost.json` に残る

**停止点 B（入口の承認、必須の人間ゲート）**: 工場はここで止まる。

1. 作成担当が `$STATE/vault/memo-tags-2/approval-summary.md` を読み、オーナー向けの 1 画面要約を作る。形は 1 周目を踏襲し、「食い違い一覧」を加える。
2. 実行担当がその要約をオーナーに渡す。
3. オーナーの承認を得るまで次へ進まない。

食い違い一覧には 2 部ある。工場はどちらも自動では直さない。直したい場合は、新しい変更 id で下書きし直す。

- (a) 仕様と食い違うシナリオ
- (b) 仕様が決めていないことを求めるシナリオ

### 5. 承認（オーナーの判断を実行担当が記録する）

```bash
npm run factory -- approve memo-tags-2 --by <承認者名> --version <要約に書かれた version>
```

期待: `approved memo-tags-2 by <name>; version <hash>`

### 6. 作る → 確かめる → 出す → 本番を見る（実モデル呼び出し、上限は下書きと合わせて $28）

```bash
npm run factory -- run memo-tags-2 --ship-target "$STATE/ship/factory-practice-memo" --max-cost 28 --port 8787; echo "exit=$?"
```

- 合格して出荷した場合: `memo-tags-2: shipped; attempts N`、`exit=0`。アプリは `http://127.0.0.1:8787` で動き続ける。
- 失敗した場合（費用上限・やり直し上限・緊急停止・出荷先の HEAD が変わった・エラー）: `memo-tags-2: failed (<理由>); attempts N`、`exit=1`。
  - これも正しい結果の 1 つ。人に聞かず、自動で再投入もしない。
  - 2 周目は、前提 2（やり直しで収束するか）を試す周である。失敗で終わっても、その記録が成果になる。
- 所要時間の目安: 作る役の呼び出し 1 回で数分〜20 分（上限 20 分）、最大 3 回。

**停止点 C**: 出力 2 行を作成担当へ送る。

記録は次の場所にある。作成担当がこれを読んで `docs/lap-2-report.md` を書く。

- `$STATE/runs/memo-tags-2/run.json`
- `$STATE/runs/memo-tags-2/draft-cost.json`
- `$STATE/vault/memo-tags-2/`（`classification.json` を含む）
- `$STATE/prod/signals.json`
- `$STATE/lap-ledger.json`

実行担当の端末から作成担当の作業場所へファイルを渡せない場合は、各ファイルの中身を送る。

### 7. 後片付けと push（合格して出荷した場合だけ）

```bash
kill "$(cat "$STATE/prod/server.pid")"
```

`<practice-memo>` は、GitHub の factory-practice-memo を remote に持つ手元の clone を指す。工場が積んだ commit を本物のリポジトリへ送る（工場自身は push しない）。

```bash
git -C <practice-memo> pull --ff-only "$STATE/ship/factory-practice-memo" main
git -C <practice-memo> push origin main
```

失敗で終わった場合は push しない。出荷先の clone は工場が fast-forward していないので、main は 1 周目の commit のままである。
