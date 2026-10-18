// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。

import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
export async function getAllParkIds({ cacheFile, cacheMs }) {
  let xml = null;
  const abs = path.resolve(cacheFile);
  if (cacheFresh(abs, cacheMs)) {
    xml = fs.readFileSync(abs, "utf8");
  } else {
    const res = await politeFetch(SITEMAP_URL);
    if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
    if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
    xml = res.html;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, xml);
    markFetched(abs);
  }
  // www 版の detail URL から park= の値だけを重複なく拾う
  const ids = new Set();
  const re = /result\/detail\/\?park=(REP\d+)/g;
  let m;
  while ((m = re.exec(xml))) ids.add(m[1]);
  return [...ids];
}

// ローリング状態（parkId -> 最終取得ISO、または "ISO|時間帯マスク36進"）を読み書き。
// 時間帯マスクは「その物件を日本時間の何時に見たことがあるか」の24ビット。
// GitHub Actions の定時実行は混雑時に平気で2〜3時間ずれる（実測: 1時間おき指定でも
// 16:55→19:28→22:17）。実行時刻に頼って時間帯をそろえる作りだと、この遅れが
// そのまま偏りになる。そこで「今の時刻をまだ見ていない物件」を先に選ぶ。
// こうすると実行がいつ走ろうと、24時間ぶんの穴が順に埋まっていく。
export function loadCrawlState(stateFile) {
  const abs = path.resolve(stateFile);
  if (!fs.existsSync(abs)) return {};
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return {};
  }
}

export function saveCrawlState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(state, null, 0));
  // ここで markFetched は呼ばない。取得日の記録は「物件一覧」のためのもので、
  // 巡回状態は毎回書き換わる別物（付けると不要な .fetched が毎回生まれる）
}

const ALL_HOURS = (1 << 24) - 1;
/** 消えた物件（404）を寝かせる期間。
 *  もとは「一覧を7日ごとに作り直すから7日」としていたが、実際に作り直してみると
 *  リパークの一覧は2か月変わっておらず、404の975件がそのまま載っていた。
 *  7日ごとに975件の404を投げ直すだけになるので、時間では長めに置き、
 *  **一覧の中身が変わったときに起こす**（unparkGone）のを主な復帰の合図にする。 */
const GONE_MS = 30 * 864e5;
/** 日本時間の「時」。stampState と pickRolling で同じ位置のビットを使うために1か所に置く */
const jstHour = (ms) => new Date(ms + 9 * 3600e3).getUTCHours();
/** 24時間ぜんぶ見終わったマスクは「まだ何も見ていない」と同じ扱い（次の一巡に入る） */
const effectiveMask = (mask) => (mask === ALL_HOURS ? 0 : mask);

/** 状態の値を分解する。古い形式（ISO文字列だけ）もそのまま読める */
export function parseState(v) {
  if (!v) return { t: 0, mask: 0, gone: false };
  const s = String(v);
  if (s.startsWith("GONE|")) return { t: new Date(s.slice(5)).getTime() || 0, mask: 0, gone: true };
  const [iso, m] = s.split("|");
  return { t: new Date(iso).getTime() || 0, mask: m ? parseInt(m, 36) : 0, gone: false };
}

/** 巡回したときに書き戻す値。
 *  seen=false（取れなかった）でも時刻だけは進める。**これをしないと失敗した物件が
 *  「最後に取れた時刻」のまま古い順の先頭に居座り、毎回そこだけを叩いて
 *  生きている物件へ一生たどり着かない**（1回あたりの件数を4500→629に減らしたとき、
 *  629件ぜんぶが404の物件になり巡回が止まった。2026-09-12）。
 *  24時間ぜんぶ見終わったマスクは畳んで次の一巡に入る。 */
export function stampState(prev, atIso, seen = true) {
  const { mask } = parseState(prev);
  if (!seen) return `${atIso}|${mask.toString(36)}`;
  const next = effectiveMask(mask) | (1 << jstHour(new Date(atIso).getTime()));
  return `${atIso}|${next.toString(36)}`;
}

/** 404（消えた物件）。一覧を作り直すまでは回さない。
 *  先方に無駄な404を投げ続けないための処置でもある（リパークで約970件あった） */
export const goneState = (atIso) => `GONE|${atIso}`;

/** 取得の結果を状態へ書き戻す。404・410 は寝かせ、それ以外の失敗は時刻だけ進める
 *  （相手先の不調で取れなかったときは、先に isTransient で分けて recordTransient を使う） */
export function recordVisit(state, key, atIso, res, { hours = false, seen } = {}) {
  if (res && (res.status === 404 || res.status === 410)) { state[key] = goneState(atIso); return; }
  const ok = !!(res && res.ok && !res.skippedReason);
  // seen を渡されたら「その時刻を見た」の判定はそちら（満空が読めたかどうか）に従う
  state[key] = hours ? stampState(state[key], atIso, seen ?? ok) : atIso;
}

/** 相手先の不調で取れなかったか（物件が消えたとは言えない失敗）。
 *  通信の失敗・タイムアウト（res が無い）、5xx、429（多すぎる）、403（断られた）、robots.txt に届かず見送った分（res.transient）。
 *  404・410（閉鎖）、ほかの 4xx、robots.txt の Disallow で見送った分は含めない（従来どおり recordVisit） */
export const isTransient = (res) => !res || !!res.transient
  || (!res.skippedReason && (res.status >= 500 || res.status === 429 || res.status === 403));

/** 状態の値の末尾の「1回見送った」印 */
const RETRY_MARK = "|r";
/** 相手先の不調で取れなかった物件を状態へ書き戻す。戻り値は「次の回に取り直すか」。
 *  1回目は時刻を進めず印だけ付ける（古い順の先頭に残り、次の回に取り直す）。
 *  以前は失敗でも時刻を進めていたので、タイムズで 2026-10-02 21:08〜21:40（日本時間）に先方が 502・503・
 *  タイムアウトを返したとき、取れなかった124件がデータの無いまま1巡（当時約16日）後ろへ回った。
 *  2回続けて取れなかったら従来どおり時刻を進める。いつまでも進めないと、壊れたページが先頭に居座って
 *  巡回が止まる（2026-09-12 に404の物件で起きたこと）。閉鎖（GONE）の印はそのまま寝かせ直す。 */
export function recordTransient(state, key, atIso, { hours = false } = {}) {
  const s = state[key] == null ? "" : String(state[key]);
  if (s.startsWith("GONE|")) { state[key] = goneState(atIso); return false; }
  if (s.endsWith(RETRY_MARK)) {
    const base = s.slice(0, -RETRY_MARK.length);
    state[key] = hours ? stampState(base, atIso, false) : atIso;
    return false;
  }
  // 「ISO|時間帯マスク|r」。ISO は今までの値のまま（一度も取っていない物件は 1970年＝いちばん古い）。
  // 読む側（parseState・studio-index.mjs）は「|」の3つ目を見ないので、そのまま読める。取れたら stampState で消える
  const { t, mask } = parseState(s);
  state[key] = `${new Date(t).toISOString()}|${mask.toString(36)}${RETRY_MARK}`;
  return true;
}

/** 相手先の不調が続いたら、その回の巡回を打ち切る仕掛け。
 *  不調の失敗が limit 件続いたら true を返す。取れた・404 など相手先が答えた回で数え直す。
 *  run.js は取り直しの2回目の失敗を数えない（壊れたページが先頭に並んだだけで止めないため）。
 *  2026-10-02 のタイムズは不調のあいだも6秒おきに249件を取りに行き、124件が失敗していた。
 *  先方が苦しいときに叩き続けないためと、取れない物件を無駄に回さないため。 */
export function makeBreaker(limit = 8) {
  let streak = 0;
  return { fail: () => ++streak >= limit, ok: () => { streak = 0; }, get streak() { return streak; } };
}

/** 一覧から消えた物件のうち、今の一覧を作ってから一度も確かめていないもの（古い順に max 件）。
 *  詳細ページを1回だけ取りに行き、閉鎖なら 404 で GONE が付いて Advisor の相場から外れる（studio-index.mjs）。
 *  それまでは一覧から消えると二度と取りに行かず、閉鎖の印も付かないまま相場に残っていた
 *  （タイムズで64件。2026-10-18 に4件を確かめたら3件が404・1件はまだ載っていた）。
 *  先方は一覧（sitemap）から一時的に外すこともある（タイムズは5回の作り直しで34件が出戻り）ので、
 *  一覧から消えただけでは閉鎖にしない。確かめると時刻が一覧の作成より新しくなるので、次に一覧を
 *  作り直すまでは再び取りに行かない。listAtMs … 今の一覧を作った時刻（分からなければ何も選ばない）。
 *  keyOf … 一覧の1件 → 物件の番号（タイムズは URL → BUK）。URL だけ変わって同じ番号が一覧に残っている物件は
 *  消えていないので選ばない（古い URL に GONE を付けると、番号でまとめる studio-index.mjs が生きている物件を外すため） */
export function pickDropped(allIds, state, listAtMs, max = 100, keyOf = null) {
  if (!Number.isFinite(listAtMs)) return [];
  const inList = new Set(allIds);
  const inListKey = keyOf ? new Set(allIds.map(keyOf)) : null;
  const out = [];
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("_") || inList.has(k) || inListKey?.has(keyOf(k))) continue;
    const x = parseState(v);
    if (x.gone || x.t >= listAtMs) continue;
    out.push([k, x.t]);
  }
  return out.sort((a, b) => a[1] - b[1]).slice(0, max).map((x) => x[0]);
}

/** 一覧の中身の指紋。作り直して中身が変わったかを見るのに使う */
export function listHash(ids) {
  let h = 0;
  for (const id of ids) { for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0; h = (h + 0x9e3779b9) | 0; }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** 一覧が変わったら、寝かせていた物件を起こす。
 *  先方が物件を出し入れしたということなので、404だったものが復活している見込みがある。
 *  逆に一覧が変わらないうちは、何度叩いても404のままなので起こさない。 */
export function unparkGone(state, ids) {
  const h = listHash(ids);
  if (state._list === h) return 0;
  // 記録が無い初回は、一覧が変わったかどうか分からない。起こさずに指紋だけ控える。
  // ここで起こすと、変わっていない一覧に対して寝かせた全件（リパークで975件）を
  // 叩き直すことになる
  if (state._list === undefined) { state._list = h; return 0; }
  let n = 0;
  for (const id of ids) if (String(state[id] ?? "").startsWith("GONE|")) { delete state[id]; n++; }
  state._list = h;
  return n;
}

/** 生きている（寝かせていない）物件の数。1周の回数を決めるのに使う */
export function countLive(allIds, state, nowMs = Date.now()) {
  return allIds.filter((id) => { const x = parseState(state[id]); return !(x.gone && nowMs - x.t < GONE_MS); }).length;
}

/** 優先物件の番号を、巡回の一覧の書き方に読み替える。
 *  Advisor は満空の表（vacancy_lots.park_id）の番号で渡してくる。リパークは REP… で一覧と同じだが、
 *  タイムズは BUK… の駐車場コードで、一覧・状態ファイルはページのURLで持っている。そのまま比べると
 *  1件も当たらず、622件が優先されないまま最大16日前になっていた（2026-10-17 点検。本人指示: 直せるものは直して）。
 *  keyOf（一覧の1件 → 番号）を渡すと番号どうしで照合し、一覧の書き方で返す。一覧に無い番号は missing に数える
 *  （閉鎖や、周辺の満空だけで見えている物件。ログに出して、ずれに気づけるようにする）。 */
export function matchPriority(want, allIds, keyOf = null) {
  const byKey = new Map(allIds.map((id) => [keyOf ? keyOf(id) : id, id]));
  const ids = [], seen = new Set();
  let missing = 0;
  for (const k of want) {
    const id = byKey.get(String(k));
    if (id === undefined) { missing++; continue; }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ids, missing };
}

/** 未取得 → 取得が古い順に N 件選ぶ。
 *  spreadHours を渡すと「その時刻をまだ見ていない物件」を先に回す（満空を時間帯ごと均等に採るため）。 */
export function pickRolling(allIds, state, n, { spreadHours = false, at = null, priority = [], priorityMinAgeMs = 3 * 3600e3 } = {}) {
  // 状態の文字列は1回だけ読む（比較関数の中で毎回分解すると数十万回になる）
  const parsed = new Map(allIds.map((id) => [id, parseState(state[id])]));
  const st = (id) => parsed.get(id);
  // 消えた物件は寝かせる。期限が切れたら普通に戻る（本当に復活していれば取れる）
  const nowMs = new Date(at ?? Date.now()).getTime();
  const live = allIds.filter((id) => { const x = st(id); return !(x.gone && nowMs - x.t < GONE_MS); });
  // 優先物件（レポートで実際に見ている周りの物件）は、ローリングの順番を待たずに先に取る。
  // ただし前回から priorityMinAgeMs 空いているものだけ。毎時走っても同じ物件を毎時は叩かない
  // （既定3時間おき＝1日8回。全国を毎時回すより先方の負荷を桁違いに抑えつつ、重みは1週間で十分に付く）。
  // n とは別枠で足す。ここで n を食うと全国の1巡が遅れ、時間帯を均す仕掛けが崩れるため。
  const liveSet = new Set(live);
  const head = priority.filter((id) => liveSet.has(id) && nowMs - st(id).t >= priorityMinAgeMs)
    .sort((a, b) => st(a).t - st(b).t);
  const headSet = new Set(head);
  const rest = pickRollingRest(live.filter((id) => !headSet.has(id)), st, n, { spreadHours, nowMs });
  return head.concat(rest);
}
function pickRollingRest(live, st, n, { spreadHours, nowMs }) {
  if (!spreadHours) {
    return [...live].sort((a, b) => st(a).t - st(b).t).slice(0, n);
  }
  const bit = 1 << jstHour(nowMs);
  const need = [], done = [];
  // 24時間ぜんぶ見終わった物件を「どの時刻も済み」にすると、次の一巡に入れず後回しにされ続ける
  for (const id of live) ((effectiveMask(st(id).mask) & bit) ? done : need).push(id);
  const byAge = (a, b) => st(a).t - st(b).t;
  need.sort(byAge);
  if (need.length >= n) return need.slice(0, n);
  // 穴が尽きたら（＝全物件がこの時刻を見終わったら）いつもどおり古い順で埋める
  return need.concat(done.sort(byAge).slice(0, n - need.length));
}
