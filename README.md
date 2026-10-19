# parking-crawler-data

駐車場主要7社（タイムズ・三井のリパーク・ザ・パーク・名鉄協商・NPC・ナビパーク・エコロパーク）の
公開料金情報を、節度をもって定期収集するクローラと、その収集データ。**全国 約46,500物件**。

- 収集は GitHub Actions。**NPC・三井のリパークは1時間おき**（満空が取れる2社。1周25時間で
  同じ物件を見る時刻が1時間ずつずれ、約25日で24時間・7回の観測で7曜日を通る）、
  **他社は1日2〜3回**。同一物件の再訪間隔は概ね**1〜3日**
  （リパーク約1日・タイムズ約10日・エコロ約2日で全国1巡、ザ・パーク/ナビパーク/名鉄協商はほぼ毎回全件）。
  エコロの一覧は先方のサイトマップ（約3,945件）から作る（2026-10-18。それまではエリアページの1ページ目＝各10件だけで1,032件だった）。
  タイムズは1日3回・1回90分（約900件）。Advisor の優先物件（約620件）はおおむね1日1回取り直す（2026-10-17。それまでは1回45分・約16日で1巡で、優先物件は番号の書き方の違いで1件も効いていなかった）。
- 満空（空車/混雑/満車）は NPC・三井のリパークから取得し、`data/vacancy-YYYY-MM.jsonl` に
  巡回のたび追記する（料金の変動とは無関係に毎回残す）。名前・座標は `data/vacancy-lots.jsonl`
  （追記型・同じ物件は最後の行が最新）。NPCは `crawl-npc.yml` が1回の実行で27分おきに11回採る
  （`VACANCY_ONLY=1` で料金は書かない。定時実行の遅れで時間帯に穴が空くのを埋めるため）。
- 物件一覧（sitemap / ids）の鮮度は、となりに置く **`<file>.fetched`（取得日時）** だけで測る（`src/cache-age.js`）。
  mtime は checkout が毎回「今」にし、git の最終コミット時刻も**浅いクローン（fetch-depth:1）では常に「今」**を返すため、
  どちらでも一度も更新されず、7月の一覧のまま2か月止まっていた。作り直しは1回の実行で2件まで（`LIST_REFRESH_MAX`）。
- `dashboard.html` と統一CSVは `publish.yml` で1日1回作る（毎時コミットすると派生物だけで月75MB太る）。
- ローリング巡回は `ROLLING_BUDGET_MIN`（既定45分。毎時の `crawl.yml` は50分、タイムズの `crawl-times.yml` は90分）で切り上げ、状態を50件ごとに保存する。
  途中で殺されても、そこまでの観測と巡回状態は `if: always()` のコミットで残る。
- 料金は**原文のまま保存**（正規化しない）。変更履歴は**追記型**で全件保持。
- 節度ある収集5原則: 公開ページのみ / 低頻度 / 直列・待機つき / robots尊重 / 目的限定。

## データの使い方（エンジニア向け）

### ファイル

| パス | 内容 |
|---|---|
| `data/prices*.jsonl` | 料金スナップショット（1行=1取得、**追記型**）。`prices.jsonl`=リパーク+NPC、`prices-times.jsonl`=タイムズ、`prices-ecolo.jsonl`、`prices-navipark.jsonl`、`prices-others.jsonl`=ザ・パーク+名鉄協商 |
| `data/parking-latest.csv` | 全物件の**最新状態のみ**をフラット化したCSV（BOM付き・Excel可） |
| `data/carshare-times.jsonl` | タイムズの駐車場にタイムズカー（カーシェア）があるか（`on`）とステーション番号（`scd`）。料金のために取っているページから読むので追加の取得なし。台数は無い。1行＝1物件の状態で、変わったときだけ追記 |
| `data/carshare-mitsui.jsonl` | 三井のカーシェアーズのステーション（名前・住所・座標・台数・車種クラス別の台数）。`crawl-carshares.yml` で週1回1巡。変わったときだけ追記、見なくなったら `gone:1`。予約・空き状況は取らない。サイトポリシーが私的利用の範囲のため、社内の分析にとどめ転載しない |
| `data/*-crawl-state.json` ほか | ローリング巡回の内部状態（分析には不要） |

### レコードスキーマ（JSONL 1行）

```jsonc
{
  "operator": "ecolo",            // times | repark | thepark | mkp | npc | navipark | ecolo
  "parkId": "6901",               // 事業者内で一意（operator+parkId が物件キー）
  "name": "エコロパーク ◯◯駐車場",
  "address": "広島県広島市南区…",
  "lat": 34.88, "lng": 132.46,    // 無い事業者もある（タイムズ等は null → 住所で扱う）
  "capacity": 6,                  // 収容台数（不明なら null）
  "openingHours": "24時間",
  "unitCharges": [                 // 通常料金（時間貸し単価）。複数=時間帯/曜日で異なる
    { "timeRange": "08:00-20:00", // 適用時間帯（無い事業者もある）
      "scope": "月~金",           // 適用曜日（省略時は全日）
      "perMinutes": 30, "amountYen": 200 }
  ],
  "maxFees": [                     // 最大料金。複数併存あり
    { "scope": "全日",
      "condition": "24時間",      // 例: "24時間" / "20:00～8:00以内" / "駐車後24時間 最大料金"
      "type": "night",            // 正規化済みの型（night/daytime/d24h）。無い場合は condition から判断
      "amountYen": 500 }
  ],
  "changedFromPrev": true,         // 前回取得時から内容が変わったスナップショットに立つフラグ
  "fetchedAt": "2026-07-10T04:52:08.261Z",  // 取得日時（改定日そのものではない点に注意）
  "sourceUrl": "https://…"        // 取得元の公開ページ
}
```

### 読み方の基本（Node.js）

```js
import fs from "node:fs";
// 物件ごとの最新状態
const latest = new Map();
for (const f of fs.readdirSync("data").filter(f => /^prices.*\.jsonl$/.test(f))) {
  for (const line of fs.readFileSync(`data/${f}`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    const k = `${r.operator}:${r.parkId}`;
    if (!latest.has(k) || r.fetchedAt > latest.get(k).fetchedAt) latest.set(k, r);
  }
}
// 料金改定の抽出: 物件ごとに時系列に並べ、changedFromPrev の行で前行と料金を比較する
```

Python なら `pandas.read_json("data/prices-ecolo.jsonl", lines=True)`。

### 分析時の注意（重要）

1. **追記型**: 同一物件の行が複数ある。最新状態が欲しければ `fetchedAt` 最大の行を取る。
2. **`fetchedAt` は「確認日」**: 実際の改定はその1〜3日前の可能性がある（巡回間隔ぶん）。
3. **初回補完**: 前回取得が空（units/maxes とも無し）→ 値ありへの変化は改定ではなくデータ補完。
4. **フラップ**: 「1回だけ観測された状態が直後に完全に元へ戻る」ことがある
   （イベント日料金の一時掲出・ページの表示ゆらぎ）。改定として扱わないこと。
5. **イベント日料金**: `scope` に「イベント」を含む行は期間限定の掲出。恒常料金と区別する。
6. **タイムズの「月～金」**: ページ内部タグ由来で、土日祝の別建てが無ければ実質「全日」。
7. 日本語の物件名・住所は **NFC/NFD の正規化差**に注意（macOSと比較する場合は `normalize("NFC")`）。

### 単価の比較は「円/分」で

`40分100円`（2.5円/分）と `60分200円`（3.3円/分）は同じ「◯◯円」でも水準が違う。
比較は `amountYen / perMinutes` に揃えることを推奨。

## 利用ポリシー

各社の公開ページから収集した情報です。社内・関係者の分析用途を想定しています。
**一般向けの再配布・商用の料金比較サービス等への転用はご遠慮ください。**
問い合わせ: jiyong.kang@landit.co.jp

## 構成（開発者向け）

- `src/` — 事業者別クローラ（`node src/run.js`）。`config.js` に節度設定を集約
- `.github/workflows/crawl-*.yml` — 定期実行（public リポジトリのため Actions 無料）。起動のしかたは下の「定期実行の起動」
- 分析・レポート生成は別リポジトリ（private）で行い、本リポジトリのデータを参照する

## 定期実行の起動

GitHub の cron は混むと数時間遅れて始まり、正時（:00）の枠は落ちることもあるので、**cron は使っていない**
（2026-10-04〜10-17 の14日で、エコロ・ナビパーク・名鉄協商ほかは予定42回のうち32〜33回、NPC の満空は56回のうち44回しか走らず、
走った回も中央値で約4〜5時間遅れていた）。
Cloud Scheduler（poc-aimo / asia-northeast1 の `crawl-parking-vacancy-hourly`、毎時07分JST）が `crawl.yml` を起動し、
`crawl.yml` の `dispatch` ジョブが、ほかの巡回を JST の決まった時刻に `workflow_dispatch` で起動する（2026-10-18〜。タイムズは 2026-09-27〜）。
1日の回数はもとの cron のままで、先方への負荷は変えていない。

| ワークフロー | 起動のしかた | JST の時（07分ごろ） | 1日の回数 | もとの cron（UTC） |
|---|---|---|---|---|
| `crawl.yml`（NPC・リパーク） | Cloud Scheduler | 毎時 | 24 | 2026-09-15 にやめた |
| `crawl-times.yml` | crawl.yml から | 昼9〜14時・夕方15〜20時・夜〜朝21〜翌8時から1回ずつ（日ごとにずらす） | 3 | 2026-09-27 にやめた |
| `crawl-others.yml`（名鉄協商・ザ・パーク） | crawl.yml から | 10・16・22時 | 3 | `0 1,7,13` |
| `crawl-npc.yml`（NPC の満空を27分おきに11回） | crawl.yml から | 4・10・16・22時 | 4 | `13 1,7,13,19` |
| `crawl-navipark.yml` | crawl.yml から | 11・17・23時 | 3 | `0 2,8,14` |
| `crawl-extra.yml`（キョウテク・ル・パルク・GSパーク） | crawl.yml から | 11・23時 | 2 | `30 2,14` |
| `crawl-ecolo.yml` | crawl.yml から | 1・13・19時 | 3 | `0 4,10,16` |
| `crawl-extra2.yml`（スペース二十四・JQパークス・パークネット） | crawl.yml から | 2・14時 | 2 | `30 5,17` |
| `crawl-extra3.yml`（タマパーク他） | crawl.yml から | 5・17時 | 2 | `30 8,20` |
| `crawl-carshares.yml` | crawl.yml から | 3時（1巡が終わって7日たつまでは何もせず終わる） | 1 | `0 18` |
| `publish.yml`（dashboard.html・統一CSV） | crawl.yml から | 6時（studio-data の7:30より前） | 1 | `40 21` |

- **cron のままのワークフローは無い。** 新しく足すときも、cron と crawl.yml の両方からは起動しない（同じ回が2回走り、先方への負荷が増える）。
  時刻表は `crawl.yml` の `dispatch` ジョブの `FIXED` にあり、`test/dispatch-schedule.test.js` がこの表・回数・重なりを確かめる。
- 起動に失敗しても毎時の巡回（NPC・リパーク）は止まらない（別のジョブにしてある）。失敗は `::warning::` になり、
  起動されなかった回（Cloud Scheduler の抜け・gh の失敗）は、2時間あとまでの毎時の回で1回だけ取り戻す。
  同じ時に2回起動されても（手での実行など）、2回目は何も起動しない。
- 同じワークフローの回と回の間（6時間以上）は、どのジョブの時間切れ（最長350分）より長い。前の回が残っていても、
  concurrency（`cancel-in-progress: false`）で終わるのを待ってから走る（同時には走らない）。
- どのワークフローにも `workflow_dispatch` の入力は無い。手で1回だけ動かすときは Actions の画面か `gh workflow run crawl-ecolo.yml` など。
- Cloud Scheduler が止まると、すべての巡回が止まる（2026-10-17 までは crawl.yml とタイムズだけだった）。
  各ワークフローの health（`data/health/*.json`）の `at` が更新されなくなる。
