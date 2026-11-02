// 東洋カーマックス: 一覧のページを最後までたどって管理番号を列挙する（2026-11-02）---------------------------------
// 「駐車場を探す」（/25search/）にエリア（関東 a3・中部 a4・近畿 a5・四国 a7）のリンクがあり、エリアの1ページ目は
// /search/aN/pf0/s0/p1/、2ページ目からはページ送りのリンク /search/aN/pf0/sa2/pM/（1ページ20件）。
// 各ページの「検索ヒット数：N件」からエリアのページ数を出す。1巡は約60ページ（4秒おきで約4分）で、作り直しは7日に1回。
// 名前に「駐輪」「バイク」などがある区画（約40件）は、詳細を取らずにここで外す。
// 絞り込み・表示件数の変更は CSRF つきの POST なので使わない。地図用の /php/getmarkers.php は中心からの距離で件数が
// 切れる（3回で1,160件・一覧は1,170件。2026-11-01）ので、一覧のページを正とする。
// 取れなかったページがある・ヒット数より明らかに少ないときは、欠けた一覧で上書きせず前の一覧を使う（listNote で知らせる）。
import fs from "node:fs";
import path from "node:path";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";
import { BIKE, fullKana } from "./carmax.js";
import { decodeEntities } from "./zenkaku.js";

const BASE = "http://www.carmax-parking.jp";
export const SEARCH_URL = `${BASE}/25search/`;
export const PER_PAGE = 20;
const MAX_PAGES = 80;   // 1エリアの暴走よけ（近畿で30ページ）

export const areaPageUrl = (area, page) => (page <= 1 ? `${BASE}/search/${area}/pf0/s0/p1/` : `${BASE}/search/${area}/pf0/sa2/p${page}/`);

/** 「駐車場を探す」のページ → エリアの記号（a3 など）。リンクの並び（四国・近畿・中部・関東）のまま、重なりを除く */
export function parseAreas(html) {
  return [...new Set([...String(html).matchAll(/href="(?:https?:\/\/www\.carmax-parking\.jp)?\/search\/(a\d+)\/pf0\/s0\/p1\/?"/g)].map((m) => m[1]))];
}

/** 一覧の1ページ → { hits（検索ヒット数。読めなければ null）, rows: [{ id, name }], maxPage（ページ送りのリンクの最大） } */
export function parseListPage(html) {
  const s = String(html);
  const hit = s.match(/検索ヒット数[：:]\s*([\d,]+)\s*件/);
  const rows = [];
  for (const m of s.matchAll(/<tr><td title="駐車場名">([\s\S]*?)<\/td>(?:(?!<\/tr>)[\s\S])*?href="\/detail\/([0-9A-Za-z]+)\/?"/g)) {
    rows.push({ id: m[2], name: fullKana(decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()) });
  }
  const pages = [...s.matchAll(/\/search\/a\d+\/pf0\/sa2\/p(\d+)\/?"/g)].map((m) => Number(m[1]));
  return { hits: hit ? Number(hit[1].replace(/,/g, "")) : null, rows, maxPage: pages.length ? Math.max(...pages) : 1 };
}

/** 一覧を最後までたどる。戻り値 { rows（重なりを除いた全区画）, hits（ヒット数の合計）, missing（取れなかったページの説明） } */
export async function walkCarmaxList({ fetcher = (u) => politeFetch(u) } = {}) {
  const top = await fetcher(SEARCH_URL);
  throwIfRobotsSkipped(top, "東洋カーマックス一覧");   // 「0件（ページ構造変更の可能性）」と取り違えない
  if (!top.ok) throw new Error(`東洋カーマックス一覧（駐車場を探す）: ${failText(top)}`);
  const areas = parseAreas(top.html);
  if (!areas.length) throw new Error("東洋カーマックス一覧のエリアが0件（ページ構造変更の可能性）");
  const byId = new Map();
  const missing = [];
  let hits = 0;
  for (const area of areas) {
    let last = 1;
    for (let page = 1; page <= Math.min(last, MAX_PAGES); page++) {
      const url = areaPageUrl(area, page);
      let res;
      try { res = await fetcher(url); } catch (e) { missing.push(`${area} ${page}ページ目（${e?.message ?? e}）`); break; }
      throwIfRobotsSkipped(res, "東洋カーマックス一覧");
      if (!res.ok) { missing.push(`${area} ${page}ページ目（${failText(res)}）`); break; }
      const p = parseListPage(res.html);
      if (page === 1) {
        if (p.hits != null) { hits += p.hits; last = Math.max(1, Math.ceil(p.hits / PER_PAGE)); }
        else last = p.maxPage;   // ヒット数が読めないときはページ送りのリンクで
      }
      const before = byId.size;
      for (const r of p.rows) if (!byId.has(r.id)) byId.set(r.id, r);
      if (!p.rows.length || byId.size === before) {
        if (page < last) missing.push(`${area} ${page}ページ目が空`);
        break;
      }
    }
  }
  return { rows: [...byId.values()], hits, missing };
}

/** 一覧（管理番号）。駐輪場・バイクの区画は外す。7日に1回作り直す */
export async function getAllCarmaxIds({ cacheFile, cacheMs = 7 * 864e5, fetcher } = {}) {
  const abs = cacheFile ? path.resolve(cacheFile) : null;
  const prev = abs && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split("\n").filter(Boolean) : [];
  if (prev.length && cacheFresh(abs, cacheMs)) return prev;
  const { rows, hits, missing } = await walkCarmaxList({ fetcher });
  const bikes = rows.filter((r) => BIKE.test(r.name));
  const ids = rows.filter((r) => !BIKE.test(r.name)).map((r) => r.id).sort();
  // ヒット数より2件（1%）を超えて少ない＝途中のページが欠けた。ページ送りの途中で物件が増減すると1〜2件ずれることはある
  const short = hits - rows.length;
  const broken = missing.length > 0 || short > Math.max(2, hits * 0.01);
  const why = [missing.length ? `取れなかったページ: ${missing.join("・")}` : null,
    short > 0 ? `ヒット数${hits}件に対して${rows.length}件` : null].filter(Boolean).join("。");
  if (broken && prev.length) {
    console.warn(`::warning::[東洋カーマックス] 一覧が欠けた（${why}）。前の一覧（${prev.length}件）を使い、次の回に作り直す`);
    const old = [...prev];
    old.listNote = `一覧を作り直せず、前の一覧（${prev.length}件）を使っている: ${why}`;
    return old;
  }
  const kept = abs ? keepPrevIfShrunk("東洋カーマックス", ids, prev) : null;
  if (kept) return kept;
  if (!ids.length) throw new Error("東洋カーマックス一覧の解析結果が0件（ページ構造変更の可能性）");
  console.log(`[東洋カーマックス] 一覧 ${rows.length}件（ヒット数${hits}件）のうち、駐輪場・バイク${bikes.length}件を外して${ids.length}件`);
  if (abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, ids.join("\n") + "\n");
    // 欠けた一覧（前の一覧が無い初回だけ使う）は取得日を進めない。次の回にまた作り直す
    if (!broken) markFetched(abs);
  }
  if (broken) ids.listNote = `一覧が欠けているかもしれない（${why}）。次の回に作り直す`;
  ids.listInfo = { hits, rows: rows.length, bikes: bikes.length };
  return ids;
}
