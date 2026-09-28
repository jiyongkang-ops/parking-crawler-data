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
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const BASE = "https://www.carshares.jp";
const STATE = process.env.CARSHARE_STATE || "data/carshares-crawl-state.json";
const OUT = process.env.CARSHARE_OUT || "data/carshare-mitsui.jsonl";
const BUDGET_MS = Number(process.env.CARSHARE_BUDGET_MIN || 200) * 60e3;
const CYCLE_MS = Number(process.env.CARSHARE_CYCLE_DAYS || 7) * 86400e3;
const DELAY = Number(process.env.CARSHARE_DELAY_MS || 3000);
// /station/ の下で都道府県ではない入口（車種・エリア・新着など）
const NOT_PREF = new Set(["area", "car", "drive", "new", "shinkansen"]);

const txt = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

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
    Object.assign(st, { cycleStart: now(), cycleEnd: null, queue: prefs.map((p) => `/station/${p}/`), done: [], seen: [] });
    console.log(`[carshares] 新しい巡を始める（都道府県 ${prefs.length}）`);
  }
  const done = new Set(st.done), seen = new Set(st.seen);
  let pages = 0, stations = 0, written = 0;
  const save = () => { st.done = [...done]; st.seen = [...seen]; fs.writeFileSync(STATE, JSON.stringify(st)); };
  while (st.queue.length && Date.now() - t0 < BUDGET_MS) {
    const path = st.queue.shift();
    if (done.has(path)) continue;
    const r = await politeFetch(BASE + encodeURI(path), { minDelay: DELAY });
    done.add(path); pages++;
    if (!r.ok) { console.log(`  skip ${path} ${r.status ?? r.skippedReason}`); continue; }
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
  if (!st.queue.length) {
    // 1巡終わり: 今回の巡で見なかったステーションを「無くなった」とする
    let gone = 0;
    for (const [k, v] of Object.entries(last)) if (!v.gone && !seen.has(k)) { fs.appendFileSync(OUT, JSON.stringify({ k, gone: 1, at: now() }) + "\n"); gone++; }
    st.cycleEnd = now(); st.lastCycle = { stations: seen.size, gone, start: st.cycleStart, end: st.cycleEnd };
    console.log(`[carshares] 1巡終わり: ステーション ${seen.size}・無くなった ${gone}`);
  }
  save();
  console.log(`[carshares] 取得 ${pages}ページ・ステーション ${stations}・書いた ${written}・残りの一覧 ${st.queue.length}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
