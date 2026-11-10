// 一覧型の社の台数を、詳細ページから月1回だけ読む（2026-11-10 追加。本人指示「できるところは全て実施して」）---------------
// GSパーク・三菱地所パークスは、料金は一覧ページに載っているので毎回は一覧だけを取っている（詳細ページは回らない）。
// 台数は詳細ページにしか無く、今まで1件も入っていなかった（GS 890件・三菱地所 553件。Advisor の周辺500mの台数に入らない）。
// 台数はほとんど変わらないので、1物件を約30日に1回だけ詳細ページで読み、社ごとの控え（data/<社>-caps.json）に残す。
//   ・料金の巡回（一覧）の回数は変えない。一覧を取り終えたあとに、1回 limit 件まで詳細を取る（間隔・robots.txt は politeFetch のまま）
//   ・一覧の物件には控えの台数を付けてから記録に回す（applyCap）。料金が変わっていなくても、台数が初めて入った物件は
//     record-gap.js が1回だけ記録に足す
//   ・控えは社ごとに別のファイル。1つのファイルを2つのワークフローで書き換えると、衝突のとき片方の分が消えるため
//     （GSパークは crawl-extra.yml、三菱地所パークスは crawl-extra2.yml だけが書く）
import fs from "node:fs";
import { toHalfWidth } from "./zenkaku.js";
import { writeFileAtomic } from "./write-atomic.js";
import { politeFetch, failText, fetchErrorText } from "./polite-fetch.js";

/** 台数を読み直す間隔（日） */
export const CAP_REFRESH_DAYS = 30;
/** 1回に取る詳細ページの上限（初めの数日で全件に台数が入り、その後は1回に十数件） */
export const CAP_PER_RUN = 120;
/** 台数の読めないページがこれだけ続いたら、告知・作りの変更とみなして、その回は止める（読めなかった分は控えに書かない） */
export const CAP_UNREADABLE_STOP = 10;
/** 取れない答え（5xx・タイムアウトなど）がこれだけ続いたら、その回は止める */
export const CAP_FAIL_STOP = 5;

const num = (s) => {
  const m = toHalfWidth(String(s ?? "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, "").match(/^(\d+)台/);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
};

/** GSパークの詳細ページ（/time_parking/{id}/）の「<th>台数</th><td>5台</td>」→ 5。読めなければ null */
export function gsparkCapOf(html) {
  const m = String(html ?? "").match(/<th>\s*台数\s*<\/th>\s*<td>([\s\S]*?)<\/td>/);
  return m ? num(m[1]) : null;
}

/** 三菱地所パークス（Parking NAVI）の詳細ページ（details.php?parking_id=…&page=time）の「収容台数」の次の欄 → 台数。読めなければ null */
export function mecparksCapOf(html) {
  const m = String(html ?? "").match(/>\s*収容台数\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/);
  return m ? num(m[1]) : null;
}

/** 控え（{ 番号: { c: 台数 or null, at: 読んだ日時 } }）を読む。無い・壊れていれば空 */
export function loadCaps(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Map(Object.entries(j && typeof j === "object" ? j : {}));
  } catch { return new Map(); }
}
/** 控えを書く（番号の順。差分が読みやすいように1物件1行） */
export function saveCaps(file, caps) {
  const keys = [...caps.keys()].sort();
  writeFileAtomic(file, "{\n" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(caps.get(k))}`).join(",\n") + "\n}\n");
}

/** 一覧の物件に控えの台数を付ける（一覧に台数が無いときだけ）。付けたら true */
export function applyCap(rec, caps) {
  if (Number(rec?.capacity) > 0) return false;
  const c = caps.get(String(rec?.parkId))?.c;
  if (!(Number(c) > 0)) return false;
  rec.capacity = Number(c);
  return true;
}

/** 詳細を取る番の物件。控えに無い物件（一覧の順）→ 読んでから days 日たった物件（古い順）。最大 limit 件 */
export function dueIds(ids, caps, { now = Date.now(), days = CAP_REFRESH_DAYS, limit = CAP_PER_RUN } = {}) {
  const lim = now - days * 864e5;
  const fresh = [], old = [];
  for (const id of new Set(ids.map(String))) {
    const e = caps.get(id);
    const t = e?.at ? Date.parse(e.at) : NaN;
    if (!e || !Number.isFinite(t)) fresh.push(id);
    else if (t <= lim) old.push([id, t]);
  }
  old.sort((a, b) => a[1] - b[1]);
  return fresh.concat(old.map((x) => x[0])).slice(0, Math.max(0, limit));
}

/**
 * 番の来た物件の詳細ページを取り、台数を控えに入れる。
 *   urlOf(id) … 詳細ページの URL。capOf(html) … 台数（読めなければ null）
 *   deadlineMs … この時刻を過ぎたら止める（ジョブの時間切れの前に終える）
 * 読めたら { c, at }。ページは取れたが台数が無い・404/410（閉鎖）なら、前の台数のまま at だけ進める（毎回取りに行かない）。
 * ただし台数の読めないページが CAP_UNREADABLE_STOP 件続いたら告知とみなし、続いた分は書かずに止める。
 * robots.txt で断られた・届かない（本ページは送っていない）ときと、取れない答えが CAP_FAIL_STOP 件続いたときも止める（時刻は進めない）。
 * 戻り値: { tried, got, unreadable, failed, stop }
 */
export async function refreshCaps({ ids, caps, urlOf, capOf, file = null, fetchPage = politeFetch, limit = CAP_PER_RUN,
  days = CAP_REFRESH_DAYS, deadlineMs = null, now = () => Date.now(), log = console } = {}) {
  const sum = { tried: 0, got: 0, unreadable: 0, failed: 0, stop: null };
  const due = dueIds(ids, caps, { now: now(), days, limit });
  let pending = [];   // 台数の読めなかった物件（読めるページが来たら控えに書く。告知とみなしたら捨てる）
  let fails = 0;
  const flush = () => { for (const [id, e] of pending) caps.set(id, e); pending = []; };
  for (const id of due) {
    if (deadlineMs != null && now() > deadlineMs) { sum.stop = "時間切れ"; break; }
    let res;
    sum.tried++;
    try { res = await fetchPage(urlOf(id)); } catch (e) {
      sum.failed++; log.error(`  [cap error] ${id}: ${fetchErrorText(e)}`);
      if (++fails >= CAP_FAIL_STOP) { sum.stop = `取れない答えが${fails}件続いた`; break; }
      continue;
    }
    if (res.blocked || res.transient) { sum.stop = failText(res); break; }
    const at = new Date(now()).toISOString();
    const prevC = caps.get(id)?.c ?? null;
    if (res.ok && !res.skippedReason) {
      fails = 0;
      const c = capOf(res.html);
      if (c != null) { flush(); caps.set(id, { c, at }); sum.got++; }
      else {
        sum.unreadable++;
        pending.push([id, { c: prevC, at }]);
        if (pending.length >= CAP_UNREADABLE_STOP) { sum.stop = `台数の読めないページが${pending.length}件続いた（告知の見込み）`; pending = []; break; }
      }
    } else if (res.status === 404 || res.status === 410) {
      fails = 0; caps.set(id, { c: prevC, at, gone: res.status });
    } else {
      sum.failed++; log.error(`  [cap error] ${id}: ${failText(res)}`);
      if (++fails >= CAP_FAIL_STOP) { sum.stop = `取れない答えが${fails}件続いた`; break; }
    }
    if (file && sum.tried % 20 === 0) { saveCaps(file, caps); }
  }
  // 最後まで来たら、読めなかった分も控えに書く（次は30日後）
  if (!sum.stop) flush();
  if (file) saveCaps(file, caps);
  return sum;
}
