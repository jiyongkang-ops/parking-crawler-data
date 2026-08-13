// さいたま市 未利用市有資産（高収益候補7件）周辺の満空モニタリング -----------------
// 目的: 売上予測 年商150万円超の上位現場について、周辺コインパーキングの実稼働を観測し、
//       予測（稼働率の仮定）を実測でダブルチェックする。
// 対象: No.312/311/306（与野本町）・No.189/191/195（大宮駅西口）・No.254（盆栽町）
//       ※No.191とNo.195は測位座標が同一のため1観測点に統合。
// 頻度: 調査日（既定: 2026-08-18 火 / 2026-08-20 木 / 2026-08-22 土）のみ収集。
//       JST 6〜22時は30分毎、夜間（22〜6時）は1時間毎の観測スロット。
//       cronは15分毎に発火し（遅延・スキップ対策）、同一スロット取得済みならスキップ（冪等）。
// 出力: data/availability-saitama.jsonl（append-only / merge=union）
// 運用: 調査終了後（8/22以降）はワークフローを disable すること。
//       調査日を変える場合は env SURVEY_DATES="YYYY-MM-DD,YYYY-MM-DD" で上書き可能。
import fs from "node:fs";

const DEFAULT_DATES = ["2026-08-18", "2026-08-20", "2026-08-22"]; // 火・木・土
const SURVEY_DATES = (process.env.SURVEY_DATES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DATES = SURVEY_DATES.length ? SURVEY_DATES : DEFAULT_DATES;
const OUT = "data/availability-saitama.jsonl";

// 観測点（lat/lng は照合資料のURL座標。※印は町丁レベル測位のため半径判定は余裕をみて700mで記録）
const SITES = [
  { site: "no312", label: "No.312 旧水路敷地（与野本町）", lat: 35.8801265, lng: 139.6273227 },
  { site: "no311", label: "No.311 旧水路敷（与野本町）", lat: 35.8804433, lng: 139.6281009 },
  { site: "no306", label: "No.306 与野本町駅西口駅前通り", lat: 35.88159647549598, lng: 139.62500440028697 },
  { site: "no189", label: "No.189 西口都市改造（桜木町4丁目）", lat: 35.8999132, lng: 139.6201489 },
  { site: "no191-195", label: "No.191/195 西口都市改造（第五・第三地区）※", lat: 35.90395, lng: 139.621185 },
  { site: "no254", label: "No.254 指扇宮ヶ谷塔線用地（北15・盆栽町）※", lat: 35.925697, lng: 139.630673 },
];
const UA = "Mozilla/5.0 (compatible; LanditParkingResearch/1.0; +mailto:jiyong.kang@landit.co.jp)";
const RADIUS_M = 700; // 記録対象の最大距離

// ---- JSTの日付・スロット判定 ------------------------------------------------
const jstNow = new Date(Date.now() + 9 * 3600e3);
const jstDate = jstNow.toISOString().slice(0, 10);
const h = jstNow.getUTCHours(), m = jstNow.getUTCMinutes();
const daytime = h >= 6 && h < 22;
const slotMin = daytime ? (m < 30 ? 0 : 30) : 0;
const nightSkip = !daytime && m >= 30; // 夜間は毎時00スロットのみ（:30/:45発火はスキップ）
const slot = `${jstDate}T${String(h).padStart(2, "0")}:${String(slotMin).padStart(2, "0")}`;
const FORCE = !!process.env.FORCE;

if (!FORCE && !DATES.includes(jstDate)) { console.log(`調査日外（${jstDate}）・スキップ`); process.exit(0); }
if (!FORCE && nightSkip) { console.log(`夜間の30分スロットはスキップ（${slot}）`); process.exit(0); }

// ---- 冪等化: 同一スロット・同一観測点・同一ソースが記録済みなら再取得しない ----
const seen = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.slot && r.site) seen.add(`${r.slot}|${r.site}|${r.source}`); } catch {}
  }
}

const hav = (aLat, aLng, bLat, bLng) => { const R = 6371000, toR = (d) => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)); };

// ---- Parkopedia（トークンは全地点で使い回す） --------------------------------
let pkToken = null;
async function pkFetch(LAT, LNG) {
  const { PK_HOST, PK_CID, PK_SECRET, PK_UID, PK_APIVER = "52" } = process.env;
  if (!PK_HOST || !PK_CID || !PK_SECRET) { console.log("[PK] 認証情報なし・スキップ"); return null; }
  if (!pkToken) {
    const tr = await fetch(`https://${PK_HOST}/api/tokens?apiver=${PK_APIVER}&cid=${PK_CID}${PK_UID ? `&uid=${PK_UID}` : ""}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: PK_CID, client_secret: PK_SECRET }) });
    const tok = await tr.json();
    pkToken = tok.result?.access_token ?? tok.access_token ?? null;
  }
  if (!pkToken) return null;
  const q = new URLSearchParams({ apiver: PK_APIVER, cid: PK_CID, lat: String(LAT), lng: String(LNG), radius: String(RADIUS_M), pk_type: "OFF_STREET" });
  if (PK_UID) q.set("uid", PK_UID);
  const r = await (await fetch(`https://${PK_HOST}/api/parking/locations?${q}`, { headers: { Authorization: `Bearer ${pkToken}` } })).json();
  const coordOf = (g) => { if (!g) return null;
    if (g.type === "Point") return g.coordinates;
    if (g.type === "GeometryCollection") { const p2 = (g.geometries || []).find((x) => x.type === "Point"); return p2?.coordinates ?? null; }
    return null; };
  const rows = [];
  const at = new Date().toISOString();
  for (const f of r.result?.features ?? []) {
    const s = f.properties?.static, a = f.properties?.dynamic?.availability?.[0];
    if (!a) continue; // 満空情報のある物件のみ記録
    const c = coordOf(f.geometry);
    const dist = c ? Math.round(hav(LAT, LNG, c[1], c[0])) : null;
    if (dist != null && dist > RADIUS_M) continue;
    rows.push({ at, source: "parkopedia", name: s?.name ?? "?", capacity: s?.capacity ?? null,
      lat: c ? c[1] : null, lng: c ? c[0] : null, address: s?.address ?? null, dist,
      free: a.free ?? null, indicator: a.indicator ?? null, trend: a.trend ?? null, updatedAt: a.updated_at ?? null });
  }
  return rows;
}

// ---- NPC公式API --------------------------------------------------------------
async function npcFetch(LAT, LNG) {
  const R2 = 0.012;
  const url = `https://parking.npc-npc.co.jp/api/parking/location.json?latitude=${LAT}&longitude=${LNG}&northLat=${LAT + R2}&southLat=${LAT - R2}&eastLng=${LNG + R2}&westLng=${LNG - R2}`;
  const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  const arr = Array.isArray(j) ? j : (j.parkings ?? j.data ?? []);
  const ST = { 0: "空", 1: "混雑", 2: "満車", 9: "不明" };
  const rows = [];
  const at = new Date().toISOString();
  for (const p of arr) {
    const d = hav(LAT, LNG, +p.latitude, +p.longitude);
    if (d > RADIUS_M) continue;
    rows.push({ at, source: "npc", name: p.parking_name, capacity: null, free: null,
      lat: +p.latitude, lng: +p.longitude, address: p.address ?? null, dist: Math.round(d),
      indicator: null, status: ST[p.full_empty_status] ?? String(p.full_empty_status) });
  }
  return rows;
}

// ---- 収集本体 -----------------------------------------------------------------
let wrote = 0;
for (const loc of SITES) {
  const out = [];
  for (const [source, fn] of [["parkopedia", pkFetch], ["npc", npcFetch]]) {
    if (!FORCE && seen.has(`${slot}|${loc.site}|${source}`)) { console.log(`[${loc.label}] ${source} は ${slot} 取得済み・スキップ`); continue; }
    try {
      const rows = await fn(loc.lat, loc.lng);
      if (rows === null) continue; // 認証情報なし等
      for (const r of rows) out.push({ ...r, site: loc.site, siteLabel: loc.label, slot });
      // 物件0件でもスロット消化を記録（リトライ暴走防止のためのマーカー行）
      if (rows.length === 0) out.push({ at: new Date().toISOString(), source, site: loc.site, siteLabel: loc.label, slot, marker: "no-data" });
    } catch (e) { console.error(`[${source}:${loc.site}] 失敗:`, e.message); }
    await new Promise((res) => setTimeout(res, 6000)); // リクエスト間隔（節度）
  }
  if (out.length) {
    fs.appendFileSync(OUT, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
    wrote += out.length;
    console.log(`[${loc.label}] ${out.length}件 → ${OUT}`);
  }
  await new Promise((res) => setTimeout(res, 1500)); // 地点間で待機（節度）
}
console.log(`slot=${slot} 追記=${wrote}件`);
