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
import { politeFetch } from "./polite-fetch.js";
import { detailUrl as reparkDetailUrl, parseReparkDetail } from "./repark.js";
import { searchUrl, locationUrl, JAPAN_BBOX, parseNpcSearch } from "./npc.js";
import {
  getAllParkIds, loadCrawlState, saveCrawlState, pickRolling,
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

// 2026-08 追加分の「列挙→ローリングで詳細取得」型（挙動が同一なので表で持つ）
const ROLLING_SITES = [
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
  const now = new Date().toISOString();

  const stats = { processed: 0, written: 0, changed: 0, isNew: 0 };

  // CRAWL_ONLY=times / npc,repark などで対象事業者を絞れる（ワークフロー分割用）。
  const only = (process.env.CRAWL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = only.length
    ? config.targets.filter((t) => only.includes(t.operator))
    : config.targets;

  // 1物件分の処理（差分検知＋追記）。
  function handleRecord(rec) {
    rec.fetchedAt = now;
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
    if (!config.appendOnlyChanges || isNew || isChanged) {
      fs.appendFileSync(outFile, JSON.stringify(rec) + "\n");
      stats.written++;
    }
    last.set(key, rec);
    stats.processed++;
  }

  // ページキャッシュ判定（単純な単一リクエスト対象用）。
  function cachedRecently(requestUrl) {
    const repr = [...last.values()].find((r) => r._requestUrl === requestUrl);
    return repr && Date.now() - new Date(repr.fetchedAt).getTime() < config.pageCacheMs;
  }

  for (const t of targets) {
    // ---- NPC 全国（bbox 一括） ----
    if (t.operator === "npc" && t.mode === "nationwide") {
      const url = locationUrl(JAPAN_BBOX, { limit: 2000 });
      if (cachedRecently(url)) { console.log(`[cache] NPC全国 スキップ`); continue; }
      let res;
      try { res = await politeFetch(url); } catch (e) { console.error(`[error] NPC全国: ${e.message}`); continue; }
      if (!res.ok || res.skippedReason) { console.error(`[error] NPC全国: ${res.skippedReason ?? "HTTP " + res.status}`); continue; }
      let total = null;
      try { total = JSON.parse(res.html).total; } catch { /* */ }
      const records = parseNpcSearch(res.html, { label: "NPC全国" });
      if (total != null && total > records.length) {
        console.warn(`[warn] NPC全国: total=${total} だが ${records.length}件のみ取得。limit引上げ/ページングが必要`);
      }
      records.forEach((r) => { r._requestUrl = url; handleRecord(r); });
      console.log(`[ok] NPC全国 | ${records.length}物件`);
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

    // ---- repark 全国（ローリング巡回） ----
    if (t.operator === "repark" && t.mode === "nationwide") {
      let ids;
      try {
        ids = await getAllParkIds({ cacheFile: STATE.reparkSitemapCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] repark sitemap: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.reparkCrawlState);
      const perRun = config.reparkRollingPerRun ?? 1000;
      const batch = pickRolling(ids, state, perRun);
      const visited = ids.filter((id) => state[id]).length;
      console.log(
        `[repark全国] 全${ids.length}件 / 既訪${visited}件 / 今回${batch.length}件取得。` +
        `1巡目安: 約${Math.ceil(ids.length / perRun)}回実行`
      );
      for (const id of batch) {
        let res;
        try { res = await politeFetch(reparkDetailUrl(id)); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        const rec = parseReparkDetail(res.html, { parkId: id });
        rec._requestUrl = reparkDetailUrl(id);
        handleRecord(rec);
        state[id] = now;
      }
      saveCrawlState(STATE.reparkCrawlState, state);
      continue;
    }

    // ---- タイムズ 全国（ローリング巡回） ----
    // 先方が商用ボットを名指しブロックしている点に配慮し、間隔を長め(timesMinDelayMs)に。
    if (t.operator === "times" && t.mode === "nationwide") {
      let urls;
      try {
        urls = await getAllParkUrls({ cacheFile: STATE.timesUrlsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] times sitemap: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.timesCrawlState);
      const perRun = config.timesRollingPerRun ?? 2000;
      const delay = config.timesMinDelayMs ?? 6000;
      const batch = pickRolling(urls, state, perRun);
      const visited = urls.filter((u) => state[u]).length;
      console.log(
        `[タイムズ全国] 全${urls.length}件 / 既訪${visited}件 / 今回${batch.length}件取得(間隔${delay / 1000}秒)。` +
        `1巡目安: 約${Math.ceil(urls.length / perRun)}回実行`
      );
      for (const url of batch) {
        let res;
        try { res = await politeFetch(url, { minDelay: delay }); } catch (e) { console.error(`  [error] ${url}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${url}`); continue; }
        const rec = parseTimesDetail(res.html, { url });
        rec._requestUrl = url;
        handleRecord(rec);
        state[url] = now;
      }
      saveCrawlState(STATE.timesCrawlState, state);
      continue;
    }

    // ---- 名鉄協商 全国（ローリング巡回） ----
    if (t.operator === "mkp" && t.mode === "nationwide") {
      let ids;
      try {
        ids = await getAllMkpIds({ cacheFile: STATE.mkpIdsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] mkp sitemap: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.mkpCrawlState);
      const perRun = config.mkpRollingPerRun ?? 2500;
      const batch = pickRolling(ids, state, perRun);
      const visited = ids.filter((id) => state[id]).length;
      console.log(
        `[名鉄協商全国] 全${ids.length}件 / 既訪${visited}件 / 今回${batch.length}件取得。` +
        `1巡目安: 約${Math.ceil(ids.length / perRun)}回実行`
      );
      for (const id of batch) {
        let res;
        try { res = await politeFetch(mkpDetailUrl(id)); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        const rec = parseMkpDetail(res.html, { id });
        rec._requestUrl = mkpDetailUrl(id);
        handleRecord(rec);
        state[id] = now;
      }
      saveCrawlState(STATE.mkpCrawlState, state);
      continue;
    }

    // ---- ナビパーク 全国（ローリング巡回） ----
    if (t.operator === "navipark" && t.mode === "nationwide") {
      let codes;
      try {
        codes = await getAllNaviparkCodes({ cacheFile: STATE.naviparkCodesCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] navipark enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.naviparkCrawlState);
      const perRun = config.naviparkRollingPerRun ?? 2500;
      const batch = pickRolling(codes, state, perRun);
      const visited = codes.filter((c) => state[c]).length;
      console.log(
        `[ナビパーク全国] 全${codes.length}件 / 既訪${visited}件 / 今回${batch.length}件取得。` +
        `1巡目安: 約${Math.ceil(codes.length / perRun)}回実行`
      );
      for (const code of batch) {
        let res;
        try { res = await politeFetch(naviparkDetailUrl(code)); } catch (e) { console.error(`  [error] ${code}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${code}`); continue; }
        const rec = parseNaviparkDetail(res.html, { code });
        rec._requestUrl = naviparkDetailUrl(code);
        handleRecord(rec);
        state[code] = now;
      }
      saveCrawlState(STATE.naviparkCrawlState, state);
      continue;
    }

    // ---- エコロパーク 全国（ローリング巡回） ----
    if (t.operator === "ecolo" && t.mode === "nationwide") {
      let ids;
      try {
        ids = await getAllEcoloIds({ cacheFile: STATE.ecoloIdsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] ecolo enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.ecoloCrawlState);
      const perRun = config.ecoloRollingPerRun ?? 2500;
      const batch = pickRolling(ids, state, perRun);
      const visited = ids.filter((id) => state[id]).length;
      console.log(
        `[エコロ全国] 全${ids.length}件 / 既訪${visited}件 / 今回${batch.length}件取得。` +
        `1巡目安: 約${Math.ceil(ids.length / perRun)}回実行`
      );
      for (const id of batch) {
        let res;
        try { res = await politeFetch(ecoloDetailUrl(id)); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        const rec = parseEcoloDetail(res.html, { id });
        rec._requestUrl = ecoloDetailUrl(id);
        handleRecord(rec);
        state[id] = now;
      }
      saveCrawlState(STATE.ecoloCrawlState, state);
      continue;
    }

    // ---- キョウテク 全国（一覧→詳細ローリング） ----
    if (t.operator === "kyotech" && t.mode === "nationwide") {
      let ids;
      try {
        ids = await getAllKyotechIds({ cacheFile: STATE.kyotechIdsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] kyotech enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.kyotechCrawlState);
      const perRun = config.kyotechRollingPerRun ?? 800;
      const batch = pickRolling(ids, state, perRun);
      console.log(`[キョウテク] 全${ids.length}件 / 今回${batch.length}件取得`);
      for (const id of batch) {
        let res;
        try { res = await politeFetch(kyotechDetailUrl(id)); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        const rec = parseKyotechDetail(res.html, { id });
        rec._requestUrl = kyotechDetailUrl(id);
        handleRecord(rec);
        state[id] = now;
      }
      saveCrawlState(STATE.kyotechCrawlState, state);
      continue;
    }

    // ---- NTTル・パルク 全国（mapion一覧→詳細ローリング） ----
    if (t.operator === "leparc" && t.mode === "nationwide") {
      let ids;
      try {
        ids = await getAllLeparcIds({ cacheFile: STATE.leparcIdsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] leparc enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(STATE.leparcCrawlState);
      const perRun = config.leparcRollingPerRun ?? 500;
      const batch = pickRolling(ids, state, perRun);
      console.log(`[ル・パルク] 全${ids.length}件 / 今回${batch.length}件取得`);
      for (const id of batch) {
        let res;
        try { res = await politeFetch(leparcDetailUrl(id)); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        const rec = parseLeparcDetail(res.html, { id });
        rec._requestUrl = leparcDetailUrl(id);
        handleRecord(rec);
        state[id] = now;
      }
      saveCrawlState(STATE.leparcCrawlState, state);
      continue;
    }

    // ---- GSパーク 全国（エリア一覧に料金直載・毎回全エリア） ----
    if (t.operator === "gspark" && t.mode === "nationwide") {
      let codes = [];
      try {
        const fsMod = fs;
        if (fsMod.existsSync(STATE.gsparkAreasCache) && Date.now() - fsMod.statSync(STATE.gsparkAreasCache).mtimeMs < 7 * 864e5) {
          codes = fsMod.readFileSync(STATE.gsparkAreasCache, "utf8").split("\n").filter(Boolean);
        } else {
          const res0 = await politeFetch("https://www.gs-park.com/time_parking/");
          if (!res0.ok) throw new Error(`エリア一覧 HTTP ${res0.status}`);
          codes = parseAreaCodes(res0.html);
          if (!codes.length) throw new Error("エリアコード0件");
          fsMod.writeFileSync(STATE.gsparkAreasCache, codes.join("\n") + "\n");
        }
      } catch (e) { console.error(`[error] gspark enumerate: ${e.message}`); continue; }
      console.log(`[GSパーク] エリア${codes.length}件を巡回`);
      let count = 0;
      for (const code of codes) {
        for (let page = 1; page <= 30; page++) {
          let res;
          try { res = await politeFetch(areaListUrl(code, page)); } catch (e) { console.error(`  [error] ${code} p${page}: ${e.message}`); break; }
          if (!res.ok || res.skippedReason) break;
          const { records, hasNext } = parseGsparkList(res.html);
          for (const rec of records) { rec._requestUrl = areaListUrl(code, page); handleRecord(rec); count++; }
          if (!hasNext) break;
        }
      }
      console.log(`[ok] GSパーク | ${count}物件`);
      continue;
    }

    // ---- 2026-08 追加分: 列挙→ローリング詳細取得（6社共通） ----
    const rolling = ROLLING_SITES.find((x) => x.op === t.operator);
    if (rolling && t.mode === "nationwide") {
      let ids;
      try {
        ids = await rolling.enumerate({ cacheFile: rolling.idsCache, cacheMs: 7 * 864e5 });
      } catch (e) { console.error(`[error] ${rolling.op} enumerate: ${e.message}`); continue; }
      const state = loadCrawlState(rolling.stateFile);
      const perRun = config[`${rolling.op}RollingPerRun`] ?? rolling.defaultPerRun;
      const batch = pickRolling(ids, state, perRun);
      console.log(`[${rolling.label}] 全${ids.length}件 / 今回${batch.length}件取得`);
      for (const id of batch) {
        const url = rolling.detailUrl(id);
        let res;
        try { res = await politeFetch(url); } catch (e) { console.error(`  [error] ${id}: ${e.message}`); continue; }
        if (!res.ok || res.skippedReason) { console.error(`  [error] ${id}`); continue; }
        let rec;
        try { rec = rolling.parse(res.html, { id }); } catch (e) { console.error(`  [parse error] ${id}: ${e.message}`); continue; }
        if (!rec || !rec.name) continue;
        rec._requestUrl = url;
        handleRecord(rec);
        state[id] = now;
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
    `\n完了: ${stats.processed}物件処理 / 新規${stats.isNew} / 変動${stats.changed} / 追記${stats.written}行 → ${process.env.OUT_FILE || config.outFile}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
