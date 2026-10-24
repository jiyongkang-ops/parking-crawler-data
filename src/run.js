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
import { politeFetch, sleep, fetchErrorText } from "./polite-fetch.js";
import { detailUrl as reparkDetailUrl, parseReparkDetail } from "./repark.js";
import { searchUrl, locationUrl, JAPAN_BBOX, parseNpcSearch } from "./npc.js";
import { cacheFresh, markFetched, cacheAgeMs } from "./cache-age.js";
import {
  getAllParkIds, loadCrawlState, saveCrawlState, pickRolling, recordVisit, countLive, unparkGone, matchPriority,
  isTransient, recordTransient, makeBreaker, makeMassGone, pickDropped, readCachedParkIds, pickOptsOf,
} from "./repark-enumerate.js";
import { parseTimesDetail, bukCode } from "./times.js";
import { getAllParkUrls } from "./times-enumerate.js";
import { detailUrl as mkpDetailUrl, parseMkpDetail, isClosedRedirect as isMkpClosedRedirect } from "./mkp.js";
import { getAllMkpIds } from "./mkp-enumerate.js";
import { detailUrl as naviparkDetailUrl, parseNaviparkDetail } from "./navipark.js";
import { getAllNaviparkCodes } from "./navipark-enumerate.js";
import { detailUrl as ecoloDetailUrl, parseEcoloDetail, isClosedRedirect as isEcoloClosedRedirect } from "./ecolo.js";
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
import { getAllParknetCities, crawlParknetCities, parknetHealth } from "./parknet-enumerate.js";
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
import { flushCrawlStates } from "./repark-enumerate.js";
import { writeFileAtomic } from "./write-atomic.js";
import { politeFetch as pf2 } from "./polite-fetch.js";
import { gapFilled } from "./record-gap.js";
import { kindOfFetch, kindOfText, dominantKind, makeCounter, countStatus, withLastOk } from "./health-kind.js";
import { markMaintenance } from "./maintenance.js";

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
//   priorityKey: 一覧の1件 → 優先物件の番号。一覧の書き方と Advisor の番号が違う社だけ付ける（2026-10-17）
//   confirmDropped: 一覧から消えた物件を、一覧を作り直したあと1回だけ取りに行き、閉鎖（404）を確かめる（2026-10-18）
//   readList: 一覧のキャッシュ（idsCache）の中身 → 番号の配列。1行1件でない社だけ付ける
//   readPrev: 前の回の一覧を読む関数（idsCache のパス → 番号の配列）。一覧が2つのファイルに分かれている社だけ付ける
//             （リパークは sitemap の XML ＋ 地図の一覧 repark-map-ids.txt。2026-10-18）
//   budgetIncludesList: 一覧の作り直しにかかった時間も、その回の時間の予算（ROLLING_BUDGET_MIN）に入れる。
//             リパークは週1回、地図の一覧に約100回（4秒おきで約7分）かかる。予算の外にすると、その回だけ毎時の間隔（60分）と
//             ジョブの時間切れ（70分）に近づくため、その分だけ詳細ページを減らす
//   spreadPriority: 優先物件を毎回少しずつ取る（pickRolling の説明）。毎時回る社（リパーク）だけに付ける。
//             1日3回のタイムズに付けると、優先物件を取るのが1日3回から1日1回に減る（2026-10-19 の点検）
//   dailyFirst: 満空の選び方で「今日まだ見ていない物件」を先にする（pickRolling の説明）。1日に全体の大半を回れる社（リパーク）だけに付ける。
//             タイムズ（約2万2千件を1日約2,700件・1周約8日）に付けると、取る番の物件がほぼすべて48時間の歯止めにかかり、
//             時間帯をならす仕組みが効かなくなる（2026-10-19 の点検）
const ROLLING_SITES = [
  { op: "repark", label: "三井のリパーク", enumerate: getAllParkIds, detailUrl: reparkDetailUrl, parse: parseReparkDetail,
    idsCache: STATE.reparkSitemapCache, stateFile: STATE.reparkCrawlState, defaultPerRun: 1000,
    keyName: "parkId", hours: true, readPrev: readCachedParkIds, budgetIncludesList: true, spreadPriority: true, dailyFirst: true },
  { op: "times", label: "タイムズ", enumerate: getAllParkUrls, detailUrl: (u) => u, parse: parseTimesDetail,
    idsCache: STATE.timesUrlsCache, stateFile: STATE.timesCrawlState, defaultPerRun: 2000,
    keyName: "url", minDelay: config.timesMinDelayMs ?? 6000,
    hours: true,     // 2026-09: 詳細ページの周辺一覧から満空が読めるので、時間帯を均して回す
    // 一覧はページのURL、優先物件は BUK… で届くので、URL から BUK を取り出して照合する（2026-10-17）
    priorityKey: bukCode,
    // 一覧（sitemap）から消えた物件は閉鎖の印が付かないまま Advisor の相場に残っていた（64件。2026-10-18）
    confirmDropped: true },
  // 名鉄協商は掲載を終えた物件を 302 で /misc/404.php へ転送する。転送を追って 404.php を読み、名前が読めないまま
  // 毎回取りに行っていた（552件・一覧の22%・1日約450リクエスト。2026-10-18 に3件を確かめた）。エコロと同じく閉鎖として寝かせる
  { op: "mkp", label: "名鉄協商", enumerate: getAllMkpIds, detailUrl: mkpDetailUrl, parse: parseMkpDetail,
    idsCache: STATE.mkpIdsCache, stateFile: STATE.mkpCrawlState, defaultPerRun: 2500,
    goneOnRedirect: isMkpClosedRedirect },
  { op: "navipark", label: "ナビパーク", enumerate: getAllNaviparkCodes, detailUrl: naviparkDetailUrl, parse: parseNaviparkDetail,
    idsCache: STATE.naviparkCodesCache, stateFile: STATE.naviparkCrawlState, defaultPerRun: 2500, keyName: "code" },
  // エコロは閉じた物件を 404 ではなく 301 でトップ（/ や /park/）へ転送する。転送を追うとトップのページを物件として
  // 読み、料金が空の行（名前「コインパーキング・駐車場経営ならエコロパーク」）を24件書いていた。閉鎖として寝かせる（2026-10-18）
  //   goneOnRedirect: 転送を追わずに受け取り、転送先（location）を渡すと「閉鎖か」を返す関数。
  //                   同じホストの / と /park/ への転送だけを閉鎖（GONE）とみなす。保守・ログイン・別のホスト・
  //                   別の物件ページへの転送や、転送先が無いときは閉鎖と決めつけず、いつもの失敗（時刻だけ進める）にする
  //   recheckDropped : 一覧から外れた物件を一度だけ取り直し、閉鎖なら GONE にする（外れたまま古い日付で残さない）
  { op: "ecolo", label: "エコロパーク", enumerate: getAllEcoloIds, detailUrl: ecoloDetailUrl, parse: parseEcoloDetail,
    idsCache: STATE.ecoloIdsCache, stateFile: STATE.ecoloCrawlState, defaultPerRun: 2500,
    goneOnRedirect: isEcoloClosedRedirect, recheckDropped: true },
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

/** 一覧を作り直す前のファイルから、前の一覧を読む（unparkGone で「新しく載った番号」を見分けるため）。無ければ null */
function readPrevList(rolling) {
  try {
    if (rolling.readPrev) return rolling.readPrev(rolling.idsCache);
    const text = fs.readFileSync(rolling.idsCache, "utf8");
    return rolling.readList ? rolling.readList(text) : text.split("\n").filter(Boolean);
  } catch { return null; }
}

// 満空が取れる社。名前・座標は満空の控え（vacancy-lots.jsonl）に残るので、料金の記録に座標だけを足すことはしない（record-gap.js）
const VACANCY_OPS = new Set(["npc", ...ROLLING_SITES.filter((x) => x.hours).map((x) => x.op)]);

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
/** レポートスタジオが「厚く見てほしい」と渡してくる物件（data/priority-lots.json の byOp）。
 *  登録現場と直近のレポート地点の500m圏。無ければ空＝いままでどおり全国ローリングだけ。 */
function priorityIds(op) {
  try {
    const j = JSON.parse(fs.readFileSync("data/priority-lots.json", "utf8"));
    const ids = j?.byOp?.[op];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch { return []; }
}
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

// 事業者ごとの結果。巡回の最後に data/health/<ワークフロー名>.json に書き、Advisor が毎朝読んで
// 失敗した事業者があれば Slack で知らせる（2026-10-14。スペース24が403・GSパークが未対応のまま、
// ワークフローは「成功」で2か月気づけなかったため）。ok=false は「取れなかった」。
const health = [];
// extra … 足りないときだけ足す項目（kind・statusCounts など。src/health-kind.js の説明）。Advisor は op・label・ok・n・reason だけを読む。
// kind は ok:false の行にだけ残す（取れた行に付けると「失敗の種類」と読み違えるため）
const hp = (op, label, ok, n, reason = null, extra = null) => {
  const { kind, ...rest } = extra ?? {};
  health.push({ op, label, ok, n, reason, ...(!ok && kind ? { kind } : {}), ...rest });
};
/** 1回だけ送る取得（NPC全国・エムデン・ザ・パーク）の statusCounts。robots.txt で見送った（送っていない）ときは付けない */
const statusOf = (res) => { const c = makeCounter(); countStatus(c, res); return c.size ? { statusCounts: c.toJSON() } : {}; };
/** 一覧づくり（enumerate）の例外の種類。断られた・多すぎる・届かない・読めないのどれでもなければ「一覧を作り直せていない」 */
const listKind = (msg) => kindOfText(msg) ?? "stale-list";
function writeHealth() {
  const name = healthName();
  const at = new Date().toISOString();
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(`data/health/${name}.json`, "utf8")); } catch { /* 初回・壊れている */ }
  writeHealthFile(name, { at, workflow: name, only: process.env.CRAWL_ONLY || null, targets: withLastOk(health, prev, at) });
}
/** 巡回の最後: 失敗した事業者の入口を1回ずつ見てメンテナンスを見分けてから、health を書く */
async function finishHealth() {
  try { await markMaintenance(health, (u) => politeFetch(u)); }
  catch (e) { console.warn(`[health] メンテナンスの確認ができませんでした: ${e?.message ?? e}`); }
  writeHealth();
}
function healthName() {
  return (process.env.HEALTH_NAME || process.env.GITHUB_WORKFLOW || process.env.CRAWL_ONLY || "local").replace(/[^\w.-]+/g, "_");
}
function writeHealthFile(name, body) {
  try {
    fs.mkdirSync("data/health", { recursive: true });
    writeFileAtomic(`data/health/${name}.json`, JSON.stringify(body, null, 1) + "\n");
  } catch (e) { console.error(`[health] 書けませんでした: ${e.message}`); }
}
// 落ちた回（途中の例外・止められた）の health。前の回の事業者ごとの結果（targets）と at はそのまま残し、
// 「巡回全体 NG」の1行だけを足す（at は進めない。落ちた時刻は failedAt）。
// 以前は落ちるまでに済んだ事業者だけで前の回の行を丸ごと置き換えていたので、Advisor の crawl-health が
// 続いている失敗（スペース二十四など）を「また取れるようになった」と知らせて記録を消し、studio-index は
// 一覧型（パークネット・ザ・パークなど）の「最後に確かめた日」を料金の記録の日に戻して「60日より前」の印を
// 誤って付けていた（2026-10-18 点検）。落ちるまでに済んだ事業者の結果は partial に残す（読む側は使わない。調べるとき用）
function writeFailedHealth(reason) {
  const name = healthName();
  const run = { op: "run", label: "巡回全体", ok: false, n: 0, reason };
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(`data/health/${name}.json`, "utf8")); } catch { /* 初回・壊れている */ }
  const now = new Date().toISOString();
  if (!prev?.at || !Array.isArray(prev.targets)) {
    // 前の回の結果が無い（初回など）。落ちるまでに済んだ事業者と「巡回全体 NG」を書く
    writeHealthFile(name, { at: now, workflow: name, only: process.env.CRAWL_ONLY || null, targets: [...health, run] });
    return;
  }
  // 前の回も落ちていたときの「巡回全体」は今回のものに置き換える（同じ行が積み重ならないように）
  writeHealthFile(name, { ...prev, targets: [...prev.targets.filter((t) => t.op !== "run"), run], failedAt: now, partial: health });
}
// 落ちたときの後始末。読み込んだ巡回状態を書き出し（50件ごとの保存の間に取った物件のぶん）、health に「巡回全体 NG」を足す
function onFailure(reason) {
  try {
    const n = flushCrawlStates();
    if (n) console.error(`[stop] 巡回状態 ${n}件を書き出しました`);
  } catch (e) { console.error(`[stop] 巡回状態を書けませんでした: ${e.message}`); }
  writeFailedHealth(reason);
}

async function main() {
  // OUT_FILE で出力先を上書き可（ワークフロー分割時の push 競合回避用）。
  const outFile = path.resolve(process.env.OUT_FILE || config.outFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const last = readLastSnapshots(outFile);
  const now = new Date().toISOString();   // 実行開始。個々の観測時刻は取得のたびに付ける

  const stats = { processed: 0, written: 0, changed: 0, isNew: 0, vacancy: 0, filled: 0 };
  // 満空の置き場。料金とは別ファイルにする（追記の条件が違うため）。
  // 名前・座標・台数は初回だけ入れ、以降は id で引く（同じ値を毎回書かない）
  // 月ごとに分ける。1本にすると1年で数百MBになり、毎回の巡回でコミットするgitが重くなる。
  // 先月以前のファイルは二度と変わらないので、gitはそれ以上太らない。
  // 日付は**観測した時刻**（日本時間）から決める。実行開始時に決めると、4時間半まわる
  // NPC の実行が日をまたいだとき、翌日の観測が前日のファイルに入る。
  const vacancyFileOf = (atIso) => process.env.VACANCY_FILE
    // 日ごと（JST）に分ける。月ごとだと1か月で100MiBを超え、GitHub が push を拒否する（2026-09 は 9/26 に超える見込みだった）
    || `data/vacancy-${new Date(new Date(atIso).getTime() + 9 * 3600e3).toISOString().slice(0, 10)}.jsonl`;
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
  // カーシェア（タイムズカー）の有無。1行＝1物件の状態で、変わったときだけ追記（同じ物件は最後の行が最新）
  const carShareFile = process.env.CARSHARE_FILE || "data/carshare-times.jsonl";
  const csMeta = {};
  try {
    for (const line of fs.readFileSync(carShareFile, "utf8").split("\n")) {
      if (!line) continue;
      try { const j = JSON.parse(line); csMeta[j.k] = j; } catch { /* 壊れた行は飛ばす */ }
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
    // 料金は同じでも、前の記録に無かった名前・住所・座標（満空の無い社だけ）が読めたら1回だけ足す（record-gap.js）。
    // 料金の変動ではないので changedFromPrev は付けず、変動の件数にも数えない。足したあとは前の記録に入っているので2回目は足さない
    const filled = prev && !isChanged ? gapFilled(prev, rec, { coords: !VACANCY_OPS.has(rec.operator) }) : null;
    // 全国規模ではファイル肥大を防ぐため、新規 or 変動時のみ追記する。
    if (!vacancyOnly && (!config.appendOnlyChanges || isNew || isChanged || filled)) {
      fs.appendFileSync(outFile, JSON.stringify(rec) + "\n");
      stats.written++;
      if (filled) {
        stats.filled++;
        if (stats.filled <= 20) console.log(`  [FILLED] ${key} (${rec.name}) ${filled}が読めたので記録に足す`);
      }
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
      // w: 世界測地系に換算済みの印（タイムズ。印の無い古い行は読む側で換算する）
      const m = { k: key, n: rec.name ?? null, la: rec.lat ?? null, ln: rec.lng ?? null, c: rec.capacity ?? null, ...(rec.datum === "wgs84" ? { w: 1 } : {}) };
      const prevMeta = vacMeta[key];
      if (!prevMeta || prevMeta.la !== m.la || prevMeta.ln !== m.ln || prevMeta.c !== m.c || prevMeta.n !== m.n) {
        vacMeta[key] = m;
        fs.appendFileSync(vacancyMetaFile, JSON.stringify(m) + "\n");
      }
    }
    // 同じページに載っていた周辺の満空（タイムズ）。料金の時系列には混ぜず、観測だけ残す。
    // 周辺の物件は後で自分のページも取られるので、名前・座標はそのとき更新される
    for (const nb of rec.nearbyVacancy ?? []) {
      if (!nb.parkId || !nb.status) continue;
      const nkey = `${rec.operator}:${nb.parkId}`;
      fs.appendFileSync(vacancyFileOf(at), JSON.stringify({ at, op: rec.operator, id: nb.parkId, s: nb.status }) + "\n");
      stats.vacancy++;
      const m = { k: nkey, n: nb.name ?? null, la: nb.lat ?? null, ln: nb.lng ?? null, c: null, ...(nb.datum === "wgs84" ? { w: 1 } : {}) };
      const pm = vacMeta[nkey];
      // 換算済みの座標が来たら、旧測地系のままの控えを置き換える
      if (!pm || (pm.la == null && m.la != null) || (!pm.n && m.n) || (m.w && !pm.w && m.la != null)) {
        vacMeta[nkey] = m.w && m.la != null ? { ...m, c: pm?.c ?? null, n: m.n ?? pm?.n ?? null }
          : { ...m, c: pm?.c ?? null, la: m.la ?? pm?.la ?? null, ln: m.ln ?? pm?.ln ?? null };
        fs.appendFileSync(vacancyMetaFile, JSON.stringify(vacMeta[nkey]) + "\n");
      }
    }
    // タイムズカーの有無（タイムズのみ）。初めて見た物件は「無し」も1行残す（有無を確かめた印）
    if (rec.operator === "times" && "carShare" in rec) {
      const cs = { k: key, scd: rec.carShare?.scd ?? null, on: rec.carShare ? 1 : 0, n: rec.name ?? null, a: rec.address ?? null,
        la: rec.lat ?? null, ln: rec.lng ?? null, at };
      const pc = csMeta[key];
      if (!pc || pc.on !== cs.on || pc.scd !== cs.scd || (pc.la == null && cs.la != null)) {
        csMeta[key] = cs;
        fs.appendFileSync(carShareFile, JSON.stringify(cs) + "\n");
        stats.carShare = (stats.carShare ?? 0) + 1;
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
    // ---- 止めている事業者（config の paused）----
    // 先方に断られている社。一覧も詳細も取らない（robots.txt も取りに行かない）。health には ok=false の「停止中」を
    // 残す。消すと Advisor に「直った」と届き、studio-index.mjs の「長く取れていない」の判定も外れるため。
    // 名前は今までの health と同じ（表の label。スペース二十四・小田急パーキング）にして、Advisor の通知の鍵を変えない
    if (t.paused) {
      const label = ROLLING_SITES.find((x) => x.op === t.operator)?.label ?? t.label ?? t.operator;
      console.log(`[停止中] ${label}: ${t.paused}`);
      hp(t.operator, label, false, 0, `停止中: ${t.paused}`, { kind: "paused" });
      continue;
    }

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
        try { res = await politeFetch(url); } catch (e) {
          const m = fetchErrorText(e); console.error(`[error] NPC全国: ${m}`);
          hp("npc", "NPC全国", false, 0, m, { kind: "network", statusCounts: { network: 1 } }); continue;
        }
        if (!res.ok || res.skippedReason) {
          console.error(`[error] NPC全国: ${res.skippedReason ?? "HTTP " + res.status}`);
          hp("npc", "NPC全国", false, 0, res.skippedReason ?? "HTTP " + res.status, { kind: kindOfFetch(res), ...statusOf(res) }); continue;
        }
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
        hp("npc", `NPC全国 ${i + 1}/${repeat}`, records.length > 0, records.length, records.length ? null : "0件", { kind: "parse", ...statusOf(res) });
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
      const prevIds = readPrevList(rolling);   // 作り直す前の一覧（作り直すと上書きされるので先に読む）
      const listStartedAt = Date.now();
      try {
        ids = await rolling.enumerate({ cacheFile: rolling.idsCache, cacheMs: 7 * 864e5 });
      } catch (e) { const m = fetchErrorText(e); console.error(`[error] ${rolling.op} enumerate: ${m}`); hp(rolling.op, rolling.label, false, 0, `一覧: ${m}`, { kind: listKind(m) }); continue; }
      const state = loadCrawlState(rolling.stateFile);
      // 一覧に新しく載った物件のうち、404で寝かせていたものを起こす（復活している見込みがあるため）。
      // 一覧が変わっても、前から載っている寝かせた物件は起こさない（寝かせる期限は物件ごとに30〜60日。goneMsOf）
      const woke = unparkGone(state, ids, prevIds);
      if (woke) console.log(`[${rolling.label}] 一覧に新しく載った${woke}件は寝かせていたので起こす`);
      // 1周の回数は「生きている物件」で割る。404で寝かせた分を含めると1周が短くなる
      const liveCount = countLive(ids, state);
      // 1回あたりの件数は perRunIds（リパークは sitemap の分だけ）で決める。地図の一覧で増えた物件で、1回あたりの詳細ページを増やさない
      // （増えた分は1周が延びるだけ。2026-10-18）
      const sizeCount = ids.perRunIds ? countLive(ids.perRunIds, state) : liveCount;
      const perRun = rollingPerRun(rolling.op, sizeCount, config[`${rolling.op}RollingPerRun`] ?? rolling.defaultPerRun);
      const visited = ids.filter((id) => state[id]).length;
      // 一覧から外れたが、まだ閉鎖と分かっていない物件（recheckDropped の社だけ）。巡回の候補に足して一度取り直す。
      // 閉鎖なら GONE になって候補から外れ、営業中なら取れた日が進む（一覧の取りこぼしがあっても古いまま残らない）
      const listed = new Set(ids);
      const dropped = rolling.recheckDropped
        ? Object.keys(state).filter((k) => !k.startsWith("_") && !listed.has(k) && !String(state[k]).startsWith("GONE|"))
        : [];
      const candidates = dropped.length ? ids.concat(dropped) : ids;
      // 1回の実行を何回かに分け、間をあけて取る。
      // GitHub の定時実行は混むと落ちることがあり、毎時の cron でも実測で24時間中18時間しか
      // 発火していなかった（JST 7・14・17・18・21・22時が丸ごと空。2026-09-15）。
      // 時間帯をそろえる pickRolling の spreadHours は「どの物件を取るか」を選ぶ仕掛けなので、
      // 実行そのものが起きなかった時刻は埋められない。
      // そこで NPC と同じように、1回の実行の中で間をあけて2回に分ける。
      // **取る件数の合計は変えない**（相手先への負荷は据え置き）。1回の実行が2時間ぶんの
      // 時間帯を埋めるので、cron が1回飛んでも穴が開かない。
      const passes = Math.max(1, Number(process.env.ROLLING_PASSES) || (rolling.hours ? 2 : 1));
      const gapMin = process.env.ROLLING_PASS_GAP_MIN !== undefined && process.env.ROLLING_PASS_GAP_MIN !== ""
        ? Number(process.env.ROLLING_PASS_GAP_MIN) : 25;
      if (!Number.isFinite(gapMin) || gapMin < 0) throw new Error(`ROLLING_PASS_GAP_MIN が数値ではありません: ${process.env.ROLLING_PASS_GAP_MIN}`);
      const gapMs = gapMin * 60_000;
      const perPass = Math.max(1, Math.ceil(perRun / passes));
      // 優先物件は一覧の書き方に読み替えてから渡す（タイムズは BUK… → ページのURL）。
      // ログには「当たった件数」を出す。以前は届いた件数を出していたので、タイムズで1件も当たっていないのに
      // 「優先622件」と表示され、気づけなかった（2026-10-17。本人指示: 直せるものは直して）
      const want = priorityIds(rolling.op);
      const { ids: prio, missing: prioMissing } = matchPriority(want, ids, rolling.priorityKey);
      // 優先物件を取り直す間隔。毎時回るリパークは3時間おき。1日3回のタイムズで3時間にすると毎回621件を
      // 取り直して全国の1巡が約25日に延びるので、事業者ごとに config で変えられるようにする（2026-10-17）
      const prioMinAgeH = Number(config[`${rolling.op}PriorityMinAgeHours`]) || 3;
      // 一覧から消えた物件のうち、今の一覧を作ってから確かめていないもの（confirmDropped の社だけ。1回目の回の先頭で取りに行く）。
      // 404 なら GONE が付いて相場から外れる。載っていれば料金・満空をそのまま残す（pickDropped の説明）。
      // 上の recheckDropped（エコロ）は外れた物件を巡回の候補に足し続ける。こちらは一覧を作り直すたびに1回だけ確かめる
      const confirm = rolling.confirmDropped
        ? pickDropped(ids, state, Date.now() - cacheAgeMs(rolling.idsCache), Number(process.env.DROPPED_MAX) || 100, rolling.priorityKey) : [];
      const confirmSet = new Set(confirm);
      let confirmGone = 0;
      // 時間の予算。GitHub の上限で途中で殺されると、状態も満空も何も残らず次回も同じ物件を叩く。
      // 予算内で切り上げ、状態は50件ごとに書いておく。
      // 分割の待ち時間（pausedMs）は予算から除く。除かないと待った分だけ取得が削られる
      const budgetMin = Number(process.env.ROLLING_BUDGET_MIN) || 45;
      const budgetMs = budgetMin * 60_000;
      // 1巡の目安は「予算内で取れる件数」で割る。perRun だけで割ると、タイムズは45分（約450件）で
      // 切り上げているのに「1巡目安: 約8回」と出て、実際の約16日（約50回）とかけ離れていた（2026-10-17）
      const perRunCap = Math.min(perRun, Math.floor(budgetMs / (rolling.minDelay ?? config.minDelayMs)));
      console.log(
        `[${rolling.label}] 全${ids.length}件（生きている${liveCount}件） / 既訪${visited}件` +
        `${dropped.length ? ` / 一覧から外れた${dropped.length}件を取り直す` : ""}` +
        `${want.length ? ` / 優先${prio.length}件（${prioMinAgeH}時間おき${prioMissing ? `・一覧に無い${prioMissing}件` : ""}）` : ""} / ` +
        `今回${perRun}件を${passes}回に分けて取得（1回${perPass}件` +
        `${passes > 1 ? `・${gapMin}分あける` : ""}・予算${budgetMin}分で約${perRunCap}件まで）。` +
        `1巡目安: 約${Math.ceil(liveCount / Math.max(1, perRunCap))}回実行（優先の取り直しぶんは別）` +
        `${confirm.length ? ` / 一覧から消えた${confirm.length}件を確かめる` : ""}`
      );
      // 一覧の作り直しの時間も予算に入れる社（budgetIncludesList）は、一覧を作り始めた時刻から数える
      const startedAt = rolling.budgetIncludesList ? listStartedAt : Date.now();
      let pausedMs = 0;
      const fetchOpts = rolling.minDelay || rolling.goneOnRedirect
        ? { ...(rolling.minDelay ? { minDelay: rolling.minDelay } : {}), ...(rolling.goneOnRedirect ? { redirect: "manual" } : {}) }
        : undefined;
      let done = 0, got = 0, tried = 0, nGone = 0, noName = 0, busy = 0;
      let out = false;
      // 相手先の不調（5xx・429・403・タイムアウト・混み合いのページ）が続いたら、この回は打ち切る（makeBreaker の説明）
      const breakerN = Number(process.env.ROLLING_BREAKER) || 8;
      const breaker = makeBreaker(breakerN);
      let broke = null, retried = 0, brokeKind = null;
      // health に足す数（src/health-kind.js）。statusCounts … 送った本ページの状態コードごとの件数。
      // failKinds … この回の失敗の種類ごとの件数（1件も取れなかった回の kind）。streakKinds … 打ち切りの数に入った失敗の種類
      // （先方が答えたら数え直す。打ち切った回の kind はこの中でいちばん多いもの）
      const statusCounts = makeCounter(), failKinds = makeCounter(), streakKinds = makeCounter();
      // 一斉の閉鎖の歯止め（makeMassGone の説明）。前は生きていた物件の閉鎖（404・410・掲載終了の転送）が
      // 30件以上、かつ答えが返った数の半分以上になったら、または閉鎖でない答えをはさまず続けて20件になったら（回の途中から
      // 保守の画面などに切り替わったとき）、この回に付けた閉鎖の印を全部戻して打ち切る。MASS_GONE_MIN・MASS_GONE_RATIO・MASS_GONE_STREAK で変えられる
      const massGone = makeMassGone({ min: Number(process.env.MASS_GONE_MIN) || 30, ratio: Number(process.env.MASS_GONE_RATIO) || 0.5,
        streak: Number(process.env.MASS_GONE_STREAK) || 20 });
      let massRestored = 0;
      for (let pass = 0; pass < passes && !out; pass++) {
        if (pass > 0) {
          console.log(`[${rolling.label}] ${gapMin}分あけて ${pass + 1}/${passes} 回目`);
          await sleep(gapMs);
          pausedMs += gapMs;
        }
        // 各回の開始時刻で選び直す。2回目は「その時刻の満空がまだ無い物件」が選ばれる
        const picked = pickRolling(candidates, state, perPass, pickOptsOf(rolling, { at: new Date().toISOString(),
          priority: prio, priorityMinAgeMs: prioMinAgeH * 3600e3 }));
        const batch = pass === 0 ? confirm.concat(picked) : picked;
        if (!batch.length) { console.log(`[${rolling.label}] ${pass + 1}/${passes} 回目: 取る物件がありません`); continue; }
      for (const id of batch) {
        if (Date.now() - startedAt - pausedMs > budgetMs) { console.warn(`  [budget] ${budgetMs / 60000}分を超えたので ${done}件で切り上げ`); out = true; break; }
        const url = rolling.detailUrl(id);
        const at = new Date().toISOString();   // この物件を取った時刻
        const mark = (r, seen) => recordVisit(state, id, at, r, { hours: !!rolling.hours, seen });
        let res, err = null;
        try { res = await politeFetch(url, fetchOpts); } catch (e) { res = null; err = fetchErrorText(e); }
        // robots.txt で断られた（401・403）・robots.txt に届かない（通信の失敗・5xx）。どちらも本ページは送っていない。
        // 同じ origin の物件はみな同じ答えになるので、この社のこの回はここで打ち切る。物件の状態は書かない
        // （確かめていない日を「取りに行った日」にしない。届かないときは次の回で robots.txt から取り直す）。
        // 2026-10-17 のエコロは robots.txt も取れなかったのに、45分間で257回取りに行き、257件に日付だけが入った
        if (res?.blocked || res?.transient) {
          broke = res.blocked ? `${res.skippedReason}。この回は打ち切り` : `${res.skippedReason}のでこの回は見送り（${res.robotsError ?? "原因不明"}）`;
          brokeKind = kindOfFetch(res);   // blocked。届かないときは network（robots.txt が 429 なら rate）
          console.warn(`  [abort] ${rolling.label}: ${broke}。${done}件取れたところで止める`);
          out = true; break;
        }
        tried++;
        countStatus(statusCounts, res);
        // 一斉の閉鎖の歯止めに数える物件か。前は生きていた物件（今の一覧に載っていて、取った記録があり、寝かせていない）だけ。
        // 一覧から消えた物件の確かめ（confirm）・一覧から外れた物件（dropped）・寝かせた物件の起き抜け・初めての物件は、
        // 閉鎖が多くて当たり前なので数えない（止めたときに印を戻すのは、数えない分も含めて全部）。prevState は印を付ける前の値
        const prevState = state[id];
        const watch = prevState !== undefined && !String(prevState).startsWith("GONE|") && listed.has(id) && !confirmSet.has(id);
        const tripIfMassGone = () => {
          if (!massGone.closed(id, prevState, watch)) return false;
          const { answered, closed, streak, trippedBy } = massGone.stats;
          massRestored = massGone.restore(state);
          broke = (trippedBy === "streak"
            ? `閉鎖とみなした物件が続きすぎる（前は取れていた物件が続けて${streak}件 404・掲載終了の転送。この回の答え${answered}件のうち閉鎖${closed}件）。`
            : `閉鎖とみなした物件が多すぎる（前は取れていた物件${answered}件のうち${closed}件が 404・掲載終了の転送）。`) +
            `先方のサイトの作り替え・保守の見込みがあるので、この回に付けた閉鎖の印${massRestored}件を戻して打ち切り`;
          brokeKind = "mass-gone";
          console.warn(`  [mass-gone] ${rolling.label}: ${broke}。${done}件取れたところで止める`);
          return true;
        };
        // 相手先の不調。1回目は時刻を進めず次の回に取り直す。続いたら打ち切る。
        // 戻り値は「打ち切るか」。kind はこの失敗の種類（network・rate・blocked）
        const transientFail = (why, kind) => {
          failKinds.add(kind);
          const again = recordTransient(state, id, at, { hours: !!rolling.hours });
          if (again) retried++;
          console.error(`  [error] ${id}: ${why}${again ? "（次の回に取り直す）" : ""}`);
          // 前の回も取れなかった物件（取り直しの2回目）は数えない。壊れたページは取り直しで古い順の先頭に
          // 並ぶので、数えると先方が元気でも打ち切ってしまう
          if (!again) return false;
          streakKinds.add(kind);
          if (!breaker.fail()) return false;
          broke = `相手先の不調で打ち切り（${breakerN}件続けて取れず。最後は ${why}）`;
          brokeKind = dominantKind(streakKinds.counts) ?? kind;
          console.warn(`  [breaker] ${broke}。${done}件取れたところで止める`);
          return true;
        };
        if (isTransient(res)) {
          if (transientFail(err ?? `HTTP ${res.status}`, kindOfFetch(res))) { out = true; break; }
          continue;
        }
        // 先方が答えた（不調ではない）。打ち切りの数え直しと、一斉の閉鎖の「答えた数」に入れる。
        // 混み合いのページ（HTTP 200 で中身が無い）は答えたことにしないので、読んで確かめてから呼ぶ
        // isClosed … 閉鎖の答え（404・410・掲載終了の転送）か。閉鎖でない答えなら、一斉の閉鎖の連続の数を0に戻す
        const answered = (isClosed = false) => { breaker.ok(); streakKinds.reset(); if (watch) massGone.answered(isClosed); };
        // 閉じた物件をトップへ転送する社（エコロ・名鉄協商）。404 と同じく寝かせる
        if (rolling.goneOnRedirect && res.status >= 300 && res.status < 400 && rolling.goneOnRedirect(res.location)) {
          answered(true); failKinds.add("parse");
          console.log(`  [gone] ${id} → ${res.location}（転送＝掲載終了）`); mark({ status: 404 }); nGone++;
          if (confirmSet.has(id)) confirmGone++;
          if (tripIfMassGone()) { out = true; break; }
          continue;
        }
        if (!res.ok || res.skippedReason) {
          const closed = res.status === 404 || res.status === 410;
          answered(closed); failKinds.add(kindOfFetch(res));
          console.error(`  [error] ${id} ${res.skippedReason ?? "HTTP " + res.status}`);
          if (confirmSet.has(id) && closed) confirmGone++;
          mark(res);
          if (closed && tripIfMassGone()) { out = true; break; }
          continue;
        }
        let rec;
        // 中身が読めなくても取得はできている。時刻は進めないと古い順の先頭に居座る
        try { rec = rolling.parse(res.html, { [rolling.keyName ?? "id"]: id }); }
        catch (e) {
          // 相手先が混み合っているページ（タイムズの「ただいま大変混み合っております」。times.js が e.transient を付ける）。
          // HTTP 200 でも 503 と同じ不調なので、取りに行った扱いにせず次の回に取り直し、打ち切りの数にも入れる。
          // 以前は [parse error] として時刻を進めていたので、その物件は1巡（約8〜11日）後ろへ回り、
          // 打ち切りの数も parse の前の breaker.ok() で数え直されていた（2026-10-18 点検）
          if (e?.transient) {
            busy++;
            if (transientFail(`混み合いのページ（${e.message}）`, "network")) { out = true; break; }
            continue;
          }
          answered(); failKinds.add("parse");
          console.error(`  [parse error] ${id}: ${e.message}`); mark(res, false); continue;
        }
        answered();
        // 取れたのに名前が読めない（ページの作りが違う・掲載終了の雛形など）。以前は何も出さずに飛ばしていたので、
        // 名鉄協商の552件が毎回むだに取られていることに3か月気づけなかった。番号を出し（1回20件まで）、health に件数を残す
        if (!rec || !rec.name) {
          failKinds.add("parse");
          if (++noName <= 20) console.warn(`  [no name] ${id}: 名前が読めない（HTTP ${res.status}・${(res.html ?? "").length}バイト）`);
          mark(res, false); continue;
        }
        rec._requestUrl = url;
        handleRecord(rec, at);
        got++;
        // 満空が取れる社では「その時刻を見た」と記録するのは満空が読めたときだけ。
        // ページの作りが変わって読めなくなっても時間帯が埋まると、止まったことに気づけない
        mark(res, rolling.hours ? !!rec.fullEmptyStatus : undefined);
        if (++done % 50 === 0) saveCrawlState(rolling.stateFile, state);
      }
        saveCrawlState(rolling.stateFile, state);   // 各回の終わりに残す（次の回で落ちても無駄にしない）
      }
      saveCrawlState(rolling.stateFile, state);
      if (nGone) console.log(`[${rolling.label}] 転送で掲載終了と分かった物件 ${nGone}件を寝かせた${massRestored ? "（一斉の閉鎖とみなしたので、この回の印は戻した）" : ""}`);
      if (massRestored) console.warn(`[${rolling.label}] 一斉の閉鎖とみなして、この回に付けた閉鎖の印 ${massRestored}件を前の値に戻した`);
      if (noName) console.warn(`[${rolling.label}] 取れたのに名前が読めなかった物件 ${noName}件${noName > 20 ? "（番号は最初の20件だけ出した）" : ""}`);
      if (retried) console.log(`[${rolling.label}] 相手先の不調で取れなかった${retried}件は、次の回に取り直す${busy ? `（うち混み合いのページ${busy}件）` : ""}`);
      if (confirm.length) console.log(`[${rolling.label}] 一覧から消えた${confirm.length}件のうち、閉鎖（404）だった${confirmGone}件に印を付けた${massRestored ? "（一斉の閉鎖とみなしたので、印は戻した）" : ""}`);
      // 取りに行ったのに1件も読めなかったら失敗（403・ページの作りの変更など）。取る物件が無かった回は成功。
      // 不調で打ち切った回も失敗として知らせる（2026-10-02 は半分取れたので「成功」になり、気づけなかった）。
      // 一覧を長く作り直せず前の一覧で回している社（staleReason。times-enumerate.js・cache-age.js の keepPrevIfShrunk）も知らせる。
      // 一覧の一部の市区が取れなかった・作り直せず前の一覧で回している（listNote。navipark-enumerate.js）は、ok のまま reason の最後に出す。
      // 一覧が0件の回も失敗（以前は「取る物件が無かった回」として成功になる作りで、2026-10-18 の点検の試しでは、ナビパークが0件の一覧で
      // 7日止まっても health は成功のままだった）
      // kind（失敗の種類。src/health-kind.js）は reason と同じ順で決める: 打ち切った理由 → 一覧の問題 → この回の失敗でいちばん多い種類
      const listProblem = !!ids.staleReason || ids.length === 0;
      hp(rolling.op, rolling.label, !broke && !listProblem && (tried === 0 || got > 0), got,
        broke ?? ids.staleReason ?? (ids.length === 0 ? "一覧が0件" : null)
          ?? (tried > 0 && got === 0 ? `${tried}件取りに行って0件${noName ? `（名前が読めない${noName}件）` : ""}` : null) ?? ids.listNote ?? null,
        { tried, noName, ...(busy ? { busy } : {}), statusCounts: statusCounts.toJSON(),
          kind: brokeKind ?? (listProblem ? "stale-list" : null) ?? dominantKind(failKinds.counts) ?? "parse",
          ...(massRestored ? { restored: massRestored } : {}),
          ...(ids.listInfo ? { list: ids.listInfo } : {}) });
      continue;
    }

    // ---- GSパーク 全国（エリア一覧に料金直載・毎回全巡回） ----
    // 2026-10-14 復活。読み取り（gspark.js）と設定はあったのに、ここの処理が抜けていて「未対応」で飛ばされていた
    if (t.operator === "gspark" && t.mode === "nationwide") {
      let codes;
      try {
        if (cacheFresh(STATE.gsparkAreasCache, 7 * 864e5)) codes = fs.readFileSync(STATE.gsparkAreasCache, "utf8").split("\n").filter(Boolean);
        else {
          const top = await politeFetch("https://www.gs-park.com/time_parking/");
          if (!top.ok || top.skippedReason) throw new Error(top.skippedReason ?? `HTTP ${top.status}`);
          codes = parseAreaCodes(top.html);
          if (!codes.length) throw new Error("エリアが0件（ページ構造変更の可能性）");
          fs.writeFileSync(STATE.gsparkAreasCache, codes.join("\n") + "\n"); markFetched(STATE.gsparkAreasCache);
        }
      } catch (e) { console.error(`[error] gspark enumerate: ${e.message}`); hp("gspark", t.label, false, 0, `一覧: ${e.message}`, { kind: listKind(e.message) }); continue; }
      let count = 0, stop = null, stopKind = null;
      const statusCounts = makeCounter(), failKinds = makeCounter();
      for (const code of codes) {
        if (stop) break;
        for (let page = 1; page <= 30; page++) {
          const url = areaListUrl(code, page);
          let res;
          try { res = await politeFetch(url); } catch (e) { countStatus(statusCounts, null); failKinds.add("network"); console.error(`  [error] ${code} p${page}: ${fetchErrorText(e)}`); break; }
          // robots.txt で断られた・届かないときは、残りのページも同じ答えなので止める（本ページは送っていない）
          if (res.blocked || res.transient) { stop = res.skippedReason; stopKind = kindOfFetch(res); console.warn(`  [abort] GSパーク: ${stop}`); break; }
          countStatus(statusCounts, res);
          if (!res.ok || res.skippedReason) { failKinds.add(kindOfFetch(res)); break; }
          const { records, hasNext } = parseGsparkList(res.html);
          for (const rec of records) { rec._requestUrl = url; handleRecord(rec); count++; }
          if (!hasNext || !records.length) break;
        }
      }
      console.log(`[ok] GSパーク全国 | ${count}物件（エリア${codes.length}）`);
      // 途中で止めた回は失敗（一覧型は「直近の実行が成功していれば全件をその日に確かめた」とみなされるため）
      hp("gspark", t.label, count > 0 && !stop, count, stop ?? (count ? null : "0件"),
        { statusCounts: statusCounts.toJSON(), kind: stopKind ?? dominantKind(failKinds.counts) ?? "parse" });
      continue;
    }

    // ---- パークネット 全国（市区一覧に料金直載・毎回全巡回） ----
    if (t.operator === "parknet" && t.mode === "nationwide") {
      let cities;
      try {
        cities = await getAllParknetCities({ cacheFile: STATE.parknetCitiesCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] parknet enumerate: ${e.message}`); hp("parknet", "パークネット", false, 0, `一覧: ${e.message}`, { kind: listKind(e.message) }); continue; }
      console.log(`[パークネット] 市区${cities.length}件を巡回`);
      // 市区ごとに最後のページまで取る（10件ずつのページ送り）。中身は parknet-enumerate.js の crawlParknetCities・parknetHealth。
      // 途中のページが取れなかった市区は、そこまでの分を記録して次の市区へ進む（何も消さない）。市区ごとの印は health の補足に残す。
      // 状態コードはページごとの答え（onFetch。例外は null＝network）で数え、失敗の種類は取れなかったページの答え（failures[].res）と
      // 打ち切ったときの答え（stopRes）から決める（health-kind.js）
      const statusCounts = makeCounter(), failKinds = makeCounter();
      const sum = await crawlParknetCities(cities, { onRecord: (rec) => handleRecord(rec), onFetch: (res) => countStatus(statusCounts, res) });
      for (const f of sum.failures) failKinds.add(kindOfFetch(f.res));
      console.log(`[ok] パークネット | ${sum.count}物件（${sum.pages}ページ）`);
      const ph = parknetHealth(sum);
      hp("parknet", "パークネット", ph.ok, ph.n, ph.reason,
        { ...ph.extra, statusCounts: statusCounts.toJSON(),
          kind: (sum.stopRes ? kindOfFetch(sum.stopRes) : null) ?? dominantKind(failKinds.counts) ?? "parse" });
      continue;
    }

    // ---- エムデン・テクノパーキング 全国（1ページに全物件） ----
    if (t.operator === "mden" && t.mode === "nationwide") {
      const url = mdenListUrl();
      let res;
      try { res = await politeFetch(url); } catch (e) { const m = fetchErrorText(e); console.error(`[error] mden: ${m}`); hp("mden", "エムデン", false, 0, m, { kind: "network", statusCounts: { network: 1 } }); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] mden: ${res.skippedReason ?? "HTTP " + res.status}`); hp("mden", "エムデン", false, 0, res.skippedReason ?? `HTTP ${res.status}`, { kind: kindOfFetch(res), ...statusOf(res) }); continue; }
      const records = parseMdenList(res.html);
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] エムデン・テクノパーキング | ${records.length}物件`);
      hp("mden", "エムデン", records.length > 0, records.length, records.length ? null : "0件", { kind: "parse", ...statusOf(res) });
      continue;
    }

    // ---- ザ・パーク 全国（単一JSON一括） ----
    if (t.operator === "thepark" && t.mode === "nationwide") {
      const url = theparkUrl();
      if (cachedRecently(url)) { console.log(`[cache] ザ・パーク全国 スキップ`); continue; }
      let res;
      try { res = await politeFetch(url); } catch (e) { const m = fetchErrorText(e); console.error(`[error] ザ・パーク: ${m}`); hp("thepark", "ザ・パーク", false, 0, m, { kind: "network", statusCounts: { network: 1 } }); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] ザ・パーク: ${res.skippedReason ?? "HTTP " + res.status}`); hp("thepark", "ザ・パーク", false, 0, res.skippedReason ?? "HTTP " + res.status, { kind: kindOfFetch(res), ...statusOf(res) }); continue; }
      const records = parseTheparkJson(res.html, { label: "ザ・パーク全国" });
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] ザ・パーク全国 | ${records.length}物件`);
      hp("thepark", "ザ・パーク", records.length > 0, records.length, records.length ? null : "0件", { kind: "parse", ...statusOf(res) });
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
    hp(t.operator, t.label ?? t.operator, false, 0, "未対応の target（処理が無い）");
  }


  console.log(
    `\n完了: ${stats.processed}物件処理 / 新規${stats.isNew} / 変動${stats.changed} / 追記${stats.written}行` +
    `${stats.filled ? `（うち名前・住所・座標の補記${stats.filled}行）` : ""} / 満空${stats.vacancy}行 → ${process.env.OUT_FILE || config.outFile}`
  );
}

// 止められたとき（巡回の手順の時間切れ・ジョブの取り消し）。GitHub のランナーは手順を止めるとき、手順のいちばん上の
// プロセスにだけ SIGINT を送り、7.5秒後に SIGTERM、さらに2.5秒後に kill する（その下のプロセスには何も届かない）。
// ワークフローの巡回の手順は `exec node src/run.js` で node 自身をいちばん上にしているので、ここに届く。
// 以前の `npm run crawl` では bash だけが止まり、node は残って共有の満空ファイルに追記し続けたため、
// コミットの手順の git pull が「Your local changes … would be overwritten」で失敗し、その回の観測が何も残らなかった（2026-10-18 点検）。
// 観測は取るたびに追記済みなので、巡回状態と health を書いてすぐ終わる（取得の途中でも待たない）
let stopping = false;
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(sig, () => {
    if (stopping) process.exit(code);
    stopping = true;
    console.error(`[stop] ${sig} を受けました。ここまでの巡回状態と health を書いて終わります`);
    onFailure(`${sig} で止められました（巡回の手順の時間切れか、取り消し）`);
    process.exit(code);
  });
}

main().then(finishHealth).catch((e) => { console.error(e); onFailure(String(e?.message ?? e)); process.exit(1); });
