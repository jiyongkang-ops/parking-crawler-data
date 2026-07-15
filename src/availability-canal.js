// キャナルシティ博多 周辺1kmの満空モニタリング --------------------------------
// 毎時実行され、JSTの木・金・日のみ収集する（FORCE=1 で曜日を無視）。
// Parkopedia（空き台数 free / 空き度 indicator）と NPC 公式API（満空ステータス）を
// 各1リクエストずつ取得し、data/availability-canal.jsonl に追記する。
import fs from "node:fs";

const LAT = 33.5896305, LNG = 130.4109478; // キャナルシティ博多
const OUT = "data/availability-canal.jsonl";
const UA = "Mozilla/5.0 (compatible; LanditParkingResearch/1.0; +mailto:jiyong.kang@landit.co.jp)";

const jstNow = new Date(Date.now() + 9 * 3600e3);
const dow = jstNow.getUTCDay(); // JSTの曜日
if (![0, 4, 5].includes(dow) && !process.env.FORCE) { // 日=0, 木=4, 金=5
  console.log(`skip: 対象曜日外 (JST ${jstNow.toISOString().slice(0, 16)})`);
  process.exit(0);
}

const hav = (aLat, aLng, bLat, bLng) => { const R = 6371000, toR = (d) => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)); };

const at = new Date().toISOString();
const rows = [];

// --- Parkopedia（半径1km・1リクエスト） ---
try {
  const { PK_HOST, PK_CID, PK_SECRET, PK_UID, PK_APIVER = "52" } = process.env;
  if (PK_HOST && PK_CID && PK_SECRET) {
    const tr = await fetch(`https://${PK_HOST}/api/tokens?apiver=${PK_APIVER}&cid=${PK_CID}${PK_UID ? `&uid=${PK_UID}` : ""}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: PK_CID, client_secret: PK_SECRET }) });
    const tok = await tr.json();
    const t = tok.result?.access_token ?? tok.access_token;
    const q = new URLSearchParams({ apiver: PK_APIVER, cid: PK_CID, lat: String(LAT), lng: String(LNG), radius: "1000", pk_type: "OFF_STREET" });
    if (PK_UID) q.set("uid", PK_UID);
    const r = await (await fetch(`https://${PK_HOST}/api/parking/locations?${q}`, { headers: { Authorization: `Bearer ${t}` } })).json();
    const coordOf = (g) => { if (!g) return null;
      if (g.type === "Point") return g.coordinates;
      if (g.type === "GeometryCollection") { const p2 = (g.geometries || []).find((x) => x.type === "Point"); return p2?.coordinates ?? null; }
      return null; };
    for (const f of r.result?.features ?? []) {
      const s = f.properties?.static, a = f.properties?.dynamic?.availability?.[0];
      if (!a) continue; // 満空情報のある物件のみ記録
      const c = coordOf(f.geometry);
      rows.push({ at, source: "parkopedia", name: s?.name ?? "?", capacity: s?.capacity ?? null,
        lat: c ? c[1] : null, lng: c ? c[0] : null, address: s?.address ?? null,
        dist: c ? Math.round(hav(LAT, LNG, c[1], c[0])) : null,
        free: a.free ?? null, indicator: a.indicator ?? null, trend: a.trend ?? null, updatedAt: a.updated_at ?? null });
    }
    console.log(`[PK] 満空あり ${rows.length}件`);
  } else console.log("[PK] 認証情報なし・スキップ");
} catch (e) { console.error("[PK] 失敗:", e.message); }

// --- NPC 公式API（bbox・1リクエスト） ---
try {
  const R2 = 0.012;
  const url = `https://parking.npc-npc.co.jp/api/parking/location.json?latitude=${LAT}&longitude=${LNG}&northLat=${LAT + R2}&southLat=${LAT - R2}&eastLng=${LNG + R2}&westLng=${LNG - R2}`;
  const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  const arr = Array.isArray(j) ? j : (j.parkings ?? j.data ?? []);
  const ST = { 0: "空", 1: "混雑", 2: "満車", 9: "不明" };
  let n = 0;
  for (const p of arr) {
    const d = hav(LAT, LNG, +p.latitude, +p.longitude);
    if (d > 1000) continue;
    rows.push({ at, source: "npc", name: p.parking_name, capacity: null, free: null,
      lat: +p.latitude, lng: +p.longitude, address: p.address ?? null, dist: Math.round(d),
      indicator: null, status: ST[p.full_empty_status] ?? String(p.full_empty_status) });
    n++;
  }
  console.log(`[NPC] ${n}件`);
} catch (e) { console.error("[NPC] 失敗:", e.message); }

if (rows.length) {
  fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`[追記] ${rows.length}行 → ${OUT}`);
} else console.log("[追記なし]");
