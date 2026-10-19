// 三井のリパークの物件番号を、公式サイトの地図検索のマーカーから集める -------------------------------
// sitemap_park.xml は lastmod が 2025-06-18 で止まっていて、毎週取り直しても中身が変わらない。それより後に開いた物件は
// 一覧に入らず、Advisor の相場に1件も入っていなかった（2026-10-18 の点検。都心の200件のうち36件、東北北部の131件のうち
// 12件が sitemap に無かった）。
//
// 公式サイトの地図検索（/parking_user/time/map.html）は、地図の範囲（北・西・南・東）と中心を渡すと、範囲の中の物件を
// 中心に近い順に最大200件、JSON で返す（/ajax/time_markers.json。物件番号・名前・座標・満空・料金が入っている）。
// robots.txt はこの道を断っていない（2026-10-18 に確認。断っているのは /receipt/・/news/・/payment/… など）。
// 範囲の中が200件より少なければ、範囲の中は全部返る（東北北部の 2.6度×2.7度で、中心から131km先まで、手元で座標の
// 分かっている108件が1件も欠けずに返った）。物件の無い範囲は [] が返る。
//
// そこで全国を「分かっている物件が TILE_LIMIT 件以下になる長方形」に分け、1つずつ聞く（約100回・週1回）。
// 200件ちょうど返った長方形はまだ残りがあるので、2つに割って聞き直す。物件番号の総当たりはしない。
// 長方形は全国（JAPAN）をすき間なく分けるので、まだ知らない場所に新しく開いた物件も、どれかの長方形に入る。

import fs from "node:fs";
import path from "node:path";
import { politeFetch, throwIfRobotsSkipped } from "./polite-fetch.js";
import { writeFileAtomic } from "./write-atomic.js";

export const MARKERS_URL = "https://www.repark.jp/ajax/time_markers.json";
/** 1回に返る件数の上限（2026-10-18 に東京23区の範囲で確かめた） */
export const MAP_CAP = 200;
/** 聞く範囲の全体（日本全体。リパークの物件は北緯26〜44度・東経127〜143度） */
export const JAPAN = Object.freeze({ s: 20, n: 46, w: 122, e: 154 });
/** 1つの長方形に入れる、分かっている物件の数の目安。上限200件より少なくしておき、新しい物件が増えても200件に届かないようにする
 *  （都心では sitemap に無い物件が18%あったので、初回は vacancy-lots の座標で分けても 150×1.18≒177件で収まる） */
export const TILE_LIMIT = 150;
/** これより小さい長方形（度。約50m）は、200件返っても割らない（同じ座標に物件が固まっているなど） */
const MIN_SPAN = 0.0005;
/** 地図の一覧を作り直す間隔 */
export const MAP_REFRESH_MS = 7 * 864e5;
/** 作り直しに失敗したとき、次に試すまでの間隔（毎時試して相手先に失敗のリクエストを送り続けないように） */
export const MAP_RETRY_MS = 864e5;
/** 地図に出なくなった物件を一覧に残す日数。残しているあいだに詳細ページの 404 で閉鎖（GONE）の印が付く。
 *  すぐ外すと、閉じた物件が閉鎖の印の無いまま相場に残る（巡回されないため） */
export const MAP_KEEP_UNSEEN_DAYS = 180;

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** 長方形の中の点を、長い方の辺で2つに割る。左（下）の点の数は limit の倍数にする（長方形の数がなるべく少なくなるように）。
 *  割る線は隣り合う2つの点のちょうど間に置く（点が線の上に乗ると、相手先の範囲の決め方しだいで両方から漏れるため） */
function splitByPoints(box, pts, limit) {
  const midLat = (box.s + box.n) / 2;
  const latKm = (box.n - box.s) * 111;
  const lngKm = (box.e - box.w) * 111 * Math.cos((midLat * Math.PI) / 180);
  const ax = latKm >= lngKm ? 0 : 1;
  pts.sort((p, q) => p[ax] - q[ax]);
  const k = Math.ceil(pts.length / limit);
  const cut = Math.max(1, Math.min(pts.length - 1, Math.floor(k / 2) * limit));
  const v = (pts[cut - 1][ax] + pts[cut][ax]) / 2;
  const [lo, hi] = ax === 0 ? [{ ...box, n: v }, { ...box, s: v }] : [{ ...box, e: v }, { ...box, w: v }];
  return [[lo, pts.slice(0, cut)], [hi, pts.slice(cut)]];
}

/** 全体（box）を、点（[緯度, 経度]）が limit 件以下になる長方形に分ける。長方形どうしは辺を共有し、すき間なく全体を覆う */
export function planTiles(points, limit = TILE_LIMIT, box = JAPAN) {
  const inBox = points.filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln)
    && la >= box.s && la <= box.n && ln >= box.w && ln <= box.e);
  const out = [];
  const stack = [[{ ...box }, inBox]];
  while (stack.length) {
    const [b, pts] = stack.pop();
    if (pts.length <= limit) { out.push(b); continue; }
    stack.push(...splitByPoints(b, pts, limit));
  }
  return out;
}

/** 200件返った長方形を2つに割る。中の点（分かっている物件＋返ってきた物件）がそろっていればその真ん中で、
 *  無ければ長い方の辺の真ん中で割る */
export function splitTile(box, points) {
  const pts = points.filter(([la, ln]) => la >= box.s && la <= box.n && ln >= box.w && ln <= box.e);
  const distinct = new Set(pts.map((p) => `${p[0]},${p[1]}`)).size;
  if (distinct >= 2) {
    const [[a], [b]] = splitByPoints(box, pts, Math.ceil(pts.length / 2));
    return [a, b];
  }
  const midLat = (box.s + box.n) / 2;
  const latKm = (box.n - box.s) * 111, lngKm = (box.e - box.w) * 111 * Math.cos((midLat * Math.PI) / 180);
  if (latKm >= lngKm) return [{ ...box, n: midLat }, { ...box, s: midLat }];
  const midLng = (box.w + box.e) / 2;
  return [{ ...box, e: midLng }, { ...box, w: midLng }];
}

/** 長方形1つぶんの URL。公式の地図と同じ形（range=C中心N北W西S南E東）。境目の物件が漏れないよう、外側へ少し（約0.1m）広げて丸める */
export function markersUrl(box) {
  const n = round6(box.n + 1e-6), s = round6(box.s - 1e-6), w = round6(box.w - 1e-6), e = round6(box.e + 1e-6);
  const c = `${round6((box.s + box.n) / 2)},${round6((box.w + box.e) / 2)}`;
  return `${MARKERS_URL}?range=C${c}N${n}W${w}S${s}E${e}`;
}

/** 座標の文字列 → 数。空・0・数でないものは null（Number("") は 0 になり、赤道の上の物件として長方形を誤らせるため） */
const coord = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const x = Number(v);
  return Number.isFinite(x) && x !== 0 ? x : null;
};

/** マーカーの JSON を読む。戻り値は { parks: [{ id, lat, lng }], raw: 返ってきた件数 }。
 *  削除の印（delete_flg が 0 以外）の物件は入れない。形が違う（配列でない・物件番号が1件も無い）ときは例外 */
export function parseMarkers(text) {
  const t = String(text ?? "").trim();
  if (t === "" || t === "null") return { parks: [], raw: 0 };
  let j;
  try { j = JSON.parse(t); } catch { throw new Error("地図のマーカーが JSON ではない（ページの作りの変更の可能性）"); }
  if (!Array.isArray(j)) throw new Error("地図のマーカーが配列ではない（ページの作りの変更の可能性）");
  const parks = [];
  let withCode = 0;
  for (const x of j) {
    const id = String(x?.park_code ?? "");
    if (!/^REP\d{7}$/.test(id)) continue;
    withCode++;
    if (String(x.delete_flg ?? "0") !== "0") continue;
    parks.push({ id, lat: coord(x.latitude), lng: coord(x.longitude) });
  }
  if (j.length && !withCode) throw new Error("地図のマーカーに物件番号（park_code）が無い（ページの作りの変更の可能性）");
  return { parks, raw: j.length };
}

/** 全国の長方形を順に聞いて物件番号を集める。
 *  points … 長方形を決めるための、分かっている物件の座標（[緯度, 経度]）。無ければ全国を1つから割っていく。
 *  maxRequests … この回に送ってよい数。超えたら止めて incomplete にする。
 *  1つでも取れなかったら（robots.txt で断られた・届かない・HTTP の失敗・形の変更）、そこで止める（相手先が苦しいときに叩き続けない）。
 *  戻り値: { parks: Map(番号 → [緯度, 経度]), requests, complete, error, dense（割れないのに200件返った長方形の数）, maxRaw } */
export async function crawlMarkers({ points = [], fetcher = politeFetch, limit = TILE_LIMIT, maxRequests = 250 } = {}) {
  const queue = planTiles(points, limit);
  const parks = new Map();
  const known = points.filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln));
  let requests = 0, dense = 0, maxRaw = 0, error = null;
  while (queue.length) {
    if (requests >= maxRequests) { error = `送ってよい数（${maxRequests}回）に達したので、残り${queue.length}か所を聞かずに止めた`; break; }
    const box = queue.shift();
    const url = markersUrl(box);
    let res;
    try {
      requests++;
      res = await fetcher(url);
      throwIfRobotsSkipped(res, "地図のマーカー");
      if (res.skippedReason) throw new Error(`地図のマーカー: ${res.skippedReason}`);
      if (!res.ok) throw new Error(`地図のマーカー HTTP ${res.status}`);
      const { parks: got, raw } = parseMarkers(res.html);
      maxRaw = Math.max(maxRaw, raw);
      for (const p of got) if (!parks.has(p.id)) parks.set(p.id, [p.lat, p.lng]);
      if (raw >= MAP_CAP) {
        // 上限で打ち切られている（中心に近い200件だけ）。2つに割って聞き直す
        if (box.n - box.s < MIN_SPAN && box.e - box.w < MIN_SPAN) { dense++; continue; }
        const pts = known.concat(got.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lat, p.lng]));
        queue.unshift(...splitTile(box, pts));
      }
    } catch (e) {
      error = `${e.message}（${requests}回目で止めた）`;
      break;
    }
  }
  return { parks, requests, complete: !error && dense === 0, error, dense, maxRaw };
}

// ---- 地図の一覧ファイル ----
// 1行目は見出し（# で始まる。最後に全国を聞き終えた時刻・最後に試した時刻・そのときの件数）。
// 2行目からは「物件番号<TAB>緯度<TAB>経度<TAB>最後に地図で見た日（日本時間）」。番号の順。
// 地図に出なくなった物件も MAP_KEEP_UNSEEN_DAYS 日は残す（巡回で 404 を確かめて閉鎖の印を付けるため）。

/** 一覧ファイルを読む。無ければ空。戻り値: { entries: Map(番号 → { lat, lng, seen }), complete, tried, parks } */
export function readMapList(file) {
  const out = { entries: new Map(), complete: null, tried: null, parks: 0, lastRequests: 0 };
  let text;
  try { text = fs.readFileSync(path.resolve(file), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("#")) {
      const kv = Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
      if (kv.complete && kv.complete !== "-") out.complete = Date.parse(kv.complete) || null;
      if (kv.tried && kv.tried !== "-") out.tried = Date.parse(kv.tried) || null;
      out.parks = Number(kv.parks) || 0;
      out.lastRequests = Number(kv.requests) || 0;
      continue;
    }
    const [id, la, ln, seen] = line.split("\t");
    if (!/^REP\d{7}$/.test(id ?? "")) continue;
    const lat = la === "" || la == null ? null : Number(la), lng = ln === "" || ln == null ? null : Number(ln);
    out.entries.set(id, { lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, seen: seen || null });
  }
  return out;
}

/** 一覧ファイルを書く（一時ファイルから置き換える） */
export function writeMapList(file, { entries, complete = null, tried = null, parks = 0, requests = 0 }) {
  const iso = (t) => (t ? new Date(t).toISOString() : "-");
  const head = `# repark-map complete=${iso(complete)} tried=${iso(tried)} parks=${parks} requests=${requests}`;
  const lines = [...entries.keys()].sort().map((id) => {
    const x = entries.get(id);
    return `${id}\t${x.lat ?? ""}\t${x.lng ?? ""}\t${x.seen ?? ""}`;
  });
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileAtomic(path.resolve(file), [head, ...lines].join("\n") + "\n");
}

/** 満空の控え（vacancy-lots.jsonl）から、リパークの物件の座標を読む。地図の一覧がまだ無い初回に、長方形を決めるのに使う */
export function readVacancyCoords(file) {
  const pts = [];
  let text;
  try { text = fs.readFileSync(path.resolve(file), "utf8"); } catch { return pts; }
  const seen = new Set();
  const lines = text.split("\n");
  // 同じ物件が何行もあれば最後の行が新しいので、後ろから読む
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"repark:')) continue;
    try {
      const j = JSON.parse(line);
      if (seen.has(j.k)) continue;
      seen.add(j.k);
      const la = Number(j.la), ln = Number(j.ln);
      if (Number.isFinite(la) && Number.isFinite(ln) && la && ln) pts.push([la, ln]);
    } catch { /* 壊れた行は飛ばす */ }
  }
  return pts;
}

/** 日本時間の日付（YYYY-MM-DD） */
const jstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

/** 一覧ファイルの中身（readMapList）のうち、巡回の一覧に入れる番号。地図に出なくなって MAP_KEEP_UNSEEN_DAYS 日を過ぎたものは除く */
export function mapIdsOf(list, nowMs = Date.now()) {
  const keepAfter = jstDate(nowMs - MAP_KEEP_UNSEEN_DAYS * 864e5);
  return [...list.entries].filter(([, x]) => !x.seen || x.seen >= keepAfter).map(([id]) => id).sort();
}

/** 地図の一覧を返す。作り直す時期（前に全国を聞き終えてから MAP_REFRESH_MS。失敗したあとは MAP_RETRY_MS あける）なら作り直す。
 *  file … 一覧ファイル。coordsFile … 初回に長方形を決める座標（vacancy-lots.jsonl）。maxRequests が 0 なら地図は使わない。
 *  戻り値: { ids: 一覧の番号（地図に出なくなって MAP_KEEP_UNSEEN_DAYS 日を過ぎたものは除く）, completeAt, refreshed, error, disabled, requests, found } */
export async function getMapParkIds({ file, coordsFile, fetcher = politeFetch, nowMs = Date.now(),
  maxRequests = Number(process.env.REPARK_MAP_MAX_REQUESTS ?? 250) } = {}) {
  const cur = readMapList(file);
  const keepAfter = jstDate(nowMs - MAP_KEEP_UNSEEN_DAYS * 864e5);
  const listed = () => mapIdsOf(cur, nowMs);
  const base = { completeAt: cur.complete, refreshed: false, error: null, disabled: false, requests: 0, found: 0 };
  if (!(maxRequests > 0)) return { ...base, ids: listed(), disabled: true };
  // 作り直す時期か。前の試しが1回目で失敗した（道が無い・断られた・届かない）ときは1日あけて試す。
  // 途中まで聞けて止まったとき（取れた分は一覧に入れてある）は、ふだんどおり7日あける。
  // 毎回試し直すと、ある場所だけいつも失敗するときに、毎時その手前までの数十回を送り続けることになるため
  const sinceTried = cur.tried ? nowMs - cur.tried : Infinity;
  const retryMs = cur.lastRequests <= 1 ? MAP_RETRY_MS : MAP_REFRESH_MS;
  const due = !(cur.complete && nowMs - cur.complete < MAP_REFRESH_MS) && !(sinceTried < retryMs);
  if (!due) return { ...base, ids: listed() };

  // 長方形は、地図の一覧の座標（無ければ満空の控えの座標）で決める
  let points = [...cur.entries.values()].filter((x) => x.lat != null && x.lng != null).map((x) => [x.lat, x.lng]);
  if (points.length < 1000 && coordsFile) points = points.concat(readVacancyCoords(coordsFile));
  console.log(`[リパーク] 地図のマーカーから一覧を作り直す（座標${points.length}件で${planTiles(points).length}か所に分ける・最大${maxRequests}回）`);
  const r = await crawlMarkers({ points, fetcher, maxRequests });
  const today = jstDate(nowMs);
  let error = r.error ?? (r.dense ? `200件より多く固まっていて割れない場所が${r.dense}か所あった` : null);
  // 全国を聞き終えたのに前回の半分も取れなかったら、相手先の作りが変わったとみなして使わない（前の一覧を使い続ける）
  const shrunk = r.complete && cur.parks > 0 && r.parks.size < cur.parks * 0.5;
  if (shrunk) error = `地図の一覧が${r.parks.size}件しか取れなかった（前回${cur.parks}件）`;
  const complete = r.complete && !shrunk;
  // 途中で止まった回も、取れた物件は地図に出ている本物なので一覧に入れる
  if (!shrunk) for (const [id, [lat, lng]] of r.parks) cur.entries.set(id, { lat, lng, seen: today });
  // 地図に出なくなって長くたったものは外す（聞き終えた回だけ。途中で止まった回は、聞けなかった場所の物件を外さない）
  if (complete) for (const [id, x] of cur.entries) if (x.seen && x.seen < keepAfter) cur.entries.delete(id);
  const completeAt = complete ? nowMs : cur.complete;
  writeMapList(file, { entries: cur.entries, complete: completeAt, tried: nowMs,
    parks: complete ? r.parks.size : cur.parks, requests: r.requests });
  if (error) {
    const next = r.requests <= 1 ? `${MAP_RETRY_MS / 3600e3}時間` : `${MAP_REFRESH_MS / 864e5}日`;
    console.warn(`::warning::[リパーク] 地図の一覧を作り直せなかった: ${error}。前の一覧と、この回に取れた${shrunk ? 0 : r.parks.size}件を使い、${next}あとにまた試す`);
  } else console.log(`[リパーク] 地図の一覧 ${r.parks.size}件（${r.requests}回・1回の最大${r.maxRaw}件）`);
  return { ...base, ids: listed(), completeAt, refreshed: true, error, requests: r.requests, found: r.parks.size };
}
