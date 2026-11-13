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
  // robots.txt に届かなかったとき（通信の失敗・タイムアウト・5xx）、その origin を見送る時間（ミリ秒）。過ぎたら取り直す
  robotsUnreachableCacheMs: 10 * 60 * 1000,

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
    // hold … 保留（src/hold.js）。人が見て相手先のサイトの一時停止を確かめた社。期限まで様子見の1件だけ取り、取れなければ
    //   「メンテナンス」と記録する（「断られている」にしない）。期限を過ぎたら自動で外れる。取れるようになったら消してよい
    //   名鉄協商: 2026-10-21 から mkp.jp が「セキュリティ対策のため Webサイトを一時停止。再開まで日数を要する見込み」（10/27 に確かめた）。
    //   GitHub のサーバーには告知ではなく素の 403・タイムアウトが返り、巡回では見分けられない
    { operator: "mkp", mode: "nationwide", label: "名鉄協商全国",
      hold: { until: "2026-12-24", reason: "2026-10-21 から相手先が Webサイトを一時停止（セキュリティ対策・10/27 確認・11/2 も停止中）" } },

    // ナビパーク(スターツアメニティー) — エリア階層を辿って列挙・ローリング巡回。
    // ※別ワークフロー(crawl-navipark.yml, CRAWL_ONLY=navipark)で実行。
    { operator: "navipark", mode: "nationwide", label: "ナビパーク全国" },

    // エコロパーク(エコロシティ) — 約195エリアを辿って列挙・ローリング巡回。
    // ※別ワークフロー(crawl-ecolo.yml, CRAWL_ONLY=ecolo)で実行。
    { operator: "ecolo", mode: "nationwide", label: "エコロパーク全国" },
    // ※別ワークフロー(crawl-extra.yml, CRAWL_ONLY=kyotech,leparc,gspark,showapark,ypark)で実行。
    { operator: "kyotech", mode: "nationwide", label: "キョウテク全国" },
    { operator: "leparc", mode: "nationwide", label: "NTTル・パルク全国" },
    { operator: "gspark", mode: "nationwide", label: "GSパーク全国" },
    // 2026-11-02 追加。どちらも Parkopedia の料金が古い・誤っている物件がレポートに出ていた（ショウワ新橋2丁目・ユアー新橋第3 など）
    //   ショウワパーク（ショウワ電技研）… 19都道府県・一覧737件（駐輪場・月極を含む。トップの表示は586か所）。首都圏と大阪が中心
    //   ユアー・パーキング … 公式の地図（waxds.com 上）の JSON。632件（東京が約8割）。読むのは地図の画面が自分で読む GET の2つだけ
    { operator: "showapark", mode: "nationwide", label: "ショウワパーク" },
    { operator: "ypark", mode: "nationwide", label: "ユアー・パーキング" },
    // ※別ワークフロー(crawl-extra2.yml)で実行する2026-08追加分。
    // paused … 止めている事業者。一覧も詳細も robots.txt も取らず、health に「停止中」だけを残す（run.js）。
    //   スペース二十四・小田急パーキングは 2026-10 時点で全ページ（スペース二十四は robots.txt も）403 を返す＝当ボットを断っている。
    //   それでも毎回一覧を取りに行き、1日あたり各社4リクエストを送り続けていた（10/8〜10/18 の全回で 403）。
    //   ワークフローの CRAWL_ONLY からは外さない。外すと health から消えて Advisor に「また取れるようになった」と誤って届き、
    //   studio-index.mjs の「長く取れていない事業者」の判定も外れて、失敗した日が「最後に確かめた日」に戻るため。
    //   取り直しを試す手段（UA の偽装・別の経路など）は作らない。先方の許可が出たら paused を消す
    { operator: "space24", mode: "nationwide", label: "スペース二十四全国", paused: "2026-10 先方が403で拒否。許可が出るまでアクセスしない" },
    { operator: "jqparks", mode: "nationwide", label: "JQパークス（九州）" },
    { operator: "parknet", mode: "nationwide", label: "パークネット全国" },
    { operator: "tamapark", mode: "nationwide", label: "タマパーク" },
    { operator: "anabuki", mode: "nationwide", label: "あなぶきパーク全国" },
    { operator: "mden", mode: "nationwide", label: "エムデン・テクノパーキング" },
    // 近鉄不動産: 2026-10-21 から parking.kintetsu-re.co.jp が「緊急メンテナンスのお知らせ」（10/27 に確かめた）。
    //   GitHub のサーバーには robots.txt が素の 403 で返る
    { operator: "kintetsu", mode: "nationwide", label: "近鉄不動産",
      hold: { until: "2026-12-24", reason: "2026-10-21 から相手先が緊急メンテナンス中（10/27 確認・11/2 も停止中）" } },
    { operator: "tokyulifia", mode: "nationwide", label: "東急ライフィア" },
    { operator: "seiwapark", mode: "nationwide", label: "セイワパーク" },
    { operator: "systempark", mode: "nationwide", label: "システムパーク（仙台）" },
    { operator: "comnet", mode: "nationwide", label: "コムパーク" },
    { operator: "keio", mode: "nationwide", label: "京王コインパーク" },
    { operator: "odakyu", mode: "nationwide", label: "小田急パーキング", paused: "2026-10 先方が403で拒否。許可が出るまでアクセスしない" },
    // ※2026-11 追加分（crawl-extra2.yml に相乗り）。どちらも Parkopedia が補っていたレポートの物件を公式の料金に替えるため。
    // 三菱地所パークス（PARKS PARK・PEN・ミウラ） — Parking NAVI の一覧に料金が直載。都道府県と東京都の市区で
    //   約100リクエスト/回（約7分）、毎回全件を取る（一覧型）。平面（ptype=3）と施設（ビル駐車場・ptype=1）を記録する（施設も相場に入れる。2026-11-02 本人指示）
    { operator: "mecparks", mode: "nationwide", label: "三菱地所パークス全国" },
    // SANパーク（パイン株式会社） — 首都圏の市区の一覧から物件ページをたどる（約1,000件・ローリング）
    { operator: "sanpark", mode: "nationwide", label: "SANパーク" },
    // 2026-11-02 追加分（crawl-extra3.yml に相乗り）。どちらも robots.txt に決まりは無く、規約のページも無い（2026-11-01 確認）
    // 東洋カーマックス — 一覧（約60ページ・1,170件）から駐輪場を除いた約1,130件の詳細ページをローリング巡回。関東・近畿が中心
    { operator: "carmax", mode: "nationwide", label: "東洋カーマックス" },
    // MAYパーク（日本メカトロニクス）— 1ページ（Shift_JIS）に名古屋中心の193区画。駐輪場・月極専用を除く約130件を毎回1リクエストで
    { operator: "maypark", mode: "nationwide", label: "MAYパーク" },

    // ザ・パーク(第一興商) — 一覧のページ（1ページ10件・約440ページ）を番号の順に読む。全部取れた日は、その日の残りの回では読まない（2026-11-13 サイトの作り直しに合わせた）
    // ※別ワークフロー(crawl-others.yml に相乗り, CRAWL_ONLY に thepark を追加)で実行。
    { operator: "thepark", mode: "nationwide", label: "ザ・パーク全国" },
  ],

  // repark 全国ローリング巡回で、1回の実行で取得する最大件数。
  // 3000件 ≒ 1回 約3.3時間（4秒間隔）。1日3回で約9,000件/日 → 約2日で全国1巡。
  // 満空を時間帯ごと・曜日ごとに均等に集めるための設定。
  //
  // 1時間おきに走らせたうえで、全物件を1周するのに **25回** かけると、
  // 1周 = 25時間 になり、同じ物件を見る時刻が1周ごとに1時間ずつ後ろへずれる。
  // 24と25が互いに素なので、25周（約25日）で24時間すべてを1回ずつ通る。
  // 曜日も25時間刻みなので7回の観測で7曜日を一巡する。
  // （6時間おき×4500件だと1周3.5回＝約1.2日で、同じ物件がいつも似た時刻になる）
  //
  // 1回あたりの件数は物件数から割り出す。件数が増えても1周25回を保つため、
  // 固定値ではなく「周回数」で持つ。
  reparkRollingCycleRuns: 25,
  reparkRollingPerRun: 4500, // CycleRuns を指定しない事業者向けの既定値

  // タイムズ全国ローリング巡回（配慮して6秒間隔）。
  // 2026-10-17 実態に合わせて直した（本人指示: 直せるものは直して）。以前は「3000件・1回約5時間・約2.4日で1巡」と
  // 書いていたが、crawl-times.yml に ROLLING_BUDGET_MIN が無く既定の45分で切り上げていたので、1回 約450件・
  // 約16日で1巡だった。本人の了解（1回90分・負荷は約2倍）で crawl-times.yml を90分にした。
  // 90分 ÷ 6秒 ≒ 900件/回。1日3回で約2,700件/日 → 優先物件の取り直しを入れて約10日で全国1巡（優先なしなら約8日）。
  timesRollingPerRun: 900,
  timesMinDelayMs: 6000,
  // 優先物件（Advisor の登録現場とレポート地点の周り。約620件）を取り直す間隔（時間）。
  // リパーク（毎時）と同じ3時間にすると、1日3回のタイムズでは毎回の回で約620件を取り直し、
  // 全国の1巡が約25日に延びる。20時間ならおおむね1日1回（30日の試算: 優先は最大0.9日前・全国は最大約10日）。
  // 起動の時刻は日ごとにずれるので、優先物件の満空もいろいろな時間帯で取れる（2026-10-17）
  timesPriorityMinAgeHours: 20,

  // 名鉄協商 全国ローリング巡回。約2,553件・4秒間隔。
  // 2500件 ≒ 1回 約2.8時間。1日3回で全件を毎日カバー。
  mkpRollingPerRun: 2500,

  // ナビパーク 全国ローリング巡回。4秒間隔。
  naviparkRollingPerRun: 2500,

  // エコロパーク 全国ローリング巡回。4秒間隔。
  // 実際には1回45分の予算で約675件で切り上げる。一覧をサイトマップに替えて約3,945件になったので
  // 約6回（1日3回で約2日）で1巡（2026-10-18。以前の一覧1,032件では約半日で1巡していた）。
  ecoloRollingPerRun: 2500,
  // 追加3社（crawl-extra.yml）。いずれも毎回全件相当（~1,300リクエスト×6秒 ≒ 2.2時間/回）
  kyotechRollingPerRun: 800,
  // ル・パルクは一覧を全24ページ・約471件たどるようにした（2026-11-02。以前は40件）。500のままだと1回約31分・1日約940回になるので、
  // 1日2回 × 240件 ≒ 各物件をおおむね1日1回（1回 約16分）にする
  leparcRollingPerRun: 240,
  // 2026-11-02 追加分（crawl-extra.yml・1日2回）。1日1巡を目安に、1回あたり一覧の約半分。
  // 1回 約300件×4秒 ≒ 20分（ショウワは週1回の一覧の作り直しに約39リクエスト＝約3分が足される）。
  // 今の crawl-extra は1回 約1時間（キョウテク45分・ル・パルク・GSパーク）なので、足しても約1時間45分で、ジョブの時間切れ（340分）に収まる
  showaparkRollingPerRun: 300,
  yparkRollingPerRun: 320,
  // 2026-08 追加分（crawl-extra2.yml・1日1回で全件を目安）
  space24RollingPerRun: 500,
  // JQパークスは大分・長崎の駅と駅の2ページ目以降を足して約746件（2026-11-02。以前は541件）。400件のままで、
  // 1日2回 × 400件 ≒ 約0.9日で1巡（1回 約27分）。一覧の作り直し（週1回・約500リクエスト・約35分）はこの外
  jqparksRollingPerRun: 400,
  tamaparkRollingPerRun: 200,
  anabukiRollingPerRun: 400,
  kintetsuRollingPerRun: 200,
  tokyulifiaRollingPerRun: 150,
  seiwaparkRollingPerRun: 400,
  systemparkRollingPerRun: 300,
  comnetRollingPerRun: 200,
  keioRollingPerRun: 100,
  odakyuRollingPerRun: 100,
  // 2026-11 追加分（crawl-extra2.yml・1日2回）。SANパークは時間貸し 約1,000件を1回250件（4秒間隔で約17分）。
  // 1日2回で約500件 → 約2日で1巡。一覧（約132リクエスト・約9分）は7日ごとに作り直す
  sanparkRollingPerRun: 250,
  // 東洋カーマックス（2026-11-02）。crawl-extra3.yml は1日2回（5・17時）・巡回の手順は340分まで。
  // 今の extra3 は1回あたり最大でも約1,950件（4秒おきで約130分）なので、400件（約27分）足しても時間に余裕がある。
  // 予算（ROLLING_BUDGET_MIN 既定45分）にも収まる。約1,130件を1日800件で、約1.4日で1巡。小さな会社のサイトなので1回400件に抑える
  carmaxRollingPerRun: 400,

  // 全国規模では全件を毎回追記するとファイルが肥大するため、
  // 「新規 or 料金変動した物件のみ」追記する（時系列＝変化点の記録になる）。
  appendOnlyChanges: true,

  // 出力先（時系列を JSONL で追記）
  outFile: "data/prices.jsonl",
};
