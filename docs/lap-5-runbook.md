# 5 周目の実行手順

工場の 5 周目を回すための手順。4 周目（[lap-4-runbook.md](lap-4-runbook.md)、結果は [lap-4-report.md](lap-4-report.md)）の仕組みはそのまま使う。この周は出荷をしない。4 周目の報告の「次の周への提案」1 と 3 を、1 つの実験として回す。

- **提案 1（モデルの組み合わせ）**: シナリオの下書き役のモデルと作る役のモデルを、`claude-opus-5-5` と `claude-sonnet-5-5` で組み合わせる。
- **提案 3（K 回の独立実行）**: 同じ承認済みの仕様から、作る役を各モデルで独立に K 回走らせる。作る役が「五分」の点でどれを選んだかの散らばりを測る。

## 何を確かめるか

4 周目は、シナリオの下書き役と作る役が、仕様が決めていない点（端数の配り方、精算の組み方など）で同じ答えを選んだ。その理由として、次の 3 つの説明が残った。4 周目の記録（作る役 1 回、モデル 1 種類）では区別できなかった。

- **M（同じモデルだから）**: シナリオの下書き役と作る役が同じモデルなので、もっともな選び方がそろう。
- **R（依頼文が絞ったから）**: 依頼文（「端数が特定の人に偏らない」など）が、答えを 1 つに寄せた。
- **T（教科書どおりだから）**: 割り勘アプリの定番の答えに、どのモデルも収束する。

### 設計の要点

着手前の設計レビュー（Codex）で、最初の案（下書き役 2 人のモデルをまとめて振り、シナリオの一致率の交互作用で見る）に、次の欠陥が見つかった。この版はそれを直したもの。

1. **仕様を 1 本に固定する。** 仕様の下書き役のモデルを振ると、作る役が読む仕様そのものが変わり、「モデルがそろった効果」と「仕様の違い」が混ざる。そこで、仕様は `claude-opus-5-5` の下書き 1 本に固定し、そこから作る役とシナリオの下書き役だけを振る。仕様が 1 本なので、作る役の K 回は、すべてのシナリオの組で採点できる。
2. **一致率ではなく、選んだ答えそのものを数える。** シナリオの照合は状態コードを幅で受けるなど甘く、また関係の無い不具合でも落ちる。合否の率は「選び方がそろったか」を測らない。そこで、五分の点（以下「決定」）ごとに、作る役が選んだ答えを見分ける要求の列（以下「探り」）を事前に書き、その応答から答えを機械的に決める。合否の率は、別に普通の正しさとして出す。
3. **シナリオの下書きを、モデルごとに 2 回取る。** 下書き 1 回だけだと、モデルの違いと「その 1 回の下書きの癖」が混ざる。
4. **依頼文の一文を外した組を足す（R と T を分ける）。** 1 の仕様から、依頼文の端数の一文に由来する文だけを取り除いた仕様（対照の仕様）を作り、同じ探りで作る役の答えを見る。仕様を下書きし直すと、取り除いた一文以外（インタフェース、未定の項目の書き方）も変わり、答えの変化を一文に帰せない（2 回目の設計レビューの指摘）。対照の仕様は作成担当が手で作り、元の仕様との差分を停止点 B でオーナーに見せる。インタフェースは元の仕様と同じバイト列を使う。
5. **作る役は、毎回まっさらな git リポジトリから始める。** 4 周目の出荷先には 4 周目の答えのコードと履歴がある。出荷先の clone から始めると、前の周の答えが見える。

### 何が分かり、何が分からないか

| 観測 | M なら | R・T なら |
|---|---|---|
| 作る役のモデルごとの最頻の答え | モデルで分かれる | そろう |
| シナリオの下書き役のモデルごとの答え | 同じモデルの作る役の最頻の答えと合う | 作る役のモデルによらず合う |

| 観測（端数の決定だけ） | R なら | T（または系統に共通の好み）なら |
|---|---|---|
| 仕様から依頼文の一文に由来する文を外したときの作る役の答え | 変わる | 変わらない |

- R と T を分けられるのは、依頼文の一文を外せる決定（端数の配り方）だけである。精算の組み方などは、依頼文の言葉を外すと依頼自体が成り立たないので、記述にとどめる。
- **T と「Claude 系統に共通の好み」は、この周では分けられない。** 2 つのモデルは同じ系統である。別の系統の作る役はアダプタの追加が要るので、この周の範囲の外とする。
- 同じ答えを返す別の作り方は、探りの入力で見分けられない限り、同じものとして数える（4 周目に、端数を分数のまま持つ作り方と通し番号で輪番にする作り方が、シナリオの入力では区別できなかった）。探りは、見分けたい作り方の組を事前に挙げて、その組を分ける入力で書く。

## この周の工場の変更

1. **役ごとのモデルの指定表を、実際の役の名前に合わせた**（`src/adapter.ts` の `MODEL_BY_ROLE`）。
   - これまでのキーは `drafter`・`builder`・`judge` で、`spec-drafter`・`scenario-drafter`・`classifier` は表に無く、黙って既定のモデルになっていた（4 周目の既知の限界）。
   - キーを `spec-drafter`・`scenario-drafter`・`classifier`・`builder`・`judge` にした。表に無い役でモデルを呼ぶと、既定にせずエラーにする。
   - テストで固定する: 下書き・作る・判定で実際に使われる役の名前が、すべて表のキーにあること。役ごとに指定したモデルが、CLI の `--model` に渡ること。
2. **コマンドごとに、役のモデルを指定できるようにした**（`--model <役>=<モデル>`、繰り返し可）。
   - `draft`・`replicate`・`probe-isolation` で使える。指定できる役は表のキーだけ、モデルは `claude-opus-5-5` と `claude-sonnet-5-5` だけ。それ以外は、モデルを呼ぶ前に拒む。
   - 指定した内容は記録（`draft-cost.json`、`replicates/*.json`、`isolation-probe.json`）に `requestedModels` として残る。実際に答えたモデルは、これまでどおり `byRoleModel` に残る。報告は `byRoleModel` で、指定どおりのモデルが答えたことを確かめる。
   - 分類は、どの組でも `claude-opus-5-5` のままにする（測る道具を変えない）。
3. **`draft --spec-from <id>` を足した**。承認済みの変更の仕様（とインタフェース）をそのまま使い、仕様の下書き役を呼ばずに、シナリオの下書きと分類だけを取る。
   - 元の変更と同じ依頼文でなければ拒む（`base.json` の依頼文の sha256 を比べる）。
   - 承認の版には、これまでどおり仕様も入る。元の変更と同じ仕様であることは、`spec.md` が同じバイト列であることで確かめられる。
   - `--spec <file>` を添えると、仕様の本文をそのファイルに差し替える（対照の仕様用）。インタフェースの節は、元の変更のものを工場が付け直す。このときは依頼文の一致を求めない（依頼文も一文を外したものを渡すため）。
4. **`replicate` コマンドを足した**。承認済みの変更から、作る役を独立に K 回走らせる。
   - 1 回ごとに、まっさらな git リポジトリ（commit 無し）で作る役を 1 回だけ呼ぶ。やり直しは無く、作る役に何も返さない。拡張の変更（`--base` 付きの下書き）では使えない。
   - できた commit を、判定と同じ方法で書き出し、次の 2 つを回す。LLM 判定は呼ばない。出荷もしない。
     - 隠しシナリオ（決定的テスト）: その変更と、`--score` で挙げた変更（同じ仕様のものに限る）のシナリオ。合否はこれまでと同じ定義。
     - 探り（`--probes <file>`）: 決定ごとに要求の列を流し、事前に挙げた答えのどれに当たるかを決める。
   - 記録: `$STATE/runs/<id>/replicates/<作る役のモデル>-<n>.json`。作る役の作業場所は `$STATE/work/<id>-rep/<作る役のモデル>-<n>/` に残る。同じコマンドをもう一度打つと番号を続けて足す（K を後から増やせる）。
   - 費用: 変更 1 つあたりの上限（`--max-cost`）は、下書きと、それまでのすべての `replicate` の費用を含めて数える。費用は呼び出しのたびに `replicate-cost.json` に足すので、途中で止まっても残る。lap 台帳の上限 $30 も効く。
   - `replicate` を使った変更には `run` を打てない（逆も同じ）。上限の数え方が 2 つに分かれるのを防ぐ。
   - `--rescore`: モデルを呼ばず、残っている作業場所の commit で、シナリオと探りを回し直す（探りの誤りを直したとき用）。記録には探りのファイルの sha256 が入るので、事前登録した版と違う探りで採点し直したことは記録から分かる。
5. **`tally` コマンドを足した**（モデルを呼ばない）。`replicate` の記録を集計し、決定ごとに作る役のモデル別の答えの数と、シナリオの組ごとの合格数を、Markdown の表で出す。

## 探りの書き方（作成担当）

探りのファイルは JSON で、決定の並びを持つ。

```json
{"decisions": [{
  "id": "remainder-rotation",
  "steps": [{"method": "POST", "path": "/groups", "body": {}, "capture": {"g": "id"}}, "..."],
  "observe": ["5:status", "5:body.balances"],
  "options": {"rotate-by-group-count": [[201, [...]]], "payer-absorbs": [[201, [...]]]}
}]}
```

- `steps` はシナリオの手順と同じ形で、`expect` は要らない。各決定は、新しく起動したアプリで流す。
- `observe` は、どの手順の何を見るか（`<手順番号>:status` か `<手順番号>:body.<dot.path>`、本文全体は `<手順番号>:body`）。
- `options` は、答えの名前と、その答えのときに `observe` が返す値の並び（順序の違いなど、同じ答えの見え方が複数あれば並べる）。どれにも当たらなければ `other`（実際の値を残す）、要求が途中で流せなければ `blocked`。
- 探りのファイルは保管庫の中（`$STATE/vault/<id>/probes.json`）に置く。作る役からは見えない場所で、工場はほかの場所の探りを拒む。

## 事前登録（作る役を走らせる前に固定するもの）

作成担当が停止点 B で書き、窓口へ送る。実行担当が保管庫に置き、sha256 を返す。作る役を走らせた後で書き換えていないことの証拠にする。

1. **探りのファイル**（1 本。`settle-a1` と `settle-c1` はインタフェースが同じなので、同じ探りを使う）。決定の一覧、見分けたい作り方の組、各作り方の期待する応答を含む。
2. **シナリオの下書き役が許す答え**（`settle-a1`・`settle-a2`・`settle-b1`・`settle-b2` の各シナリオの組について、決定ごとに、その組の期待値を通る答えの集合）。作成担当が期待値を読んで付ける。答えが 1 つだけなら、その組はその決定を**識別する**。全部の答えを通すなら `untested`。
3. **対照の仕様**（`settle-c1` 用）と、元の仕様との差分。
4. **判定の線**（下の「判定の線」）。

## 判定の線（事前に決める）

決定ごとに、作る役のモデル m の K 回（K = 8）の答えを数える。

- **答えとして数えるのは、事前に挙げた答えだけ。** `blocked`（要求が流せなかった）と `other`（どの答えにも当たらない）は欠測として別に数え、判定には使わない。`other` 同士は、値が同じでもまとめない。
- **有効な回数**: 事前に挙げた答えのどれかに当たった回数。どちらかのモデルで 6 回未満なら、その決定は「決められない」。
- **強くそろう**: 最頻の答えが 6 回以上。**強い好みが無い**: 有効な回数が 6 回以上で、最頻の答えが 4 回以下。

判定:

- **M を支持**: 2 つのモデルの作る役が、それぞれ強くそろい、かつ最頻の答えが違う。そのうえで、各モデルのシナリオの下書き（2 回）に、その決定を識別する組が 1 つ以上あり、識別する組がすべて同じモデルの作る役の最頻の答えを指し、識別しない組も（`untested` でなければ）その答えを許す。
- **M ではない（共通の答え）**: 2 つのモデルの作る役が、それぞれ強くそろい、最頻の答えが同じ。
- **強い好みが無い**: どちらかのモデルで強い好みが無い。4 周目の一致は、強制されたものではなかったことになる。
- それ以外（シナリオ側に識別する組が無い場合を含む）は「決められない」。K の打ち足しは、オーナーの承認を得てからにする（自動では打ち足さない）。
- **R を支持（端数の決定だけ）**: `settle-c1`（対照の仕様）で、どちらかのモデルの作る役の最頻の答えが `settle-a1` と変わる、または強くそろわなくなる（有効な回数の条件は上と同じ）。両方のモデルで最頻の答えが同じまま強くそろうなら、「この比較では、一文の効果を観測しなかった」とする（T か系統に共通の好みと矛盾しないが、R を否定はしない）。
- 統計的な検定はしない。K = 8 で言えるのは、上の線で分けた記述である。

合否の率（シナリオの組 × 作る役のモデル）は、普通の正しさとして別に出す。M の判定には使わない。

## 組み立て

| 変更 id | 依頼 | 仕様の下書き役 | シナリオの下書き役 | 作る役 |
|---|---|---|---|---|
| settle-a1 | split-settle.md | opus | opus | opus × 8、sonnet × 8（a1・a2・b1・b2 のシナリオと探りで採点） |
| settle-a2 | 同上 | （a1 の仕様を使う） | opus | （a1 の作る役で採点） |
| settle-b1 | 同上 | （a1 の仕様を使う） | sonnet | （a1 の作る役で採点） |
| settle-b2 | 同上 | （a1 の仕様を使う） | sonnet | （a1 の作る役で採点） |
| settle-c1 | split-settle-ablated.md（端数の一文を外したもの） | （a1 の仕様から一文に由来する文を外した対照の仕様。作成担当が作る） | opus | opus × 8、sonnet × 8（c1 のシナリオと探りで採点） |

分類はすべて opus。表の opus は `claude-opus-5-5`、sonnet は `claude-sonnet-5-5`。

## 題材と K

- **題材: 4 周目の割り勘の依頼（[requests/split-settle.md](../requests/split-settle.md)）をそのまま使う。**
  - 4 周目の結果（作る役 1 回の答え、別の妥当な作り方 7 通り）と比べられる。決定の候補（端数の配り方、精算の組み方、支払った人を受益者に含めるか）と、それを見分ける作り方の組が、4 周目の分析ですでに挙がっている。
  - 下書きはこの周で新しく取る。状態ディレクトリを新しく始めるため。
  - 依頼文の一文を外した版（[requests/split-settle-ablated.md](../requests/split-settle-ablated.md)）は、3 行目を「Amounts are in yen.」だけにしたもの。ほかは 1 文字も変えない。
- **K = 8**（作る役のモデル 1 つ、仕様 1 本あたり）。作る役は全部で 32 回。
  - 「強くそろう」を 8 回中 6 回以上と置くと、偶然の一致と区別しやすい（5 択で一様に選ぶなら、6 回以上がそろう確率は 1% 未満）。K = 5 では、この線を置けない。

## 担当

4 周目と同じ。

- **実行担当**: モデルの API に出られる普通の端末で、工場のコマンドを叩く人（claude-org の窓口役）。
- **作成担当**: 工場を実装し、探りと事前登録を書き、出力を集計して報告書（`docs/lap-5-report.md`）を書くエージェント。sandbox の中にあり、API に出られない。

## 予算

1 周の上限は $30（lap 台帳）。料金は 1M トークンあたり、`claude-opus-5-5` が入力 $4・出力 $20、`claude-sonnet-5-5` が入力 $2・出力 $10。1 回あたりの見積もりは 4 周目の実績から取り、sonnet は半額と見た。

| 項目 | 回数 | 1 回の見積もり | 小計 | sonnet も opus と同額で数えた小計 |
|---|---|---|---|---|
| 隔離の確認（作る役の各モデル） | 2 | $0.12 | $0.24 | $0.24 |
| 下書き settle-a1（仕様・シナリオ・分類、すべて opus） | 1 | $1.36 | $1.36 | $1.36 |
| 下書き settle-a2・settle-c1（シナリオ opus、分類 opus） | 2 | $1.29 | $2.58 | $2.58 |
| 下書き settle-b1・settle-b2（シナリオ sonnet、分類 opus） | 2 | $1.02 | $2.04 | $2.58 |
| 作る役 opus | 16 | $0.47 | $7.52 | $7.52 |
| 作る役 sonnet | 16 | $0.24 | $3.84 | $7.52 |
| **合計** | | | **約 $17.6** | **約 $21.8** |

- 窓口へ上げる線（1 周 $40）と、lap の上限 $30 の下にある。
- 料金が半分でも、`claude-sonnet-5-5` が長く考えたり手数を増やしたりすれば、費用は半分にならない。右端の列はその場合の見積もり。
- 変更 1 つあたりの上限は、settle-a1 と settle-c1 を `--max-cost 20`（下書き $1.4 と作る役 16 回、右端の列で約 $16.4）、ほかは既定の $10。
- 作る役 1 回の上限は、これまでどおり $5。
- 実行の順は、settle-a1 の作る役（主の実験）を先、settle-c1 を後にする。lap の上限に先に当たるなら、削れるのは R と T を分ける部分になる。

## 前提

- **cwd**: このリポジトリ（suisya-systems/factory）を checkout したディレクトリ。5 周目の変更を含む版（ブランチ `feat/factory-lap-5`、またはそれを取り込んだ main）であること。以下のコマンドは、すべてここで実行する。
- **実行環境**: Node 22.17 以上と `/usr/bin/bwrap`。依存はゼロ。認証と環境変数の扱いは 1 周目と同じ。
- **状態ディレクトリは新しく始める**（前の周の支出を数えないため）。`$HOME` の下にあること。
- **出荷先は要らない**。`replicate` は、作る役ごとにまっさらな git リポジトリを作る。
- **緊急停止**: 別の端末から `npm run factory -- stop`、または工場のプロセスに SIGTERM。

```bash
export FACTORY_HOME="$PWD/.factory-lap5"
STATE="$FACTORY_HOME"
OPUS=claude-opus-5-5
SONNET=claude-sonnet-5-5
test ! -e "$STATE/lap-ledger.json" && echo "fresh state: $STATE"
```

期待: `fresh state: ...`。出なければ止めて作成担当へ連絡する。

## 手順

### 1. 検証（費用なし）

```bash
npm test
```

期待: `# pass 94`、`# fail 0`、`# skipped 0`。

### 2. 隔離の確認（実モデル呼び出し、各上限 $1）

作る役の各モデルで 1 回ずつ。変更 id を分けるのは、記録（`isolation-probe.json`）を上書きしないため。

```bash
npm run factory -- probe-isolation lap5-probe-opus --model builder=$OPUS; echo "exit=$?"
npm run factory -- probe-isolation lap5-probe-sonnet --model builder=$SONNET; echo "exit=$?"
```

- 期待: どちらも `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: ここで止めて作成担当へ連絡する。以降は実行しない
- `exit=2` / `exit=3`: ここで止め、出力を作成担当へ送る

**停止点 A**: 出力と、`$STATE/runs/lap5-probe-*/isolation-probe.json` の中身を作成担当へ送る。作成担当は `requestedModels` と `costByModel` で、指定どおりのモデルが答えたことを確かめる。

### 3. 仕様の下書き settle-a1（実モデル呼び出し、上限 $20 のうち）

```bash
npm run factory -- draft settle-a1 --request requests/split-settle.md; echo "exit=$?"
```

期待: `drafted settle-a1 (version <hash>). Factory stopped; waiting for human approval. Summary: <path>`、`exit=0`。失敗時は出力を作成担当へ送る（費用は `$STATE/runs/settle-a1/draft-cost.json` に残る）。

**停止点 B1**: `$STATE/vault/settle-a1/` の `spec.md`・`approval-summary.md`・`assumptions.json` を作成担当へ送る。作成担当は 4 周目と同じく要約を作り、インタフェースに名前の形をした値が無いかを確かめる。オーナーの承認を得てから次へ。

```bash
npm run factory -- approve settle-a1 --by <承認者名> --version <要約に書かれた version>
```

### 4. シナリオの追加の下書き（実モデル呼び出し、各上限 $10）

settle-a1 の仕様をそのまま使う。仕様の下書き役は呼ばれない。

```bash
npm run factory -- draft settle-a2 --request requests/split-settle.md --spec-from settle-a1; echo "exit=$?"
npm run factory -- draft settle-b1 --request requests/split-settle.md --spec-from settle-a1 --model scenario-drafter=$SONNET; echo "exit=$?"
npm run factory -- draft settle-b2 --request requests/split-settle.md --spec-from settle-a1 --model scenario-drafter=$SONNET; echo "exit=$?"
cmp "$STATE/vault/settle-a1/spec.md" "$STATE/vault/settle-a2/spec.md" && cmp "$STATE/vault/settle-a1/spec.md" "$STATE/vault/settle-b1/spec.md" && cmp "$STATE/vault/settle-a1/spec.md" "$STATE/vault/settle-b2/spec.md" && echo "same spec"
```

期待: 3 つとも `drafted ...`、`exit=0`、最後に `same spec`。

### 5. 対照の仕様 settle-c1（作成担当が作る。実モデル呼び出しはシナリオと分類だけ、上限 $20 のうち）

作成担当が、settle-a1 の仕様の本文（`spec.md` の `## Interface` の節より前）から、依頼文の端数の一文に由来する文だけを取り除いたファイルを作り、窓口へ送る。実行担当はそれを `$STATE/control/settle-c1-spec.md` に置く。

```bash
mkdir -p "$STATE/control"   # ここに作成担当のファイルを置く
npm run factory -- draft settle-c1 --request requests/split-settle-ablated.md --spec-from settle-a1 --spec "$STATE/control/settle-c1-spec.md"; echo "exit=$?"
diff "$STATE/vault/settle-a1/spec.md" "$STATE/vault/settle-c1/spec.md"
```

期待: `drafted settle-c1 ...`、`exit=0`。`diff` は、作成担当が取り除いた文だけを示し、`## Interface` の節には差が無い。

**停止点 B2（入口の承認と事前登録、必須の人間ゲート）**:

1. settle-a2・b1・b2・c1 の `approval-summary.md` を作成担当へ送る。
2. 作成担当は次を作って窓口へ送る。
   - オーナー向けの要約（4 本のシナリオの組、c1 の `diff`）。
   - **事前登録**: 探りのファイル（`probes.json`）、各シナリオの組が許す答え（`prereg.json`）。中身は上の「探りの書き方」「事前登録」のとおり。
3. 実行担当が、探りを保管庫に置き、事前登録の sha256 を作成担当へ返す。**この時点より後に、探りと事前登録を書き換えない。**

```bash
cp <受け取った probes.json> "$STATE/vault/settle-a1/probes.json"
cp <受け取った probes.json> "$STATE/vault/settle-c1/probes.json"
mkdir -p "$STATE/prereg" && cp <受け取った prereg.json> "$STATE/prereg/prereg.json"
sha256sum "$STATE/vault/settle-a1/probes.json" "$STATE/vault/settle-c1/probes.json" "$STATE/prereg/prereg.json"
```

4. オーナーの承認を得てから承認を記録する。

```bash
for id in settle-a2 settle-b1 settle-b2 settle-c1; do npm run factory -- approve $id --by <承認者名> --version <その要約の version>; done
```

### 6. 作る役を K 回ずつ（実モデル呼び出し）

主の実験（settle-a1）を先に、対照（settle-c1）を後に流す。1 行が作る役 8 回で、1 回あたり数分〜20 分（上限 20 分）。

```bash
npm run factory -- replicate settle-a1 --k 8 --model builder=$OPUS   --score settle-a2,settle-b1,settle-b2 --probes "$STATE/vault/settle-a1/probes.json" --max-cost 20; echo "exit=$?"
npm run factory -- replicate settle-a1 --k 8 --model builder=$SONNET --score settle-a2,settle-b1,settle-b2 --probes "$STATE/vault/settle-a1/probes.json" --max-cost 20; echo "exit=$?"
npm run factory -- replicate settle-c1 --k 8 --model builder=$OPUS   --probes "$STATE/vault/settle-c1/probes.json" --max-cost 20; echo "exit=$?"
npm run factory -- replicate settle-c1 --k 8 --model builder=$SONNET --probes "$STATE/vault/settle-c1/probes.json" --max-cost 20; echo "exit=$?"
```

- 期待: 作る役 1 回ごとに `<モデル>-<n>: <sha> builderOk=true passed={...} probes=<決定>:<答え>,... cost=$...` が 1 行、最後に `exit=0`。
- 上限・緊急停止で止まった場合は `factory: cost cap ...` などで `exit=1`。そこまでの記録と費用は残る。同じ行を打ち直すと、番号を続けて足す（止まった回の番号は欠番になる）。打ち直す前に作成担当へ連絡する。
- 探りの誤り（すべて `blocked` になる、など）に気づいたら、続けずに作成担当へ連絡する。作成担当が探りを直したら、`replicate <id> --rescore --score ... --probes ...` で、モデルを呼ばずに採点し直せる（記録の `probesSha256` が変わり、事前登録の版と違うことが残る）。

**停止点 C**: 次を作成担当へ送る。

```bash
npm run factory -- tally settle-a1
npm run factory -- tally settle-c1
```

記録の場所:

- `$STATE/runs/settle-*/replicates/*.json`（作る役ごとの合否・探りの答え・費用）
- `$STATE/runs/settle-*/replicate-cost.json`、`$STATE/runs/settle-*/draft-cost.json`
- `$STATE/vault/settle-*/`（仕様・シナリオ・分類・仮定・探り）
- `$STATE/work/settle-a1-rep/`、`$STATE/work/settle-c1-rep/`（作る役の作業場所。報告で作る役のコードを読むのに使う。`for d in "$STATE"/work/settle-*-rep/*; do git -C "$d" bundle create "$d.bundle" --all; done` で 1 つずつファイルにできる）
- `$STATE/lap-ledger.json`、`$STATE/runs/lap5-probe-*/isolation-probe.json`

### 7. 後片付け

出荷していないので、止めるサーバも push するものも無い。
