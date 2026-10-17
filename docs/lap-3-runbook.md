# 3 周目の実行手順

工場の 3 周目を回すための手順。2 周目（[lap-2-runbook.md](lap-2-runbook.md)、結果は [lap-2-report.md](lap-2-report.md)）と同じ構成で回す。2 周目との違いは次の 3 点。

- **仕様をわざと粗くする**（オーナー承認 2026-10-17）。
  - 仕様の下書き役には、依頼文に書いてあることと、インタフェース（名前と形）だけを書かせる。
  - 依頼文が決めていない振る舞い（既定値、状態コード、上限と境界、並び順、エラーの扱い、機能の組み合わせ）は決めさせない。仕様の末尾の `## Undecided` 節に、1 項目 1 行で「未定」として並べさせる。この節が無い返答は検査で落ち、理由を添えて 1 回だけ書き直させる（2 周目からの仕組み）。書き直しでも節が無ければ下書きは失敗で終わる。
  - 作る役は仕様を受け取り、`Undecided` の項目を自分で決める。シナリオの下書き役は、2 周目と同じく仕様を見ない。
  - 狙い: 2 周目は、シナリオ 15/15 が仕様から読み取れた。仕様に書いていない振る舞いをシナリオが確かめる余地を作る。
- **作る役にとって難しい依頼にする**: メモの変更履歴と、過去の版への戻し（[requests/memo-history.md](../requests/memo-history.md)）。出荷先は、2 周目に出荷したメモ API（factory-practice-memo の main、`b36ad38`）。
- **分類の手続きの直し**:
  - 2 周目の報告に残した未修正の指摘 2 件を直した（同じ名前での値の取り直し、予測したヘッダの中の `{{name}}`）。
  - 予測者が仕様の `## Undecided` 節を引用しても、根拠「仕様」とは数えない（慣習に格下げする）。
- **作る役・判定役の 1 回あたりの上限**: 作る役 $5、判定役 $2 にした。費用を報告しない呼び出し（20 分の時間切れなど）は、この額で計上される。2 周目までは変更の上限の残り全額で計上していたので、作る役が 1 回時間切れになると、やり直しの前に費用上限で止まっていた。
- **判定役への指示**: 仕様の `Undecided` の項目は作る役に任せた、妥当な選択なら仕様を満たす、と 1 文足した。

担当は 2 人いる。

- **実行担当**: モデルの API に出られる普通の端末で、工場のコマンドを叩く人。
- **作成担当**: 工場を実装し、出力を集計して報告書（`docs/lap-3-report.md`）を書くエージェント。作成担当の開発環境は sandbox の中にあり、API に出られない。そのため実モデルを呼ぶ段は実行担当が受け持ち、各段の停止点で出力を作成担当へ渡す。

1 人で回す場合は、「作成担当へ送る」を「出力を確かめる」と読み替える。用語は [README](../README.md) の Terms にある。

## 前提

- **cwd**: このリポジトリ（suisya-systems/factory）を checkout したディレクトリ。以下のコマンドは、すべてここで実行する。
- **実行環境**: Node 22.17 以上（`node --version`）と `/usr/bin/bwrap` が要る。依存はゼロなので npm install は要らない。認証と環境変数の扱いは 1 周目と同じ。
- **状態ディレクトリは新しく始める**: lap 台帳（`.factory/lap-ledger.json`）には周の区別が無い。前の周の状態ディレクトリを使うと、前の周の支出が 3 周目の上限 $30 に数えられてしまう。
  - 次の 2 通りのどちらかで始める。
    - 新しい checkout で始める
    - 状態ディレクトリを別名にする: `export FACTORY_HOME="$PWD/.factory-lap3"`。以後、同じ端末で実行する。`$HOME` の下にあることが条件で、外だと工場は起動を拒否する。
  - 以下では、状態ディレクトリを `$STATE` と書く（`.factory` か `$FACTORY_HOME` のどちらか）。
- **緊急停止**: 別の端末から `npm run factory -- stop` を実行するか、工場のプロセスに SIGTERM を送る。

```bash
STATE="${FACTORY_HOME:-$PWD/.factory}"
test ! -e "$STATE/lap-ledger.json" && echo "fresh state: $STATE"
```

期待: `fresh state: ...` が出る。出なければ、ここで止めて作成担当へ連絡する。

## 予算

1 周の合計見積もり上限は $30（lap 台帳で全コマンドの合計を数える）。2 周目と同じ内訳にする。

| 項目 | 上限 | 内容 |
|---|---|---|
| 隔離の確認 | $1 | |
| 1 変更 | $28（`--max-cost 28`） | 下書き（仕様・シナリオ・分類）と、作る役・判定役の費用をすべて含む。下書き単体は $10 まで |

- 分類は、シナリオ 1 本につき 1 回呼ぶ。1 回あたりの上限は $0.50 で、費用を報告しなかった呼び出しはこの $0.50 として計上する。
- 作る役の試行は最大 3 回（初回と、やり直し最大 2 回。工場の既定値）。2 周目の実績は、作る役 1 回 $0.47、判定役 1 回 $0.23、下書き全体 $2.06。3 回とも使っても上限の内側に収まる見込み。
- 1 回あたりの上限は、作る役 $5、判定役 $2。

## 手順

### 1. 検証（費用なし）

```bash
npm test
```

期待: `# fail 0`、`# skipped 0`。

### 2. 出荷先の用意（費用なし）

出荷先は、練習用アプリのリポジトリ suisya-systems/factory-practice-memo の clone。3 周目の下書きは、この clone の HEAD を「拡張する元のアプリ」として読む。

```bash
git clone <factory-practice-memo の URL か手元の clone> "$STATE/ship/factory-practice-memo"
git -C "$STATE/ship/factory-practice-memo" log -1 --format='%h %s'
```

期待: `b36ad38 factory: builder attempt`（2 周目に工場が出荷した commit）。違えば、ここで止めて作成担当へ連絡する。

この clone は、run が終わるまで動かさないこと（pull しない、commit しない）。工場は下書き時の HEAD を承認の版に含める。run の時点で HEAD が違えば、作る前に失敗で終える。

### 3. 隔離の確認（実モデル呼び出し、上限 $1）

```bash
npm run factory -- probe-isolation lap3-probe; echo "exit=$?"
```

- 期待: `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: ここで止めて作成担当へ連絡する。以降は実行しない
- `exit=2` / `exit=3`: ここで止め、出力を作成担当へ送る

**停止点 A**: 出力と `$STATE/runs/lap3-probe/isolation-probe.json` の場所を作成担当へ送る。

### 4. 下書き（実モデル呼び出し、上限 $10）

```bash
npm run factory -- draft memo-history-1 --request requests/memo-history.md --base "$STATE/ship/factory-practice-memo"; echo "exit=$?"
```

- 期待: `drafted memo-history-1 (version <hash>). Factory stopped; waiting for human approval. Summary: <path>`、`exit=0`
- 所要時間の目安: 下書き 2 回で数分、分類はシナリオ 1 本ごとに数十秒〜数分
- 失敗時（`exit=1`）: 出力を作成担当へ送る。費用は `$STATE/runs/memo-history-1/draft-cost.json` に残る

**停止点 B（入口の承認、必須の人間ゲート）**: 工場はここで止まる。

1. 作成担当が `$STATE/vault/memo-history-1/approval-summary.md` を読み、オーナー向けの 1 画面要約を作る。形は 2 周目を踏襲する。この周の要約には、仕様の「未定」の一覧（`## Undecided in the spec`）も載る。
2. 実行担当がその要約をオーナーに渡す。
3. オーナーの承認を得るまで次へ進まない。

この周は、食い違い一覧が空でなくなることを見込んでいる。

- (a) 仕様と食い違うシナリオ
- (b) 仕様が決めていないことを求めるシナリオ。仕様が粗いので、2 周目より増えるはず

工場はどちらも自動では直さない。(a)(b) を含む組をそのまま承認すれば、作る役が未定の部分を推測で作り、隠しシナリオと食い違えば不通過になる。やり直しで収束するかどうか（前提 2）は、そこで試される。承認するか、新しい変更 id で下書きし直すかは、オーナーが決める。

### 5. 承認（オーナーの判断を実行担当が記録する）

```bash
npm run factory -- approve memo-history-1 --by <承認者名> --version <要約に書かれた version>
```

期待: `approved memo-history-1 by <name>; version <hash>`

### 6. 作る → 確かめる → 出す → 本番を見る（実モデル呼び出し、上限は下書きと合わせて $28）

```bash
npm run factory -- run memo-history-1 --ship-target "$STATE/ship/factory-practice-memo" --max-cost 28 --port 8787; echo "exit=$?"
```

- 合格して出荷した場合: `memo-history-1: shipped; attempts N`、`exit=0`。アプリは `http://127.0.0.1:8787` で動き続ける。
- 失敗した場合（費用上限・やり直し上限・緊急停止・出荷先の HEAD が変わった・エラー）: `memo-history-1: failed (<理由>); attempts N`、`exit=1`。
  - これも正しい結果の 1 つ。人に聞かず、自動で再投入もしない。
  - 試行の上限（3 回）で失敗に終わっても、各回の記録が前提 2 の成果になる。
- 不通過のとき作る役が受け取るのは、落ちたシナリオの 1 行要約と「LLM 判定が承認しなかった」の印だけ（オーナー決定。2 周目までと同じ）。
- 所要時間の目安: 作る役の呼び出し 1 回で数分〜20 分（上限 20 分）、最大 3 回。

**停止点 C**: 出力 2 行を作成担当へ送る。

記録は次の場所にある。作成担当がこれを読んで `docs/lap-3-report.md` を書く。

- `$STATE/runs/memo-history-1/run.json`（やり直しの各回の結果を含む）
- `$STATE/runs/memo-history-1/draft-cost.json`
- `$STATE/vault/memo-history-1/`（`spec.md`・`scenarios.json`・`classification.json` を含む）
- `$STATE/prod/signals.json`（出荷した場合）
- `$STATE/lap-ledger.json`
- `$STATE/runs/lap3-probe/isolation-probe.json`

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

失敗で終わった場合は push しない。出荷先の clone は工場が fast-forward していないので、main は 2 周目の commit `b36ad38` のままである。
