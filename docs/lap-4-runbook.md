# 4 周目の実行手順

工場の 4 周目を回すための手順。3 周目（[lap-3-runbook.md](lap-3-runbook.md)、結果は [lap-3-report.md](lap-3-report.md)）と同じ構成で回す。3 周目の仕組み（粗い仕様と `## Undecided` 節、試行の上限 5 回、作る役 $5・判定役 $2 の 1 回あたりの上限）は、そのまま使う。3 周目との違いは次の 3 点。

- **新しいアプリを作る依頼にする**（オーナー承認 2026-10-17）。
  - 依頼は割り勘の精算 API（[requests/split-settle.md](../requests/split-settle.md)）。オーナー承認の案「グループで立て替えた支出を記録し、誰が誰にいくら払えば精算が終わるかを出す。金額は円で、端数が特定の人に偏らないように扱う」を英語に整えたもので、要件は足しも引きもしていない。
  - 出荷先は、README だけがある新しいリポジトリ suisya-systems/factory-practice-split。拡張する元のアプリが無いので、下書きに `--base` を付けない。
  - 狙い: 3 周目は、仕様が決めていない答え 95 件のうち 50 件が、既存アプリの規則から決まっていた。作る役とシナリオの下書き役が同じ既存コードを読むと、仕様を「未定」にしても答えがそろう。既存コードが無ければ、この抜け道は無くなる。端数の配り方、精算の組み方（送金の回数を減らすか等）、同額の扱いなど、慣習で一つに決まらない選択が多い依頼にした。
- **インタフェースから値を外す**。仕様の下書き役がシナリオの下書き役へ渡すインタフェースには、名前と形だけを入れる。フィールドや引数が取りうる値の列挙は入れさせない。
  - 3 周目は、インタフェースに履歴の `action` の値（`"create"` など）が並んでいて、それが未定の 1 番（作成を履歴に入れるか）の答えを事実上決めていた。
  - 指示で禁じるだけでなく、工場が検査する（`src/roles.ts` の `checkInterface`）。インタフェースの各項目は、名前（英数字と `_`、入れ子は `.`、配列の要素は `[]`）か `"METHOD /path"` でなければならない。`"action: create|update"` や `"order=asc"`、説明の文のような値の入る余地は無い。違反した返答は、理由を添えて 1 回だけ書き直させる（2 周目からの仕組み）。書き直しでも通らなければ、下書きは失敗で終わる。
- **モデル別の費用を残す**。`claude -p` の結果にあるモデル別使用量（`modelUsage` の各モデルの `costUSD`）から、役ごと・モデルごとの費用を記録する。
  - 記録先: lap 台帳（`lap-ledger.json`）、下書きの費用（`draft-cost.json`）、run の記録（`run.json` の `cost` と `draftCost`）。どれも `byRoleModel` に「役 → モデル → 金額」で入る。隔離の確認の記録（`isolation-probe.json`）には `costByModel` が入る。
  - 呼び出しの費用のうち、どのモデルにも割り当てられなかった分は `(unattributed)` に入る。費用を報告しなかった呼び出し（時間切れなど）は、計上した額の全部がここに入る。役ごとの合計は、これまでの `byRole` と一致する。
  - 3 周目では、隔離の確認で 2 つ目のモデル（`claude-opus-4-8`）が使われていたが、その費用が分からなかった。

担当は 2 人いる。

- **実行担当**: モデルの API に出られる普通の端末で、工場のコマンドを叩く人。
- **作成担当**: 工場を実装し、出力を集計して報告書（`docs/lap-4-report.md`）を書くエージェント。作成担当の開発環境は sandbox の中にあり、API に出られない。そのため実モデルを呼ぶ段は実行担当が受け持ち、各段の停止点で出力を作成担当へ渡す。

1 人で回す場合は、「作成担当へ送る」を「出力を確かめる」と読み替える。用語は [README](../README.md) の Terms にある。

## 前提

- **cwd**: このリポジトリ（suisya-systems/factory）を checkout したディレクトリ。4 周目の変更を含む版（ブランチ `feat/factory-lap-4`、またはそれを取り込んだ main）であること。以下のコマンドは、すべてここで実行する。
- **実行環境**: Node 22.17 以上（`node --version`）と `/usr/bin/bwrap` が要る。依存はゼロなので npm install は要らない。認証と環境変数の扱いは 1 周目と同じ。
- **状態ディレクトリは新しく始める**: lap 台帳には周の区別が無い。前の周の状態ディレクトリを使うと、前の周の支出が 4 周目の上限 $30 に数えられてしまう。
  - 状態ディレクトリを別名にする: `export FACTORY_HOME="$PWD/.factory-lap4"`。以後、同じ端末で実行する。`$HOME` の下にあることが条件で、外だと工場は起動を拒否する。新しい checkout の `.factory` で始めてもよい。
  - 以下では、状態ディレクトリを `$STATE` と書く。
- **緊急停止**: 別の端末から `npm run factory -- stop` を実行するか、工場のプロセスに SIGTERM を送る。

```bash
export FACTORY_HOME="$PWD/.factory-lap4"
STATE="$FACTORY_HOME"
test ! -e "$STATE/lap-ledger.json" && echo "fresh state: $STATE"
```

期待: `fresh state: ...` が出る。出なければ、ここで止めて作成担当へ連絡する。

## 予算

1 周の合計見積もり上限は $30（lap 台帳で全コマンドの合計を数える）。3 周目と同じ内訳にする。

| 項目 | 上限 | 内容 |
|---|---|---|
| 隔離の確認 | $1 | |
| 1 変更 | $28（`--max-cost 28`） | 下書き（仕様・シナリオ・分類）と、作る役・判定役の費用をすべて含む。下書き単体は $10 まで |

- 3 周目の実績は、下書き全体 $2.43（うち分類 $1.93）、作る役 1 回 $0.40、判定役 1 回 $0.16。
- この周は、やり直しが起きることを見込んでいる。5 回とも使っても、作る役と判定役で約 $3（1 回あたりの上限で数えても $35 になるが、変更の上限 $28 が先に効く）。上限の内側に収まる見込み。
- 分類は、シナリオ 1 本につき 1 回呼ぶ。1 回あたりの上限は $0.50。

## 手順

### 1. 検証（費用なし）

```bash
npm test
```

期待: `# pass 85`、`# fail 0`、`# skipped 0`。

### 2. 出荷先の用意（費用なし）

出荷先は、練習用アプリのリポジトリ suisya-systems/factory-practice-split の clone。

```bash
git clone <factory-practice-split の URL か手元の clone> "$STATE/ship/factory-practice-split"
git -C "$STATE/ship/factory-practice-split" log -1 --format='%h %s'
git -C "$STATE/ship/factory-practice-split" ls-files
```

期待: `63f5f20 Initial commit` と、ファイルは `README.md` だけ。違えば、ここで止めて作成担当へ連絡する。

この clone は、run が終わるまで動かさないこと（pull しない、commit しない）。この周の下書きは `--base` を付けないので、工場は下書き時の HEAD を承認の版に含めない。HEAD が動いても工場は気づかない。

### 3. 隔離の確認（実モデル呼び出し、上限 $1）

```bash
npm run factory -- probe-isolation lap4-probe; echo "exit=$?"
```

- 期待: `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: ここで止めて作成担当へ連絡する。以降は実行しない
- `exit=2` / `exit=3`: ここで止め、出力を作成担当へ送る

**停止点 A**: 出力と `$STATE/runs/lap4-probe/isolation-probe.json` の中身を作成担当へ送る。この周から、記録に `costByModel`（モデル別の費用）が入る。

### 4. 下書き（実モデル呼び出し、上限 $10）

```bash
npm run factory -- draft split-settle-1 --request requests/split-settle.md; echo "exit=$?"
```

- `--base` は付けない（拡張する元のアプリが無い）。
- 期待: `drafted split-settle-1 (version <hash>). Factory stopped; waiting for human approval. Summary: <path>`、`exit=0`
- 所要時間の目安: 下書き 2 回で数分、分類はシナリオ 1 本ごとに数十秒〜数分
- 失敗時（`exit=1`）: 出力を作成担当へ送る。費用は `$STATE/runs/split-settle-1/draft-cost.json` に残る。インタフェースの検査（上の「インタフェースから値を外す」）で 2 回とも落ちた場合は、`spec drafter: interface ...` のエラーが出る。同じ変更 id で下書きし直してよいか（費用が足される）は、作成担当と相談する。

**停止点 B（入口の承認、必須の人間ゲート）**: 工場はここで止まる。

1. 作成担当が `$STATE/vault/split-settle-1/approval-summary.md` を読み、オーナー向けの 1 画面要約を作る。形は 3 周目を踏襲する。要約には、仕様の「未定」の一覧と、インタフェースが名前と形だけであることの確認を載せる。
2. 作成担当は、手順 6 の `--traffic-base` に渡すパスも、インタフェースの `endpoints` から決めて実行担当へ伝える。
3. 実行担当がその要約をオーナーに渡す。
4. オーナーの承認を得るまで次へ進まない。

食い違い一覧は、3 周目と同じく (b)（仕様が決めていないことを求めるシナリオ）が多くなるはず。工場はどちらも自動では直さない。そのまま承認すれば、作る役が未定の部分を推測で作り、隠しシナリオと食い違えば不通過になる。やり直しで収束するかどうか（前提 2）は、そこで試される。承認するか、新しい変更 id で下書きし直すかは、オーナーが決める。

### 5. 承認（オーナーの判断を実行担当が記録する）

```bash
npm run factory -- approve split-settle-1 --by <承認者名> --version <要約に書かれた version>
```

期待: `approved split-settle-1 by <name>; version <hash>`

### 6. 作る → 確かめる → 出す → 本番を見る（実モデル呼び出し、上限は下書きと合わせて $28）

`<base>` は、停止点 B で作成担当が伝えたパス（例: `/groups`）。合成トラフィック（出荷後に本番へ送る 5 件の要求）の宛先で、合否には関わらない。

```bash
npm run factory -- run split-settle-1 --ship-target "$STATE/ship/factory-practice-split" --max-cost 28 --port 8787 --traffic-base <base>; echo "exit=$?"
```

- 合格して出荷した場合: `split-settle-1: shipped; attempts N`、`exit=0`。アプリは `http://127.0.0.1:8787` で動き続ける。
- 失敗した場合（費用上限・やり直し上限・緊急停止・エラー）: `split-settle-1: failed (<理由>); attempts N`、`exit=1`。
  - これも正しい結果の 1 つ。人に聞かず、自動で再投入もしない。
  - 試行の上限（5 回）で失敗に終わっても、各回の記録が前提 2 の成果になる。
- 不通過のとき作る役が受け取るのは、落ちたシナリオの 1 行要約と「LLM 判定が承認しなかった」の印だけ（オーナー決定。1 周目から同じ）。
- 所要時間の目安: 作る役の呼び出し 1 回で数分〜20 分（上限 20 分）、最大 5 回。

**停止点 C**: 出力 2 行を作成担当へ送る。

記録は次の場所にある。作成担当がこれを読んで `docs/lap-4-report.md` を書く。

- `$STATE/runs/split-settle-1/run.json`（やり直しの各回の結果を含む）
- `$STATE/runs/split-settle-1/draft-cost.json`
- `$STATE/vault/split-settle-1/`（`spec.md`・`scenarios.json`・`classification.json`・`assumptions.json` を含む）
- `$STATE/work/split-settle-1/`（作る役の作業場所の git。各回の commit が残る。報告で、各回の作る役の選択を読むのに使う）
- `$STATE/prod/signals.json`（出荷した場合）
- `$STATE/lap-ledger.json`
- `$STATE/runs/lap4-probe/isolation-probe.json`

実行担当の端末から作成担当の作業場所へファイルを渡せない場合は、各ファイルの中身を送る。`$STATE/work/split-settle-1/` は `git -C "$STATE/work/split-settle-1" bundle create <file> --all` で 1 ファイルにできる。

### 7. 後片付けと push（合格して出荷した場合だけ）

```bash
kill "$(cat "$STATE/prod/server.pid")"
```

`<practice-split>` は、GitHub の factory-practice-split を remote に持つ手元の clone を指す。工場が積んだ commit を本物のリポジトリへ送る（工場自身は push しない）。

```bash
git -C <practice-split> pull --ff-only "$STATE/ship/factory-practice-split" main
git -C <practice-split> push origin main
```

失敗で終わった場合は push しない。出荷先の clone は工場が fast-forward していないので、main は `63f5f20` のままである。
