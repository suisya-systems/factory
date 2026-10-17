# 6 周目の実行手順

工場の 6 周目を回すための手順。5 周目（[lap-5-runbook.md](lap-5-runbook.md)、結果は [lap-5-report.md](lap-5-report.md)）の仕組みはそのまま使う。この周は、5 周目の報告の「次の周への提案」1（シナリオの下書き役に少数派の答えを選ばせる。4 周目の提案 2 と同じもの）を回し、前提 2 を初めて試す。

## 何を確かめるか

**前提 2**: 作る役が一度落ちても、承認済みの 1 行要約だけを返してやり直させれば、合格に近づく。

1〜5 周目では、シナリオの下書き役と作る役が、仕様の決めていない点で同じ答えを選んだ。そのため、作る役は 1 回目で通り、やり直しが一度も起きなかった。5 周目では、作る役 16 回（opus 8・sonnet 8）が 3 つの決定（端数・支払った人の扱い・精算の組み方）で全員同じ答えを選び、モデルを変えても散らばらなかった。やり直しを起こすには、シナリオの側で多数派でない答えを意図して選ぶしかない。

そこでこの周は、シナリオの下書き役に「依頼と慣習で決まらない点で、多くの実装者が選ばない、妥当な答え」を選ばせ、その仮定に印を付けさせる。作る役は通常の `run` で走らせる（試行上限 5、不通過の理由は承認済みの 1 行要約だけ、決定的テストと LLM 判定の AND、出荷あり）。試行ごとに、少数派の答えを確かめるシナリオ（以下「少数派シナリオ」）が通るようになるかを数える。

### 設計の要点

着手前の設計レビュー（Codex、1 回。Blocker 0・Major 4・Minor 2）の指摘を反映した。

1. **仕様は 5 周目の settle-a1 をそのまま使う。** 5 周目の承認済みの `vault/settle-a1` を、この周の状態ディレクトリにコピーし、`draft --spec-from settle-a1` でシナリオだけを下書きする。この仕様で作る役が 3 つの決定に何を選ぶかは、5 周目の 16 回で分かっている（16/16 で同じ答え）。下書き役が 3 つの決定のどれかで少数派を選べば、それが本当に少数派であることを、費用なしで裏付けられる。承認の検査は、ファイルの sha256 と `approval.json` の版だけを見るので、コピーでも通る。
2. **少数派シナリオは、入口で参照実装により確かめる**（下の「入口の確認」）。宣言どおりの答えで作った参照実装で通り、その答えだけを多数派に戻すと落ちるシナリオだけを、判定に使う少数派シナリオにする（設計レビュー Major 1）。期待値の計算の誤りも、ここで拾う（5 周目の settle-b1 の穴への、この周の手当て。工場のコードには入れない）。
3. **シナリオの組を 2 つ取り、組ごとに作る役を 3 回走らせる。** 1 回の下書きの癖と分けるため。結果は組ごとに必ず並べ、合算だけで書かない（設計レビュー Major 3）。
4. **1 つの承認済みの組から 3 回走らせるため、承認済みの vault ディレクトリを別の id にコピーする**（`minor-1` → `minor-1-b`・`minor-1-c`）。中身はバイト単位で同じで、承認の版も同じ（設計レビューの質問 2 で問題なしの判断）。`runs/` はコピーしない。下書きの費用は元の id（`minor-1`）の上限にだけ入る。
5. **run ごとに新しい出荷先を作る。** `run` の作業場所は出荷先の clone から始まるので、前の run の答えが見えないようにする。
6. **作る役が少数派シナリオで落ちた理由と、それ以外の理由を分けて数える**（設計レビュー Major 2）。少数派シナリオの合否・それ以外のシナリオの合否・LLM 判定・打ち切りを、試行ごとに別の列にする。

### 何が分かり、何が分からないか

- 分かること: **この題材・この 1 行要約・この通常のループで**、少数派シナリオで一度落ちた作る役が、5 回以内にそれを通すようになった割合。
- 分からないこと: 1 行要約の効果と、やり直しによる偶然の変化の切り分け。要約を返さない対照の run は置かない（費用の都合）。ただし、3 つの決定については、5 周目の作る役 16 回（要約なし・同じ仕様）がすべて多数派の答えを選んでいる。要約なしでは少数派の答えはまず出ない、という参考にはなる。3 つの決定の外の点には、この参考も無い。
- 分からないこと: ほかの題材・ほかのモデルでの前提 2。

## この周の工場の変更

1. **`draft --minority`**（`src/roles.ts`、`src/cli.ts`）。
   - シナリオの下書き役への指示に、1 段落を足す。依頼と慣習で決まらず、複数の答えが妥当な点を 2〜3 個選ぶ。各点で、多くの実装者が選ばない妥当な答えを意図して選び、それを確かめるシナリオを 1 本以上書く。依頼が述べていることは満たす。状態コードは選ばない（既存の指示「依頼が決めない状態コードは妥当なものをすべて受ける」とぶつかるため）。
   - 各点を、仮定に `[minority] <点>: <選んだ答え> (most would: <普通の答え>); scenarios: <id>, <id>` の形で書かせる。
   - 工場の検査（落ちたら既存の修理 1 回）: 印の付いた行が 1 つ以上あること。各行がこの形で、点・答え・普通の答えが空でないこと。挙げた id が、すべてそのシナリオの組にあること。指示は「2〜3 個」だが、検査は「1 個以上」（妥当な点が 1 つしか無いときに、無理な点を作らせないため）。
   - 承認の要約に「## Minority choices」の節を足し、印の付いた仮定を並べる（仮定は `(scenario writer) ` を頭に付けて保存されるので、行頭ではなく行の中で `[minority]` を探す）。
   - 1 行要約の決まり（値を含めない。作る役が落ちたときに見るのはこれだけ）は変えない。前提 2 は、工場の通常の決まりのままで試す。
   - 作る役には、これまでどおり仕様だけを渡す。仮定（印を含む）は作る役に渡らない。
2. ほかのコードは変えない。集計と入口の確認の道具は `docs/lap-6/` に置く（工場の外）。
   - `docs/lap-6/entrance.ts`: シナリオの組を、宣言どおりの答えにした参照実装で流し、各答えを 1 つずつ多数派に戻したときに落ちるシナリオを出す。
   - `docs/lap-6/attempts.ts`: run の記録から、試行ごとの表と、run の分類・判定（下の「判定の線」）を出す。`--self-test` で分類の規則を確かめられる。

## 入口の確認（作成担当、費用なし）

停止点 B で、各シナリオの組について次を行い、結果をオーナー向けの要約に載せる。

1. 下書き役が宣言した少数派の答えを、5 周目の参照実装（[docs/lap-5/refapps/server.cjs](lap-5/refapps/server.cjs)。端数 7 通り・精算 2 通り・負担者 3 通りを切り替えられる）の設定に写す。参照実装に無い答えなら、作成担当が参照実装に切り替えを足す（足した版は `docs/lap-6/refapps/server.cjs` に置き、既定の動きは 5 周目と同じに保つ）。参照実装に写せない答えは「参照実装で確かめていない」と書く。
2. `entrance.ts` で、宣言どおりの参照実装で全シナリオを流す。落ちたシナリオは、次の 3 つのどれかを作成担当が読んで決める: 期待値の誤り（計算・依頼との食い違い）／宣言されていない別の選択／参照実装の不足。参照実装の不合格だけで下書きを捨てない（設計レビュー Major 4）。金額の期待値は、作成担当が手でも計算する。
3. 各少数派の答えを 1 つずつ多数派に戻し、落ちるシナリオを出す。**宣言どおりで通り、戻すと落ちるシナリオ**を、その組の「確かめた少数派シナリオ」とする。宣言の `scenarios:` に挙がっていても、この条件を満たさないものは判定に使わない（表には別に出す）。
4. 期待値の誤りが見つかった組は、承認しない。工場はシナリオを編集できないので、別の id で下書きし直す（オーナーの判断）。
5. 確かめた少数派シナリオが 1 本も無い組も、承認しない（前提 2 を試せないため）。

## 事前登録（作る役を走らせる前に固定するもの）

作成担当が停止点 B で `docs/lap-6/prereg.json` を書き、窓口へ送る。実行担当が状態ディレクトリに置き、sha256 を返す。

```json
{"maxAttempts": 5, "sets": {"minor-1": {"runs": ["minor-1", "minor-1-b", "minor-1-c"], "minority": ["<確かめた少数派シナリオの id>", "..."]}, "minor-2": {"...": "..."}}}
```

## 判定の線（事前に決める）

run ごとに、確かめた少数派シナリオ（組ごとの `minority`）で分類する。

- **P1**: 1 回目で少数派シナリオがすべて通った（作る役が自分で少数派の答えを選んだ。やり直しは試されない）。
- **CONV**: 1 回目は少数派シナリオのどれかで落ち、5 回以内のどこかの試行で、少数派シナリオがすべて通った。
- **INCOMPLETE**: CONV に届かないまま、5 回目より前に止まった（変更の上限・lap の上限・緊急停止・エラー）。判定から外す。
- **NEAR**: 5 回目まで走り、少数派シナリオの合格数が 1 回目より最後の試行で多く、それ以外のシナリオの合格数が 1 回目より減っていない。
- **STUCK**: それ以外。

判定（組ごとと、2 組を合わせたものの両方で出す）:

- 試された run（CONV・NEAR・STUCK）が 3 未満: **決められない**。
- 試された run の過半が CONV: **前提 2 を支持**（この題材・この要約・この通常のループで観測した、という限定つき）。
- 試された run の過半が STUCK: **前提 2 を支持しない**。
- それ以外: **決められない**。
- 統計的な検定はしない。

判定とは別に、次を記述として出す。

- 決定的テストがすべて通った試行と、AND（LLM 判定も通る）で合格した試行・出荷した run を、別に数える。LLM 判定だけで落ちた試行は、少数派シナリオの収束とは別の理由として数える。
- 試行 n で通り、n+1 で落ちたシナリオ（後退）。
- 各少数派シナリオの 1 行要約（作る役が実際に受け取った文）と、それで直せたか。
- 少数派の答えが 3 つの決定のどれかに当たる場合、5 周目の作る役 16 回の答え（多数派の裏付け）。

## 組み立て

| 変更 id | シナリオの下書き | 作る役 |
|---|---|---|
| settle-a1 | （5 周目の承認済みの組をコピー。仕様の元として使うだけで、run しない） | — |
| minor-1 | `--spec-from settle-a1 --minority`、シナリオの下書き役 opus | `run`（opus） |
| minor-1-b、minor-1-c | minor-1 の承認済みの組をコピー | `run`（opus）各 1 回 |
| minor-2 | minor-1 と同じ条件で、もう 1 回下書き | `run`（opus） |
| minor-2-b、minor-2-c | minor-2 の承認済みの組をコピー | `run`（opus）各 1 回 |

分類・LLM 判定・作る役は、すべて `claude-opus-5-5`（工場の既定のまま）。

## 予算

1 周の上限は $30（lap 台帳）。窓口へ上げる線は 1 周 $40。料金は 5 周目と同じ。1 回あたりの見積もりは 5 周目の実績から取った。

| 項目 | 回数 | 1 回の見積もり | 小計 |
|---|---|---|---|
| 隔離の確認（作る役 opus） | 1 | $0.35 | $0.35 |
| 下書き minor-1・minor-2（シナリオ opus $0.40 + 分類 約 14 本 × $0.048） | 2 | $1.10 | $2.20 |
| 試行（作る役 $0.40 + LLM 判定 $0.16） | 6 run × 平均 3 試行 = 18 | $0.56 | $10.08 |
| **合計（見込み）** | | | **約 $12.6** |
| 試行が 30 回（6 run がすべて 5 回まで走る）ときの概算 | 30 | $0.56 | 合計 約 $19.4 |

- これは上限ではない。1 回の呼び出しの上限は、作る役 $5・LLM 判定 $2 で、時間切れの呼び出しはこの上限で数える。下書きの修理や下書きのし直しも増える。工場が止める線は、変更 1 つあたり $10（既定）と lap の $30。
- **lap の上限で止まった場合**: 止まった run は INCOMPLETE、走らなかった run は数えない。そのまま判定の線を当てる（打ち足しはオーナーの承認を得てから）。そのため、run は 2 つの組を交互に流す。

## 担当

5 周目と同じ。

- **実行担当**: モデルの API に出られる普通の端末で、工場のコマンドを叩く人（claude-org の窓口役）。
- **作成担当**: 工場を実装し、入口の確認・事前登録・集計・報告書（`docs/lap-6-report.md`）を書くエージェント。sandbox の中にあり、API に出られない。

## 前提

- **cwd**: このリポジトリ（suisya-systems/factory）を checkout したディレクトリ。6 周目の変更を含む版（ブランチ `feat/factory-lap-6`、またはそれを取り込んだ main）であること。以下のコマンドは、すべてここで実行する。
- **実行環境**: Node 22.17 以上と `/usr/bin/bwrap`。依存はゼロ。認証と環境変数の扱いは 1 周目と同じ。
- **状態ディレクトリは新しく始める**（前の周の支出を数えないため）。`$HOME` の下にあること。
- **5 周目の状態ディレクトリ**（`.factory-lap5`）が手元にあること（`vault/settle-a1` をコピーする）。
- **緊急停止**: 別の端末から `npm run factory -- stop`、または工場のプロセスに SIGTERM。

```bash
export FACTORY_HOME="$PWD/.factory-lap6"
STATE="$FACTORY_HOME"
LAP5="$PWD/.factory-lap5"
test ! -e "$STATE/lap-ledger.json" && test -f "$LAP5/vault/settle-a1/approval.json" && echo "fresh state: $STATE"
```

期待: `fresh state: ...`。出なければ止めて作成担当へ連絡する。

## 手順

### 1. 検証（費用なし）

```bash
npm test
node --experimental-strip-types --no-warnings docs/lap-6/attempts.ts --self-test
```

期待: `# pass 95`、`# fail 0`、`# skipped 0`。続けて `self-test ok`。

### 2. 隔離の確認（実モデル呼び出し、上限 $1）

```bash
npm run factory -- probe-isolation lap6-probe; echo "exit=$?"
```

- 期待: `isolation probe: canaryFound=false modelOk=true ...`、`exit=0`
- `exit=1`（カナリアが読めた）: ここで止めて作成担当へ連絡する。以降は実行しない
- `exit=2` / `exit=3`: ここで止め、出力を作成担当へ送る

### 3. 5 周目の仕様を持ってくる（費用なし）

```bash
mkdir -p "$STATE/vault"
cp -a "$LAP5/vault/settle-a1" "$STATE/vault/settle-a1"
diff -r "$LAP5/vault/settle-a1" "$STATE/vault/settle-a1" && echo "same settle-a1"
```

期待: `same settle-a1`。

### 4. 少数派のシナリオの下書き（実モデル呼び出し、各上限 $10）

```bash
npm run factory -- draft minor-1 --request requests/split-settle.md --spec-from settle-a1 --minority; echo "exit=$?"
npm run factory -- draft minor-2 --request requests/split-settle.md --spec-from settle-a1 --minority; echo "exit=$?"
cmp "$STATE/vault/settle-a1/spec.md" "$STATE/vault/minor-1/spec.md" && cmp "$STATE/vault/settle-a1/spec.md" "$STATE/vault/minor-2/spec.md" && echo "same spec"
```

期待: 2 つとも `drafted ...`、`exit=0`、最後に `same spec`。検査で落ちた（`exit=1`）ときは、`$STATE/runs/minor-*/rejected-*.json` を作成担当へ送る。

**停止点 B（入口の確認・事前登録・承認、必須の人間ゲート）**:

1. 次を作成担当へ送る: 各組の `$STATE/vault/minor-*/` の `approval-summary.md`・`scenarios.json`・`assumptions.json`。
2. 作成担当が上の「入口の確認」を行い、オーナー向けの要約と `docs/lap-6/prereg.json` を窓口へ送る。
3. 実行担当が事前登録を置き、sha256 を作成担当へ返す。**この時点より後に、事前登録を書き換えない。**

```bash
mkdir -p "$STATE/prereg" && cp <受け取った prereg.json> "$STATE/prereg/prereg.json"
sha256sum "$STATE/prereg/prereg.json"
```

4. オーナーの承認を得てから、承認を記録し、承認済みの組をコピーする。

```bash
for id in minor-1 minor-2; do npm run factory -- approve $id --by <承認者名> --version <その要約の version>; done
for id in minor-1 minor-2; do for s in b c; do cp -a "$STATE/vault/$id" "$STATE/vault/$id-$s" && diff -r "$STATE/vault/$id" "$STATE/vault/$id-$s" && echo "copied $id-$s"; done; done
```

期待: `approved ...` が 2 行、`copied ...` が 4 行。

### 5. 作る役を走らせる（実モデル呼び出し）

1 行が 1 run（最大 5 試行、1 試行あたり数分〜20 分）。2 つの組を交互に流す。run ごとに新しい出荷先を作る。

```bash
for id in minor-1 minor-2 minor-1-b minor-2-b minor-1-c minor-2-c; do
  T="$STATE/ship/$id"
  git init -q -b main "$T" && printf '# split settle\n' > "$T/README.md" && git -C "$T" add -A && git -C "$T" -c user.name=factory -c user.email=factory@localhost commit -qm init
  npm run factory -- run $id --ship-target "$T" --port 8787 --traffic-base /groups; echo "$id exit=$?"
done
```

- 期待: run ごとに `<id>: shipped; attempts N`（`exit=0`）か `<id>: failed (retry cap reached: 5 attempts without a pass); attempts 5`（`exit=1`）。どちらも想定内なので、次の run へ進む。
- `failed (lap cost cap ...)` や緊急停止で止まったら、そこで止めて作成担当へ連絡する（残りの run は打たない）。
- `--traffic-base` は合成トラフィックの宛先。合成トラフィックはメモ API の形のままなので、この周でも本番の観測にはほとんど意味が無い（4 周目からの既知の限界）。

**停止点 C**: 次を作成担当へ送る。

```bash
node --experimental-strip-types --no-warnings docs/lap-6/attempts.ts "$STATE/prereg/prereg.json" "$STATE"
```

記録の場所:

- `$STATE/runs/minor-*/run.json`（試行ごとのシナリオの合否・LLM 判定・費用）、`$STATE/runs/minor-{1,2}/draft-cost.json`
- `$STATE/vault/minor-*/`（シナリオ・仮定・分類・承認）
- `$STATE/work/minor-*/`（作る役の作業場所。試行ごとに 1 commit。`git -C "$d" bundle create "$d.bundle" --all` で 1 つずつファイルにできる）
- `$STATE/lap-ledger.json`、`$STATE/runs/lap6-probe/isolation-probe.json`

### 6. 後片付け

```bash
kill "$(cat "$STATE/prod/server.pid")"
```

出荷先（`$STATE/ship/minor-*`）は手元だけのリポジトリで、push するものは無い。
