// オーケストレータ ---------------------------------------------------------
// config.targets を順に（直列・節度をもって）取得し、料金を正規化して
// data/prices.jsonl に時系列で追記する。前回値との差分（料金変動）も検知する。
//
// 対応する取得単位:
//   npc  nationwide : bbox API で全国を1リクエスト一括取得
//   npc  cityId     : 市区町村単位（その市区の全物件）
//   repark parkId   : 個別物件1ページ
//   repark nationwide: sitemap 16,000件超を毎回 N 件ずつローリング巡回

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { politeFetch, sleep } from "./polite-fetch.js";
import { detailUrl as reparkDetailUrl, parseReparkDetail } from "./repark.js";
import { searchUrl, locationUrl, JAPAN_BBOX, parseNpcSearch } from "./npc.js";
import { cacheFresh } from "./cache-age.js";
import {
  getAllParkIds, loadCrawlState, saveCrawlState, pickRolling, recordVisit, countLive,
} from "./repark-enumerate.js";
import { parseTimesDetail } from "./times.js";
import { getAllParkUrls } from "./times-enumerate.js";
import { detailUrl as mkpDetailUrl, parseMkpDetail } from "./mkp.js";
import { getAllMkpIds } from "./mkp-enumerate.js";
import { detailUrl as naviparkDetailUrl, parseNaviparkDetail } from "./navipark.js";
import { getAllNaviparkCodes } from "./navipark-enumerate.js";
import { detailUrl as ecoloDetailUrl, parseEcoloDetail } from "./ecolo.js";
import { getAllEcoloIds } from "./ecolo-enumerate.js";
import { searchUrl as theparkUrl, parseTheparkJson } from "./thepark.js";
import { detailUrl as kyotechDetailUrl, parseKyotechDetail } from "./kyotech.js";
import { getAllKyotechIds } from "./kyotech-enumerate.js";
import { detailUrl as leparcDetailUrl, parseLeparcDetail } from "./leparc.js";
import { getAllLeparcIds } from "./leparc-enumerate.js";
import { areaListUrl, parseGsparkList, parseAreaCodes } from "./gspark.js";
// 2026-08 追加分（詳細ページ型6社・一覧直載型2社）
import { detailUrl as space24Url, parseSpace24Detail } from "./space24.js";
import { getAllSpace24Ids } from "./space24-enumerate.js";
import { detailUrl as jqparksUrl, parseJqparksDetail } from "./jqparks.js";
import { getAllJqparksIds } from "./jqparks-enumerate.js";
import { detailUrl as tamaparkUrl, parseTamaparkDetail } from "./tamapark.js";
import { getAllTamaparkIds } from "./tamapark-enumerate.js";
import { detailUrl as anabukiUrl, parseAnabukiDetail } from "./anabuki.js";
import { getAllAnabukiIds } from "./anabuki-enumerate.js";
import { detailUrl as kintetsuUrl, parseKintetsuDetail } from "./kintetsu.js";
import { getAllKintetsuIds } from "./kintetsu-enumerate.js";
import { detailUrl as tokyulifiaUrl, parseTokyuLifiaDetail } from "./tokyulifia.js";
import { getAllTokyuLifiaIds } from "./tokyulifia-enumerate.js";
import { cityListUrl as parknetCityUrl, parseParknetList } from "./parknet.js";
import { getAllParknetCities } from "./parknet-enumerate.js";
import { listUrl as mdenListUrl, parseMdenList } from "./mden.js";
import { detailUrl as seiwaparkUrl, parseSeiwaparkDetail } from "./seiwapark.js";
import { getAllSeiwaparkIds } from "./seiwapark-enumerate.js";
import { detailUrl as systemparkUrl, parseSystemparkDetail } from "./systempark.js";
import { getAllSystemparkIds } from "./systempark-enumerate.js";
import { detailUrl as comnetUrl, parseComnetDetail } from "./comnet.js";
import { getAllComnetIds } from "./comnet-enumerate.js";
import { detailUrl as keioUrl, parseKeioDetail } from "./keio.js";
import { getAllKeioIds } from "./keio-enumerate.js";
import { detailUrl as odakyuUrl, parseOdakyuDetail } from "./odakyu.js";
import { getAllOdakyuIds } from "./odakyu-enumerate.js";
import { politeFetch as pf2 } from "./polite-fetch.js";

const STATE = {
  reparkSitemapCache: "data/repark-sitemap.xml",
  reparkCrawlState: "data/repark-crawl-state.json",
  timesUrlsCache: "data/times-park-urls.txt",
  timesCrawlState: "data/times-crawl-state.json",
  mkpIdsCache: "data/mkp-ids.txt",
  mkpCrawlState: "data/mkp-crawl-state.json",
  naviparkCodesCache: "data/navipark-codes.txt",
  naviparkCrawlState: "data/navipark-crawl-state.json",
  ecoloIdsCache: "data/ecolo-ids.txt",
  ecoloCrawlState: "data/ecolo-crawl-state.json",
  kyotechIdsCache: "data/kyotech-ids.txt",
  kyotechCrawlState: "data/kyotech-crawl-state.json",
  leparcIdsCache: "data/leparc-ids.txt",
  leparcCrawlState: "data/leparc-crawl-state.json",
  gsparkAreasCache: "data/gspark-areas.txt",
  parknetCitiesCache: "data/parknet-cities.txt",
};

// 「列挙 → 古い順に少しずつ詳細を取る」型は全社まったく同じ手順なので、表で持って1つのループで回す。
// 以前は事業者ごとに同じ40行をコピーしていたため、2026-09 の「失敗しても時刻を進める」修正が
// 6社に入らず、片方だけ直った状態になっていた。増やすときはここに1行足すだけにする。
//   keyName : 解析関数に渡す名前（{ id } / { url } / { code } / { parkId }）
//   minDelay: 既定より長く空ける社（タイムズは先方が商用botを名指しで断っているため）
//   hours   : 満空が取れる社。巡回のたび「その時刻を見た」を記録して時間帯を均す
const ROLLING_SITES = [
  { op: "repark", label: "三井のリパーク", enumerate: getAllParkIds, detailUrl: reparkDetailUrl, parse: parseReparkDetail,
    idsCache: STATE.reparkSitemapCache, stateFile: STATE.reparkCrawlState, defaultPerRun: 1000,
    keyName: "parkId", hours: true },
  { op: "times", label: "タイムズ", enumerate: getAllParkUrls, detailUrl: (u) => u, parse: parseTimesDetail,
    idsCache: STATE.timesUrlsCache, stateFile: STATE.timesCrawlState, defaultPerRun: 2000,
    keyName: "url", minDelay: config.timesMinDelayMs ?? 6000 },
  { op: "mkp", label: "名鉄協商", enumerate: getAllMkpIds, detailUrl: mkpDetailUrl, parse: parseMkpDetail,
    idsCache: STATE.mkpIdsCache, stateFile: STATE.mkpCrawlState, defaultPerRun: 2500 },
  { op: "navipark", label: "ナビパーク", enumerate: getAllNaviparkCodes, detailUrl: naviparkDetailUrl, parse: parseNaviparkDetail,
    idsCache: STATE.naviparkCodesCache, stateFile: STATE.naviparkCrawlState, defaultPerRun: 2500, keyName: "code" },
  { op: "ecolo", label: "エコロパーク", enumerate: getAllEcoloIds, detailUrl: ecoloDetailUrl, parse: parseEcoloDetail,
    idsCache: STATE.ecoloIdsCache, stateFile: STATE.ecoloCrawlState, defaultPerRun: 2500 },
  { op: "kyotech", label: "キョウテク", enumerate: getAllKyotechIds, detailUrl: kyotechDetailUrl, parse: parseKyotechDetail,
    idsCache: STATE.kyotechIdsCache, stateFile: STATE.kyotechCrawlState, defaultPerRun: 800 },
  { op: "leparc", label: "ルパルク", enumerate: getAllLeparcIds, detailUrl: leparcDetailUrl, parse: parseLeparcDetail,
    idsCache: STATE.leparcIdsCache, stateFile: STATE.leparcCrawlState, defaultPerRun: 500 },
  { op: "space24", label: "スペース二十四", enumerate: getAllSpace24Ids, detailUrl: space24Url, parse: parseSpace24Detail,
    idsCache: "data/space24-ids.txt", stateFile: "data/space24-crawl-state.json", defaultPerRun: 500 },
  { op: "jqparks", label: "JQパークス", enumerate: getAllJqparksIds, detailUrl: jqparksUrl, parse: parseJqparksDetail,
    idsCache: "data/jqparks-ids.txt", stateFile: "data/jqparks-crawl-state.json", defaultPerRun: 400 },
  { op: "tamapark", label: "タマパーク", enumerate: getAllTamaparkIds, detailUrl: tamaparkUrl, parse: parseTamaparkDetail,
    idsCache: "data/tamapark-ids.txt", stateFile: "data/tamapark-crawl-state.json", defaultPerRun: 200 },
  { op: "anabuki", label: "あなぶきパーク", enumerate: getAllAnabukiIds, detailUrl: anabukiUrl, parse: parseAnabukiDetail,
    idsCache: "data/anabuki-ids.txt", stateFile: "data/anabuki-crawl-state.json", defaultPerRun: 400 },
  { op: "kintetsu", label: "近鉄不動産", enumerate: getAllKintetsuIds, detailUrl: kintetsuUrl, parse: parseKintetsuDetail,
    idsCache: "data/kintetsu-ids.txt", stateFile: "data/kintetsu-crawl-state.json", defaultPerRun: 200 },
  { op: "tokyulifia", label: "東急ライフィア", enumerate: getAllTokyuLifiaIds, detailUrl: tokyulifiaUrl, parse: parseTokyuLifiaDetail,
    idsCache: "data/tokyulifia-ids.txt", stateFile: "data/tokyulifia-crawl-state.json", defaultPerRun: 150 },
  { op: "seiwapark", label: "セイワパーク", enumerate: getAllSeiwaparkIds, detailUrl: seiwaparkUrl, parse: parseSeiwaparkDetail,
    idsCache: "data/seiwapark-ids.txt", stateFile: "data/seiwapark-crawl-state.json", defaultPerRun: 400 },
  { op: "systempark", label: "システムパーク", enumerate: getAllSystemparkIds, detailUrl: systemparkUrl, parse: parseSystemparkDetail,
    idsCache: "data/systempark-ids.txt", stateFile: "data/systempark-crawl-state.json", defaultPerRun: 300 },
  { op: "comnet", label: "コムパーク", enumerate: getAllComnetIds, detailUrl: comnetUrl, parse: parseComnetDetail,
    idsCache: "data/comnet-ids.txt", stateFile: "data/comnet-crawl-state.json", defaultPerRun: 200 },
  { op: "keio", label: "京王コインパーク", enumerate: getAllKeioIds, detailUrl: keioUrl, parse: parseKeioDetail,
    idsCache: "data/keio-ids.txt", stateFile: "data/keio-crawl-state.json", defaultPerRun: 100 },
  { op: "odakyu", label: "小田急パーキング", enumerate: getAllOdakyuIds, detailUrl: odakyuUrl, parse: parseOdakyuDetail,
    idsCache: "data/odakyu-ids.txt", stateFile: "data/odakyu-crawl-state.json", defaultPerRun: 100 },
];

function readLastSnapshots(file) {
  const last = new Map();
  if (!fs.existsSync(file)) return last;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      last.set(`${rec.operator}:${rec.parkId}`, rec);
    } catch {
      /* skip */
    }
  }
  return last;
}

/** 1回あたりの取得件数。<op>RollingCycleRuns があれば「1周を何回で終えるか」から割り出す。
 *  物件数が増えても周回数（＝観測時刻のずれ方）が変わらないようにするため。 */
function rollingPerRun(op, total, fallback) {
  // 動作確認用の上書き（ROLLING_PER_RUN=1 で1件だけ取る）
  const forced = Number(process.env.ROLLING_PER_RUN);
  if (Number.isFinite(forced) && forced > 0) return forced;
  const cycle = config[`${op}RollingCycleRuns`];
  if (!cycle) return fallback;
  return Math.max(1, Math.ceil(total / cycle));
}

function feeFingerprint(rec) {
  const u = (rec.unitCharges ?? [])
    .map((x) => `${x.timeRange}=${x.perMinutes}分/${x.amountYen}円`)
    .sort();
  const m = (rec.maxFees ?? [])
    .map((x) => `${x.scope}/${x.condition}=${x.amountYen}円`)
    .sort();
  return JSON.stringify({ u, m });
}

async function main() {
  // OUT_FILE で出力先を上書き可（ワークフロー分割時の push 競合回避用）。
  const outFile = path.resolve(process.env.OUT_FILE || config.outFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const last = readLastSnapshots(outFile);
  const now = new Date().toISOString();   // 実行開始。個々の観測時刻は取得のたびに付ける

  const stats = { processed: 0, written: 0, changed: 0, isNew: 0, vacancy: 0 };
  // 満空の置き場。料金とは別ファイルにする（追記の条件が違うため）。
  // 名前・座標・台数は初回だけ入れ、以降は id で引く（同じ値を毎回書かない）
  // 月ごとに分ける。1本にすると1年で数百MBになり、毎回の巡回でコミットするgitが重くなる。
  // 先月以前のファイルは二度と変わらないので、gitはそれ以上太らない。
  // 月は**観測した時刻**（日本時間）から決める。実行開始時に決めると、4時間半まわる
  // NPC の実行が月をまたいだとき、翌月の観測が前月のファイルに入る。
  const vacancyFileOf = (atIso) => process.env.VACANCY_FILE
    || `data/vacancy-${new Date(new Date(atIso).getTime() + 9 * 3600e3).toISOString().slice(0, 7)}.jsonl`;
  // 名前・座標・台数は時系列に毎回書くと1行が3倍になるので、別ファイルに持つ。
  // 以前は「料金データに新規のときだけ書く」にしていたが、既に知っている物件では一度も
  // 書かれず、9,777観測のうち座標があるのは1件だけだった（＝地図に置けず使えなかった）。
  // 追記型の jsonl（1行＝1物件の最新。同じ物件が複数行あれば最後を採る）。
  // 1つの .json を複数のワークフローから書き換えると、衝突時に「自分側を採用」した方が
  // もう一方の分を消す。追記型なら .gitattributes の union マージで両方残る。
  const vacancyMetaFile = process.env.VACANCY_META_FILE || "data/vacancy-lots.jsonl";
  const vacMeta = {};
  try {
    for (const line of fs.readFileSync(vacancyMetaFile, "utf8").split("\n")) {
      if (!line) continue;
      try { const j = JSON.parse(line); vacMeta[j.k] = j; } catch { /* 壊れた行は飛ばす */ }
    }
  } catch { /* 初回 */ }
  // 料金は書かずに満空だけ残す回（crawl-npc.yml）。料金の時系列を2本にしない
  const vacancyOnly = process.env.VACANCY_ONLY === "1";

  // CRAWL_ONLY=times / npc,repark などで対象事業者を絞れる（ワークフロー分割用）。
  const only = (process.env.CRAWL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = only.length
    ? config.targets.filter((t) => only.includes(t.operator))
    : config.targets;

  // 1物件分の処理（差分検知＋追記）。at はその物件を取った時刻。
  // 実行開始時の1つの時刻を全物件に付けると、42分かかる巡回の629件が同一時刻になり、
  // 時間帯の記録が最大45分ずれる（実際そうなっていた）。
  function handleRecord(rec, at = now) {
    rec.fetchedAt = at;
    // 料金は生データ（unitCharges / maxFees）のまま保持する。
    // 円/時や24時間最大などの正規化は保存せず、必要時に src/normalize.js で後計算する。
    const key = `${rec.operator}:${rec.parkId}`;
    const prev = last.get(key);
    const fp = feeFingerprint(rec);
    const isNew = !prev;
    const isChanged = prev && feeFingerprint(prev) !== fp;
    if (isChanged) {
      rec.changedFromPrev = true;
      stats.changed++;
      console.log(`  [CHANGED] ${key} (${rec.name})`);
    }
    if (isNew) stats.isNew++;
    // 全国規模ではファイル肥大を防ぐため、新規 or 変動時のみ追記する。
    if (!vacancyOnly && (!config.appendOnlyChanges || isNew || isChanged)) {
      fs.appendFileSync(outFile, JSON.stringify(rec) + "\n");
      stats.written++;
    }
    // 満空は料金と別に、巡回のたびに残す。
    // 料金の指紋（feeFingerprint）に満空は入っていないので、上の追記に混ぜると
    // 「料金が変わった回だけ」しか残らず、時系列にならない（実際そうなっていた。
    // 1物件あたりの観測回数の中央値が1回）。在車率の推定に使うには連続した観測が要る。
    // 1行を小さくして、1年回してもファイルが重くならないようにする。
    if (rec.fullEmptyStatus) {
      fs.appendFileSync(vacancyFileOf(at), JSON.stringify({
        at, op: rec.operator, id: rec.parkId, s: rec.fullEmptyStatus,
      }) + "\n");
      stats.vacancy++;
      // 名前・座標は別ファイルへ。変わったときだけ1行追記する
      const m = { k: key, n: rec.name ?? null, la: rec.lat ?? null, ln: rec.lng ?? null, c: rec.capacity ?? null };
      const prevMeta = vacMeta[key];
      if (!prevMeta || prevMeta.la !== m.la || prevMeta.ln !== m.ln || prevMeta.c !== m.c || prevMeta.n !== m.n) {
        vacMeta[key] = m;
        fs.appendFileSync(vacancyMetaFile, JSON.stringify(m) + "\n");
      }
    }
    last.set(key, rec);
    stats.processed++;
  }

  // ページキャッシュ判定（単純な単一リクエスト対象用）。
  function cachedRecently(requestUrl) {
    const repr = [...last.values()].find((r) => r._requestUrl === requestUrl);
    // PAGE_CACHE_MS=0 で無効化できる。満空を1時間おきに採る回ではキャッシュに当たると
    // 6回に5回が空振りになり、時間帯が埋まらない。
    const ms = process.env.PAGE_CACHE_MS ? Number(process.env.PAGE_CACHE_MS) : config.pageCacheMs;
    return repr && Date.now() - new Date(repr.fetchedAt).getTime() < ms;
  }

  for (const t of targets) {
    // ---- NPC 全国（bbox 一括） ----
    if (t.operator === "npc" && t.mode === "nationwide") {
      const url = locationUrl(JAPAN_BBOX, { limit: 2000 });
      if (cachedRecently(url)) { console.log(`[cache] NPC全国 スキップ`); continue; }
      // NPCは1リクエストで全国1,700件ぶんの満空が返る。
      // GitHub の定時実行は混むと3〜5時間ずれるので、実行時刻だけに頼ると時間帯が埋まらない
      // （実測で24時間中10時間が空のままだった）。1回の実行の中で間隔をあけて繰り返し取り、
      // 1回の実行で数時間ぶんの時間帯を埋める。追加は1回あたり1リクエストだけ。
      const repeat = Math.max(1, Number(process.env.NPC_REPEAT) || 1);
      // 0 を明示したときは待たない（|| だと 0 が既定の27分に化ける）
      const gapMin = process.env.NPC_INTERVAL_MIN !== undefined && process.env.NPC_INTERVAL_MIN !== ""
        ? Number(process.env.NPC_INTERVAL_MIN) : 27;
      if (!Number.isFinite(gapMin) || gapMin < 0) throw new Error(`NPC_INTERVAL_MIN が数値ではありません: ${process.env.NPC_INTERVAL_MIN}`);
      const gapMs = gapMin * 60_000;
      let records = [];
      for (let i = 0; i < repeat; i++) {
        if (i > 0) {
          console.log(`[NPC全国] ${gapMs / 60000}分待ってから ${i + 1}/${repeat} 回目`);
          await sleep(gapMs);
        }
        let res;
        try { res = await politeFetch(url); } catch (e) { console.error(`[error] NPC全国: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`[error] NPC全国: ${res.skippedReason ?? "HTTP " + res.status}`); continue; }
        let total = null;
        try { total = JSON.parse(res.html).total; } catch { /* */ }
        records = parseNpcSearch(res.html, { label: "NPC全国" });
        if (total != null && total > records.length) {
          console.warn(`[warn] NPC全国: total=${total} だが ${records.length}件のみ取得。limit引上げ/ページングが必要`);
        }
        // 2回目以降は「今の時刻の満空」を採るのが目的。取った時刻をそのまま付ける
        const at = new Date().toISOString();
        records.forEach((r) => { r._requestUrl = url; handleRecord(r, at); });
        console.log(`[ok] NPC全国 ${i + 1}/${repeat} | ${records.length}物件`);
      }
      continue;
    }

    // ---- NPC 市区町村 ----
    if (t.operator === "npc") {
      const url = searchUrl(t.cityId);
      if (cachedRecently(url)) { console.log(`[cache] npc:${t.label} スキップ`); continue; }
      let res;
      try { res = await politeFetch(url); } catch (e) { console.error(`[error] npc:${t.label}: ${e.message}`); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] npc:${t.label}`); continue; }
      const records = parseNpcSearch(res.html, { cityId: t.cityId, prefId: t.prefId, label: t.label });
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] npc:${t.label} | ${records.length}物件`);
      continue;
    }

    // ---- 列挙 → 古い順に少しずつ詳細を取る（表にある全社で共通） ----
    const rolling = ROLLING_SITES.find((x) => x.op === t.operator);
    if (rolling && t.mode === "nationwide") {
      let ids;
      try {
        ids = await rolling.enumerate({ cacheFile: rolling.idsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] ${rolling.op} enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(rolling.stateFile);
      // 一覧が変わったら、404で寝かせていた物件を起こす（復活している見込みがあるため）
      const woke = unparkGone(state, ids);
      if (woke) console.log(`[${rolling.label}] 一覧が変わったので、寝かせていた${woke}件を起こす`);
      // 1周の回数は「生きている物件」で割る。404で寝かせた分を含めると1周が短くなる
      const liveCount = countLive(ids, state);
      const perRun = rollingPerRun(rolling.op, liveCount, config[`${rolling.op}RollingPerRun`] ?? rolling.defaultPerRun);
      const batch = pickRolling(ids, state, perRun, { spreadHours: !!rolling.hours, at: now });
      const visited = ids.filter((id) => state[id]).length;
      console.log(
        `[${rolling.label}] 全${ids.length}件（生きている${liveCount}件） / 既訪${visited}件 / 今回${batch.length}件取得。` +
        `1巡目安: 約${Math.ceil(liveCount / Math.max(1, perRun))}回実行`
      );
      // 時間の予算。GitHub の上限で途中で殺されると、状態も満空も何も残らず次回も同じ物件を叩く。
      // 予算内で切り上げ、状態は50件ごとに書いておく
      const budgetMs = (Number(process.env.ROLLING_BUDGET_MIN) || 45) * 60_000;
      const startedAt = Date.now();
      const fetchOpts = rolling.minDelay ? { minDelay: rolling.minDelay } : undefined;
      let done = 0;
      for (const id of batch) {
        if (Date.now() - startedAt > budgetMs) { console.warn(`  [budget] ${budgetMs / 60000}分を超えたので ${done}/${batch.length} 件で切り上げ`); break; }
        const url = rolling.detailUrl(id);
        const at = new Date().toISOString();   // この物件を取った時刻
        const mark = (r, seen) => recordVisit(state, id, at, r, { hours: !!rolling.hours, seen });
        let res;
        try { res = await politeFetch(url, fetchOpts); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); mark(null); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id} ${res.skippedReason ?? "HTTP " + res.status}`); mark(res); continue; }
        let rec;
        // 中身が読めなくても取得はできている。時刻は進めないと古い順の先頭に居座る
        try { rec = rolling.parse(res.html, { [rolling.keyName ?? "id"]: id }); }
        catch (e) { console.error(`  [parse error] ${id}: ${e.message}`); mark(res, false); continue; }
        if (!rec || !rec.name) { mark(res, false); continue; }
        rec._requestUrl = url;
        handleRecord(rec, at);
        // 満空が取れる社では「その時刻を見た」と記録するのは満空が読めたときだけ。
        // ページの作りが変わって読めなくなっても時間帯が埋まると、止まったことに気づけない
        mark(res, rolling.hours ? !!rec.fullEmptyStatus : undefined);
        if (++done % 50 === 0) saveCrawlState(rolling.stateFile, state);
      }
      saveCrawlState(rolling.stateFile, state);
      continue;
    }

    // ---- パークネット 全国（市区一覧に料金直載・毎回全巡回） ----
    if (t.operator === "parknet" && t.mode === "nationwide") {
      let cities;
      try {
        cities = await getAllParknetCities({ cacheFile: STATE.parknetCitiesCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] parknet enumerate: ${e.message}`); continue; }
      console.log(`[パークネット] 市区${cities.length}件を巡回`);
      let count = 0;
      for (const line of cities) {
        const [prefCd, city] = line.split("\t");
        if (!prefCd || !city) continue;
        const url = parknetCityUrl(prefCd, city);
        let res;
        try { res = await politeFetch(url); } catch (e) { console.error(`  [error] ${city}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) continue;
        for (const rec of parseParknetList(res.html)) { rec._requestUrl = url; handleRecord(rec); count++; }
      }
      console.log(`[ok] パークネット | ${count}物件`);
      continue;
    }

    // ---- エムデン・テクノパーキング 全国（1ページに全物件） ----
    if (t.operator === "mden" && t.mode === "nationwide") {
      const url = mdenListUrl();
      let res;
      try { res = await politeFetch(url); } catch (e) { console.error(`[error] mden: ${e.message}`); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] mden: HTTP ${res.status}`); continue; }
      const records = parseMdenList(res.html);
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] エムデン・テクノパーキング | ${records.length}物件`);
      continue;
    }

    // ---- ザ・パーク 全国（単一JSON一括） ----
    if (t.operator === "thepark" && t.mode === "nationwide") {
      const url = theparkUrl();
      if (cachedRecently(url)) { console.log(`[cache] ザ・パーク全国 スキップ`); continue; }
      let res;
      try { res = await politeFetch(url); } catch (e) { console.error(`[error] ザ・パーク: ${e.message}`); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] ザ・パーク: ${res.skippedReason ?? "HTTP " + res.status}`); continue; }
      const records = parseTheparkJson(res.html, { label: "ザ・パーク全国" });
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] ザ・パーク全国 | ${records.length}物件`);
      continue;
    }

    // ---- repark 個別物件 ----
    if (t.operator === "repark") {
      const url = reparkDetailUrl(t.parkId);
      if (cachedRecently(url)) { console.log(`[cache] repark:${t.label} スキップ`); continue; }
      let res;
      try { res = await politeFetch(url); } catch (e) { console.error(`[error] repark:${t.label}: ${e.message}`); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] repark:${t.label}`); continue; }
      const rec = parseReparkDetail(res.html, { parkId: t.parkId, label: t.label });
      rec._requestUrl = url;
      handleRecord(rec);
      console.log(`[ok] repark:${t.label} | ${rec.name}`);
      continue;
    }

    console.warn(`[skip] 未対応の target: ${JSON.stringify(t)}`);
  }


  console.log(
    `\n完了: ${stats.processed}物件処理 / 新規${stats.isNew} / 変動${stats.changed} / 追記${stats.written}行 / 満空${stats.vacancy}行 → ${process.env.OUT_FILE || config.outFile}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
