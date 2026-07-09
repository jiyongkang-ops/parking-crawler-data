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
};

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
