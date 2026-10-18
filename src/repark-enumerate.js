// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。

import fs from "node:fs";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";
import { writeFileAtomic } from "./write-atomic.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

/** sitemap（www 版の detail URL）から park= の値だけを重複なく拾う。一覧のキャッシュ（XML のまま）を読むときにも使う */
export function parkIdsFromSitemap(xml) {
  const ids = new Set();
  const re = /result\/detail\/\?park=(REP\d+)/g;
  let m;
  while ((m = re.exec(String(xml)))) ids.add(m[1]);
  return [...ids];
}

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
// 取れた sitemap の物件が前の一覧の半分未満（途中で切れた・作りが変わったなど。0件を含む）なら、前の一覧を使い続ける
// （keepPrevIfShrunk。取得日は進めず、health で知らせる）。欠けた sitemap で上書きすると7日間その分を回らなくなるため
export async function getAllParkIds({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  const prev = fs.existsSync(abs) ? parkIdsFromSitemap(fs.readFileSync(abs, "utf8")) : [];
  if (prev.length && cacheFresh(abs, cacheMs)) return prev;
  const res = await politeFetch(SITEMAP_URL);
  if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
  const ids = parkIdsFromSitemap(res.html);
  const kept = keepPrevIfShrunk("リパーク", ids, prev);
  if (kept) return kept;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, res.html);
  markFetched(abs);
  return ids;
}

// ローリング状態（parkId -> 最終取得ISO、または "ISO|時間帯マスク36進"）を読み書き。
// 時間帯マスクは「その物件を日本時間の何時に見たことがあるか」の24ビット。
// GitHub Actions の定時実行は混雑時に平気で2〜3時間ずれる（実測: 1時間おき指定でも
// 16:55→19:28→22:17）。実行時刻に頼って時間帯をそろえる作りだと、この遅れが
// そのまま偏りになる。そこで「今の時刻をまだ見ていない物件」を先に選ぶ。
// こうすると実行がいつ走ろうと、24時間ぶんの穴が順に埋まっていく。
export function loadCrawlState(stateFile) {
  const abs = path.resolve(stateFile);
  let state = {};
  if (fs.existsSync(abs)) {
    try { state = JSON.parse(fs.readFileSync(abs, "utf8")); } catch { state = {}; }
  }
  openedStates.set(abs, state);
  return state;
}

// この実行で読み込んだ巡回状態（絶対パス -> 状態）。巡回が止められたとき・途中の例外で落ちたときに
// flushCrawlStates で書き出す。観測（料金・満空）は取るたびに追記しているが、状態は50件ごとと各回の終わりにしか
// 書いていないので、その間に取った物件が「取っていない」ことになり、次の回にまた取りに行っていた（2026-10-18）
const openedStates = new Map();
/** 読み込んだ巡回状態をすべて書き出す（書き終わった社をもう一度書いても中身は同じ）。書いた数を返す */
export function flushCrawlStates() {
  for (const [abs, state] of openedStates) saveCrawlState(abs, state);
  return openedStates.size;
}

export function saveCrawlState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 一時ファイルに書いてから置き換える。書いている途中で止められても、壊れた JSON を残さない（2026-10-18）
  writeFileAtomic(abs, JSON.stringify(state, null, 0));
  // ここで markFetched は呼ばない。取得日の記録は「物件一覧」のためのもので、
  // 巡回状態は毎回書き換わる別物（付けると不要な .fetched が毎回生まれる）
}

const ALL_HOURS = (1 << 24) - 1;
/** 消えた物件（404）を寝かせる期間の下限。
 *  もとは「一覧を7日ごとに作り直すから7日」としていたが、実際に作り直してみると
 *  リパークの一覧は2か月変わっておらず、404の975件がそのまま載っていた。
 *  7日ごとに975件の404を投げ直すだけになるので、時間では長めに置く。
 *  一覧に新しく載った番号は、期限を待たずに起こす（unparkGone）。 */
const GONE_MS = 30 * 864e5;
/** 寝かせる期間を物件ごとにずらす幅（時間）。30日＋（番号のハッシュ％721）時間＝30〜60日。
 *  日単位（％31日）だと、同じ回に寝かせた物件が毎日同じ1時間にまとまって起きる（リパークの本物の状態で1時間に最大27件）。
 *  時間単位にすると1時間あたり1〜2件になる */
const GONE_SPREAD_HOURS = 30 * 24 + 1;

/** 物件ごとの寝かせる期間（30〜60日）。番号だけから決まる（毎回同じ値）。
 *  一律30日だと、同じ日に寝かせた物件が30日後に一斉に起きる。リパークでは 9/12 に寝かせた約975件が
 *  10/12 に一度に起き、2回の巡回で962件の404をまとめて投げ、その回の取得と満空の観測が約800行失われた。
 *  10/12 に寝かせ直した964件も 11/11 の2回の巡回（604件・358件）に同じ山になるところだった。番号のハッシュで
 *  30日ぶんの時間に散らすと、1日あたり約30件・毎時の回で1〜2件にならされる。
 *  状態の値の形（"GONE|ISO"）は変えない（studio-index.mjs が読む） */
export function goneMsOf(id) {
  // FNV-1a（32ビット）。番号の末尾の数字が並んでいても散るように、最後にもう一度かき混ぜる
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return GONE_MS + ((h >>> 0) % GONE_SPREAD_HOURS) * 3600e3;
}
/** 寝かせている最中か（GONE で、期限がまだ来ていない） */
const sleeping = (id, x, nowMs) => x.gone && nowMs - x.t < goneMsOf(id);
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

/** 一斉の閉鎖の歯止め（2026-10-18 の点検）。先方がサイトの作り替えや保守で、全ページを同じ所（/misc/404.php や /）へ
 *  転送したり 404 を返したりすると、その回に取った物件が全部 GONE（30〜60日寝かせ、studio-index.mjs の相場からも外れる）になる。
 *  一覧はほとんど変わらないので unparkGone でも起こされない。
 *  answered() … 「前は生きていた物件」（run.js の watch。一覧に載っていて、取った記録があり、寝かせていないもの）で先方が答えた1件。
 *  closed(id, prev, watch) … 閉鎖とみなして印を付けた1件（prev は印を付ける前の状態の値）。数えるのは watch の分だけ。
 *    一覧から外れた物件・一覧から消えた物件の確かめ・寝かせた物件の起き抜け・初めての物件は、閉鎖が多くて当たり前なので数えない
 *    （数えると、正しい閉鎖が続いただけで止まり、戻した物件が次の回も先頭に来て巡回が進まなくなる）。
 *    watch の閉鎖が min 件以上、かつ answered の ratio 以上になったら true を返す。
 *  restore(state) … この回に付けた閉鎖の印を、数えなかった分も含めて全部前の値に戻し、戻した件数を返す
 *    （確かめられていない閉鎖で相場から外さない。正しい閉鎖は次の回以降にまた確かめる）。
 *  名鉄協商の最初の数回は正しい閉鎖が約22%（今の状態ファイルで試すと、30件を超えてからの割合は最大26%）なので止まらない */
export function makeMassGone({ min = 30, ratio = 0.5 } = {}) {
  let answered = 0, counted = 0;
  const marked = new Map();
  return {
    answered: () => { answered++; },
    closed(id, prev, watch = true) {
      if (!marked.has(id)) marked.set(id, prev);
      if (!watch) return false;
      counted++;
      return counted >= min && counted >= answered * ratio;
    },
    restore(state) {
      for (const [id, prev] of marked) { if (prev === undefined) delete state[id]; else state[id] = prev; }
      const n = marked.size; marked.clear(); return n;
    },
    get stats() { return { answered, closed: counted, marked: marked.size }; },
  };
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

/** 一覧に新しく載った物件のうち、寝かせていたものを起こす。
 *  先方が物件を載せ直したということなので、404だったものが復活している見込みがある。
 *  以前は一覧が1件でも変わると、一覧の中の寝かせた物件を全部起こしていた。あなぶきパークでは 10/12 に一覧が
 *  792→793 件に1件増えただけで寝かせた68件を起こし、68件すべてがまた404だった。そこで前の一覧（prevIds。
 *  run.js が一覧を作り直す前のファイルから読む）と比べ、前の一覧に無く今回載った番号だけを起こす。
 *  前の一覧が分からないときは何も起こさない（寝かせる期限 goneMsOf が切れれば普通に戻る） */
export function unparkGone(state, ids, prevIds = null) {
  const h = listHash(ids);
  if (state._list === h) return 0;
  // 記録が無い初回は、一覧が変わったかどうか分からない。起こさずに指紋だけ控える
  if (state._list === undefined || !prevIds?.length) { state._list = h; return 0; }
  const before = new Set(prevIds);
  let n = 0;
  for (const id of ids) if (!before.has(id) && String(state[id] ?? "").startsWith("GONE|")) { delete state[id]; n++; }
  state._list = h;
  return n;
}

/** 生きている（寝かせていない）物件の数。1周の回数を決めるのに使う */
export function countLive(allIds, state, nowMs = Date.now()) {
  return allIds.filter((id) => !sleeping(id, parseState(state[id]), nowMs)).length;
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
  const live = allIds.filter((id) => !sleeping(id, st(id), nowMs));
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
