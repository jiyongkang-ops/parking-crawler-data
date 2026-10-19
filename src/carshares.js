// 三井のカーシェアーズ（carshares.jp）のステーション一覧 ------------------------------
// 公開の「ステーションを探す」（都道府県 → 市区 → 町 → ステーション）をたどり、
// ステーションごとの名前・住所・座標・台数・車種クラスを控える。予約・空き状況（会員ページ）には触れない。
// robots.txt は公開ページを禁止していない（PDFのみ）。サイトポリシーは私的利用の範囲のため、
// 集めた数字は社内の分析にとどめ、転載・再配布しない。
//
// 週1回で1巡（約3,800ステーション＋一覧ページ）。1回の実行は CARSHARE_BUDGET_MIN（既定200分）で切り上げ、
// 途中の状態（未取得の一覧・取得済み）を data/carshares-crawl-state.json に残して次の実行で続ける。
// 1巡が終わってから CARSHARE_CYCLE_DAYS（既定7日）たつまでは何もしない。
//
// 出力 data/carshare-mitsui.jsonl（追記型。1行＝1ステーションの状態。変わったときだけ書く。同じ k は最後の行が最新）
//   { k:"mitsui:7333", n, a, la, ln, cars, cls:{ベーシック:4,…}, path, at }
//   1巡で見なくなったステーションは { k, gone:1, at } を1行書く。
//   ただし、相手先の不調（5xx・429・403・通信の失敗）で2回とも取れなかったページの下にあるステーションには書かない
//   （取れなかっただけで、無くなったとは限らない）。
//
// robots.txt に届かない・断られているときは、そのページを列に戻して打ち切る（終了コード 1）。済みにも数えない。
// 2026-10-18 の直しの途中（robots.txt に届かないとき本ページを送らなくした直し）では、残りの一覧を1回も取りに行かないまま
// 全部「済み」にし、列が空になったので「1巡終わり」として、見なかった全ステーションに gone を書いていた
// （点検の試しで2,135行。本番では起きていない）。
//
// 止められたとき（巡回の手順の時間切れ・ジョブの取り消し）は、SIGINT・SIGTERM を受けて、そこまでの状態を書いてすぐ終わる
// （run.js と同じ考え方。ワークフローは exec node src/carshares.js で node 自身を手順のいちばん上にしている）。
// 取りに行っている途中のページは列の先頭に戻す（済みにしない）。状態は一時ファイルに書いてから置き換える（write-atomic.js）。
// 以前は止められると最後の50ページごとの保存より後の進み（済み・見たステーション）を失い、書き途中なら壊れた JSON が残るおそれがあった
// （2026-10-19 の最終点検）。ステーションの行は取るたびに追記済みなので、止めても失わない。
import fs from "node:fs";
import { politeFetch, fetchErrorText } from "./polite-fetch.js";
import { isTransient } from "./repark-enumerate.js";
import { writeFileAtomic } from "./write-atomic.js";

const BASE = "https://www.carshares.jp";
const STATE = process.env.CARSHARE_STATE || "data/carshares-crawl-state.json";
const OUT = process.env.CARSHARE_OUT || "data/carshare-mitsui.jsonl";
const BUDGET_MS = Number(process.env.CARSHARE_BUDGET_MIN || 200) * 60e3;
const CYCLE_MS = Number(process.env.CARSHARE_CYCLE_DAYS || 7) * 86400e3;
const DELAY = Number(process.env.CARSHARE_DELAY_MS || 3000);
// 相手先の不調（取れないページ）がこの数だけ続いたら、この回は打ち切る（先方が苦しいときに叩き続けない）
const BREAKER = Number(process.env.CARSHARE_BREAKER || 8);
// /station/ の下で都道府県ではない入口（車種・エリア・新着など）
const NOT_PREF = new Set(["area", "car", "drive", "new", "shinkansen"]);

const txt = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
/** 止められたときに状態を書く処理（main が巡回を始めたら入れる。それまでは書くものが無い） */
let onStop = null;

/** ステーションのページなら中身、違えば null */
export function parseStation(html, path) {
  const cm = html.match(/このステーションのクルマ（(\d+)台）/);
  if (!cm) return null;
  const id = (html.match(/station_id=(\d+)/) || [])[1] ?? null;
  const name = txt((html.match(/<h1 class="mainTitle01">([\s\S]*?)<\/h1>/) || [])[1]);
  const part = (p) => txt((html.match(new RegExp(`itemprop="${p}">([^<]*)<`)) || [])[1]);
  const a = [part("addressRegion"), part("addressLocality"), part("streetAddress")].join("");
  const la = Number((html.match(/itemprop="latitude" content="([\d.]+)"/) || [])[1]) || null;
  const ln = Number((html.match(/itemprop="longitude" content="([\d.]+)"/) || [])[1]) || null;
  // 車種クラス（ベーシック・ミドル…）ごとの台数。料金の見立てに使う
  const cls = {};
  const box = html.slice(cm.index, html.indexOf("料金プランの詳細", cm.index) > 0 ? html.indexOf("料金プランの詳細", cm.index) : undefined);
  for (const m of box.matchAll(/車種クラス<\/span><span class="detail">([^<]+)</g)) cls[m[1].trim()] = (cls[m[1].trim()] ?? 0) + 1;
  return { k: `mitsui:${id ?? path}`, n: name || null, a: a || null, la, ln, cars: Number(cm[1]), cls, path };
}
/** 一覧ページから、今のパスより下のリンク（一覧・ステーション） */
function childLinks(html, path) {
  const out = new Set();
  for (const m of html.matchAll(/href="(\/station\/[^"?#]+\/)"/g)) {
    let p = m[1];
    try { p = decodeURI(p); } catch { /* そのまま */ }
    if (p.startsWith(path) && p.length > path.length) out.add(p);
  }
  return [...out];
}

async function main() {
  const t0 = Date.now();
  const st = load(STATE, {});
  const now = () => new Date().toISOString();
  // 前の巡が終わっていて、まだ次の巡の時期でなければ何もしない
  if (!st.queue?.length && st.cycleEnd && Date.now() - Date.parse(st.cycleStart ?? st.cycleEnd) < CYCLE_MS) {
    console.log(`[carshares] 次の巡は ${new Date(Date.parse(st.cycleStart) + CYCLE_MS).toISOString()} 以降`);
    return;
  }
  const last = {};
  try { for (const l of fs.readFileSync(OUT, "utf8").split("\n")) { if (!l) continue; try { const j = JSON.parse(l); last[j.k] = j; } catch { /* 飛ばす */ } } } catch { /* 初回 */ }
  if (!st.queue?.length) {
    // 新しい巡: 入口ページから都道府県を拾う
    const r = await politeFetch(`${BASE}/station/`, { minDelay: DELAY });
    if (!r.ok) { console.log(`[carshares] 入口の取得に失敗 ${r.status ?? r.skippedReason}`); process.exitCode = 1; return; }
    const prefs = [...new Set([...r.html.matchAll(/href="\/station\/([a-z0-9]+)\/"/g)].map((m) => m[1]))].filter((p) => !NOT_PREF.has(p));
    Object.assign(st, { cycleStart: now(), cycleEnd: null, queue: prefs.map((p) => `/station/${p}/`), done: [], seen: [], retried: [], failed: [] });
    console.log(`[carshares] 新しい巡を始める（都道府県 ${prefs.length}）`);
  }
  const done = new Set(st.done), seen = new Set(st.seen);
  // retried … 不調で取れず、列の最後に回して取り直したページ。failed … 2回とも取れなかったページ（この下は gone にしない）
  const retried = new Set(st.retried ?? []), failed = new Set(st.failed ?? []);
  let pages = 0, stations = 0, written = 0, streak = 0, aborted = null;
  const save = () => {
    st.done = [...done]; st.seen = [...seen]; st.retried = [...retried]; st.failed = [...failed];
    writeFileAtomic(STATE, JSON.stringify(st));   // 書いている途中で止められても、壊れた JSON を残さない
  };
  // 取りに行っている途中のページ（列から出したが、まだ答えを受けていない）。止められたら列の先頭に戻す
  let current = null;
  onStop = () => {
    if (current) { st.queue.unshift(current); current = null; }
    save();
    console.log(`[carshares] 取得 ${pages}ページ・ステーション ${stations}・書いた ${written}・残りの一覧 ${st.queue.length}（止められたので、ここまでの状態を書いた）`);
  };
  while (st.queue.length && Date.now() - t0 < BUDGET_MS) {
    const path = st.queue.shift();
    if (done.has(path)) continue;
    let r, err = null;
    current = path;
    try { r = await politeFetch(BASE + encodeURI(path), { minDelay: DELAY }); } catch (e) { r = null; err = fetchErrorText(e); }
    current = null;   // ここから次の取得までは await が無いので、止められても状態の途中にはならない
    // robots.txt で断られた（401・403）・届かない（通信の失敗・5xx）。本ページは送っていないし、残りのページも同じ答えになる。
    // このページは列の先頭に戻し（済みにしない・取得にも数えない）、この回は打ち切る。次の回に robots.txt から取り直す
    if (r?.blocked || r?.transient) {
      st.queue.unshift(path);
      aborted = `${r.skippedReason}${r.robotsError ? `（${r.robotsError}）` : ""}`;
      console.log(`[carshares] ${aborted}。この回は打ち切り`);
      break;
    }
    pages++;
    // 相手先の不調（5xx・429・403・通信の失敗）。1回目は列の最後に回して取り直す。2回目も取れなければ済みにして、
    // このページの下のステーションは1巡の終わりに gone にしない。続いたら打ち切る
    if (isTransient(r)) {
      const why = err ?? `HTTP ${r.status}`;
      if (++streak >= BREAKER) {
        st.queue.unshift(path);
        aborted = `相手先の不調（${BREAKER}ページ続けて取れず。最後は ${why}）`;
        console.log(`[carshares] ${aborted}。この回は打ち切り`);
        break;
      }
      if (!retried.has(path)) { retried.add(path); st.queue.push(path); console.log(`  retry ${path} ${why}（列の最後に回して取り直す）`); }
      else { done.add(path); failed.add(path); console.log(`  skip ${path} ${why}（2回とも取れず。この下のステーションは無くなったとしない）`); }
      continue;
    }
    streak = 0;
    done.add(path);
    if (!r.ok || r.skippedReason) { console.log(`  skip ${path} ${r.status ?? r.skippedReason}`); continue; }
    const s = parseStation(r.html, path);
    if (s) {
      stations++; seen.add(s.k);
      const p = last[s.k];
      if (!p || p.gone || p.cars !== s.cars || JSON.stringify(p.cls) !== JSON.stringify(s.cls) || p.la !== s.la || p.ln !== s.ln || p.n !== s.n) {
        const row = { ...s, at: now() }; fs.appendFileSync(OUT, JSON.stringify(row) + "\n"); last[s.k] = row; written++;
      }
    } else {
      for (const c of childLinks(r.html, path)) if (!done.has(c)) st.queue.push(c);
    }
    if (pages % 50 === 0) save();
  }
  // 打ち切った回は「1巡終わり」にしない（列にはまだ残りがある。gone も書かない）
  if (!st.queue.length && !aborted) {
    // 1巡終わり: 今回の巡で見なかったステーションを「無くなった」とする。
    // 取れなかったページ（failed）の下にあるステーションは、見られなかっただけなので書かない
    const under = (p) => !!p && [...failed].some((f) => p.startsWith(f));
    let gone = 0, kept = 0;
    for (const [k, v] of Object.entries(last)) {
      if (v.gone || seen.has(k)) continue;
      if (under(v.path)) { kept++; continue; }
      fs.appendFileSync(OUT, JSON.stringify({ k, gone: 1, at: now() }) + "\n"); gone++;
    }
    st.cycleEnd = now();
    st.lastCycle = { stations: seen.size, gone, start: st.cycleStart, end: st.cycleEnd, ...(failed.size ? { failedPages: failed.size, kept } : {}) };
    console.log(`[carshares] 1巡終わり: ステーション ${seen.size}・無くなった ${gone}` +
      `${failed.size ? `（取れなかった${failed.size}ページの下の${kept}件は、無くなったとしない）` : ""}`);
    retried.clear(); failed.clear();
  }
  onStop = null;
  save();
  console.log(`[carshares] 取得 ${pages}ページ・ステーション ${stations}・書いた ${written}・残りの一覧 ${st.queue.length}` +
    `${aborted ? `・打ち切り: ${aborted}` : ""}`);
  if (aborted) process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  // 止められたとき（run.js の最後と同じ考え方）。ランナーは手順のいちばん上のプロセスにだけ SIGINT を送り、
  // 7.5秒後に SIGTERM、さらに2.5秒後に kill する。状態を書いてすぐ終わる（取得の途中でも待たない）。2回目の合図ではそのまま終わる
  let stopping = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(sig, () => {
      if (stopping) process.exit(code);
      stopping = true;
      console.error(`[stop] ${sig} を受けました。ここまでの状態を書いて終わります`);
      try { onStop?.(); } catch (e) { console.error(`[stop] 状態を書けませんでした: ${e?.message ?? e}`); }
      process.exit(code);
    });
  }
  main();
}
