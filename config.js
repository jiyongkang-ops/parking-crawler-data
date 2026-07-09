// 収集設定 ----------------------------------------------------------------
// 「節度ある収集」の挙動はここで一元管理する。

export const config = {
  // 正体を明かす User-Agent（用途と連絡先を明記）
  userAgent:
    "PitPortResearchBot/0.1 (parking price research; +mailto:jiyong.kang@landit.co.jp)",

  // アクセス間隔（ミリ秒）。1リクエストごとに最低この時間スリープ（直列実行）
  minDelayMs: 4000,

  // robots.txt のキャッシュ有効期間（ミリ秒）
  robotsCacheMs: 24 * 60 * 60 * 1000,

  // 同一ページの再取得を抑制するキャッシュ期間（ミリ秒）。
  // この期間内に既に取得済みなら取得をスキップする。
  pageCacheMs: 6 * 60 * 60 * 1000,

  // リクエストのタイムアウト（ミリ秒）
  timeoutMs: 20000,

  // 取得対象。自社サブリース物件の周辺競合をここに登録していく。
  //   repark: { operator:"repark", parkId:"REP00xxxxx" }  個別物件単位
  //   npc:    { operator:"npc", cityId:"685", prefId:13 } 市区町村単位（その市区の全NPC物件を一括取得）
  targets: [
    // 日本パーキング(NPC) — 全国を bbox API で一括取得（1リクエストで全国 約1,700件）
    { operator: "npc", mode: "nationwide", label: "NPC全国" },

    // 三井のリパーク — 全国16,000件超を sitemap からローリング巡回（数日で1巡）
    { operator: "repark", mode: "nationwide", label: "repark全国" },

    // タイムズ — 全国 約21,700件を sitemap からローリング巡回。
    // ※先方が商用ボットを名指しブロックしているため、間隔を長め(timesMinDelayMs)に設定。
    // ※ジョブ時間の都合で別ワークフロー(crawl-times.yml, CRAWL_ONLY=times)で実行。
    { operator: "times", mode: "nationwide", label: "タイムズ全国" },

    // 名鉄協商 — 全国 約2,553件（sitemapはPC/SP両方を含むため実数は半分）。
    // ※別ワークフロー(crawl-others.yml, CRAWL_ONLY=mkp)で実行。
    { operator: "mkp", mode: "nationwide", label: "名鉄協商全国" },

    // ナビパーク(スターツアメニティー) — エリア階層を辿って列挙・ローリング巡回。
    // ※別ワークフロー(crawl-navipark.yml, CRAWL_ONLY=navipark)で実行。
    { operator: "navipark", mode: "nationwide", label: "ナビパーク全国" },

    // エコロパーク(エコロシティ) — 約195エリアを辿って列挙・ローリング巡回。
    // ※別ワークフロー(crawl-ecolo.yml, CRAWL_ONLY=ecolo)で実行。
    { operator: "ecolo", mode: "nationwide", label: "エコロパーク全国" },

    // ザ・パーク(第一興商) — 単一JSON(data/search.json)で全国 約3,367件を1リクエスト取得。
    // ※別ワークフロー(crawl-others.yml に相乗り, CRAWL_ONLY に thepark を追加)で実行。
    { operator: "thepark", mode: "nationwide", label: "ザ・パーク全国" },
  ],

  // repark 全国ローリング巡回で、1回の実行で取得する最大件数。
  // 3000件 ≒ 1回 約3.3時間（4秒間隔）。1日3回で約9,000件/日 → 約2日で全国1巡。
  reparkRollingPerRun: 4500,

  // タイムズ全国ローリング巡回（配慮して6秒間隔）。
  // 3000件 ≒ 1回 約5時間。1日3回で約9,000件/日 → 約2.4日で全国1巡。
  timesRollingPerRun: 3000,
  timesMinDelayMs: 6000,

  // 名鉄協商 全国ローリング巡回。約2,553件・4秒間隔。
  // 2500件 ≒ 1回 約2.8時間。1日3回で全件を毎日カバー。
  mkpRollingPerRun: 2500,

  // ナビパーク 全国ローリング巡回。4秒間隔。
  naviparkRollingPerRun: 2500,

  // エコロパーク 全国ローリング巡回。4秒間隔。
  ecoloRollingPerRun: 2500,

  // 全国規模では全件を毎回追記するとファイルが肥大するため、
  // 「新規 or 料金変動した物件のみ」追記する（時系列＝変化点の記録になる）。
  appendOnlyChanges: true,

  // 出力先（時系列を JSONL で追記）
  outFile: "data/prices.jsonl",
};
