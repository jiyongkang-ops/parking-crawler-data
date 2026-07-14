# parking-crawler-data

駐車場主要7社（タイムズ・三井のリパーク・ザ・パーク・名鉄協商・NPC・ナビパーク・エコロパーク）の
公開料金情報を、節度をもって定期収集するクローラと、その収集データ。**全国 約46,500物件**。

- 収集は GitHub Actions で1日3回（JST 9/15/21時）。同一物件の再訪間隔は概ね**1〜3日**
  （リパーク約2日・タイムズ約3日で全国1巡、NPC/ザ・パーク/エコロ/ナビパーク/名鉄協商はほぼ毎回全件）。
- 料金は**原文のまま保存**（正規化しない）。変更履歴は**追記型**で全件保持。
- 節度ある収集5原則: 公開ページのみ / 低頻度 / 直列・待機つき / robots尊重 / 目的限定。

## データの使い方（エンジニア向け）

### ファイル

| パス | 内容 |
|---|---|
| `data/prices*.jsonl` | 料金スナップショット（1行=1取得、**追記型**）。`prices.jsonl`=リパーク+NPC、`prices-times.jsonl`=タイムズ、`prices-ecolo.jsonl`、`prices-navipark.jsonl`、`prices-others.jsonl`=ザ・パーク+名鉄協商 |
| `data/parking-latest.csv` | 全物件の**最新状態のみ**をフラット化したCSV（BOM付き・Excel可） |
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
- `.github/workflows/crawl-*.yml` — 定期実行（public リポジトリのため Actions 無料）
- 分析・レポート生成は別リポジトリ（private）で行い、本リポジトリのデータを参照する
