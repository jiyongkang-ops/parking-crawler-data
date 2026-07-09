// ダッシュボード生成 -------------------------------------------------------
// data/*.jsonl を読み、自己完結HTML（外部CDN不使用・データ埋め込み）を出力する。
// 料金は正規化せず「生データのまま」テキスト表示する（円/時などの計算はしない）。
// 集計は件数・地理分布・都道府県別・料金変動履歴のみ。
//
//   node src/dashboard.js   →  dashboard.html

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// data/ 配下の prices*.jsonl を全て自動検出（事業者を増やしても変更不要）
const DATA_FILES = fs
  .readdirSync(path.resolve("data"))
  .filter((f) => /^prices.*\.jsonl$/.test(f))
  .map((f) => `data/${f}`);
const OUT = "dashboard.html";

const OPERATOR_LABEL = {
  npc: "NPC", repark: "三井のリパーク", times: "タイムズ",
  mkp: "名鉄協商", navipark: "ナビパーク", ecolo: "エコロパーク", thepark: "ザ・パーク",
};

function loadRecords() {
  const recs = [];
  for (const f of DATA_FILES) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, "utf8").split("\n").filter(Boolean)) {
      try { recs.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return recs;
}

// 生の時間帯単価をテキストに（計算しない）
function unitText(rec) {
  return (rec.unitCharges ?? [])
    .map((u) => [u.scope, u.timeRange, `${u.perMinutes}分${u.amountYen}円`].filter(Boolean).join(" "))
    .join(" / ");
}
// 生の最大料金をテキストに（分類・計算しない）
function maxText(rec) {
  return (rec.maxFees ?? [])
    .map((m) => [m.scope, m.condition, `${m.amountYen}円`].filter(Boolean).join(" "))
    .join(" / ");
}

function prefOf(rec) {
  const m = (rec.address ?? "").match(/^(.+?[都道府県])/);
  return m ? m[1] : "不明";
}

function main() {
  const all = loadRecords();

  // 最新スナップショット（operator:parkId ごとに fetchedAt 最大）
  const latest = new Map();
  for (const r of all) {
    const k = `${r.operator}:${r.parkId}`;
    const prev = latest.get(k);
    if (!prev || new Date(r.fetchedAt) >= new Date(prev.fetchedAt)) latest.set(k, r);
  }
  const lots = [...latest.values()];

  // 価格変動レコード（changedFromPrev）を新しい順に
  const changes = all
    .filter((r) => r.changedFromPrev)
    .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));

  const slim = lots.map((r) => ({
    op: r.operator, name: r.name, pref: prefOf(r),
    unit: unitText(r), max: maxText(r), lat: r.lat, lng: r.lng,
  }));

  const lastUpdated = all.reduce((m, r) => (r.fetchedAt > m ? r.fetchedAt : m), "");

  const payload = {
    generatedAt: new Date().toISOString(),
    lastUpdated,
    operatorLabel: OPERATOR_LABEL,
    lots: slim,
    changes: changes.map((r) => ({
      op: r.operator, name: r.name, pref: prefOf(r),
      unit: unitText(r), max: maxText(r), at: r.fetchedAt,
    })),
  };

  fs.writeFileSync(path.resolve(OUT), render(payload));
  console.log(
    `dashboard 生成: ${OUT} | 物件${lots.length}件 / 変動${changes.length}件 / 最終更新 ${lastUpdated || "—"}`
  );
}

function render(payload) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>駐車場料金ダッシュボード</title>
<style>
  :root { --bg:#0f1419; --card:#1a2129; --fg:#e6edf3; --muted:#8b949e;
          --npc:#3fb950; --repark:#58a6ff; --times:#f78166; --mkp:#d2a8ff;
          --navipark:#ffa657; --ecolo:#79c0ff; --thepark:#ff7b72; --grid:#30363d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif; }
  header { padding:24px 28px 12px; }
  h1 { margin:0; font-size:20px; }
  .sub { color:var(--muted); font-size:13px; margin-top:4px; }
  .wrap { padding:12px 28px 48px; display:grid; gap:20px; grid-template-columns:repeat(12,1fr); }
  .card { background:var(--card); border:1px solid var(--grid); border-radius:12px; padding:18px 20px; }
  .card h2 { margin:0 0 14px; font-size:14px; font-weight:600; }
  .col-12{grid-column:span 12} .col-6{grid-column:span 6}
  @media(max-width:880px){ .wrap>*{grid-column:span 12 !important} }
  .kpis { display:flex; gap:18px; flex-wrap:wrap; }
  .kpi { flex:1; min-width:120px; }
  .kpi .n { font-size:28px; font-weight:700; }
  .kpi .l { font-size:12px; color:var(--muted); margin-top:2px; }
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .legend{font-size:12px;color:var(--muted);display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);vertical-align:top}
  th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--card)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .fee{font-size:12px;color:var(--fg);white-space:normal;max-width:360px}
  .empty{color:var(--muted);font-size:13px;padding:8px 0}
  svg{display:block;width:100%;height:auto;overflow:visible}
  .bar-label{font-size:11px;fill:var(--muted)}
  input{background:#0d1117;border:1px solid var(--grid);color:var(--fg);
        border-radius:7px;padding:7px 10px;font-size:13px;width:240px}
  #tbl{max-height:560px;overflow:auto;margin-top:10px}
  #changes{max-height:360px;overflow:auto}
</style></head><body>
<header>
  <h1>🅿️ 駐車場料金ダッシュボード</h1>
  <div class="sub" id="sub"></div>
</header>
<div class="wrap">
  <div class="card col-12"><div class="kpis" id="kpis"></div></div>
  <div class="card col-6"><h2>都道府県別 物件数（上位15）</h2><div id="pref"></div></div>
  <div class="card col-6"><h2>地理分布（経度×緯度）</h2>
    <div class="legend" id="leg3"></div><div id="geo"></div></div>
  <div class="card col-12"><h2>最近の料金変動</h2><div id="changes"></div></div>
  <div class="card col-12"><h2>物件一覧（料金は取得したままの生データ）</h2>
    <input id="q" placeholder="物件名・都道府県で絞り込み"><div id="tbl"></div></div>
</div>
<script id="data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const COL = {npc:'var(--npc)',repark:'var(--repark)',times:'var(--times)',mkp:'var(--mkp)',navipark:'var(--navipark)',ecolo:'var(--ecolo)',thepark:'var(--thepark)'};
const LBL = D.operatorLabel;
const ops = [...new Set(D.lots.map(l=>l.op))];
const fmt = n => n==null?'—':n.toLocaleString('ja-JP');
const esc = s => (s==null?'':String(s)).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const jst = s => s? new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';

document.getElementById('sub').textContent =
  '最終更新 ' + jst(D.lastUpdated) + '（JST） / 生成 ' + jst(D.generatedAt) + ' ／ 料金は正規化せず生データを表示';

// KPI
document.getElementById('kpis').innerHTML =
  '<div class="kpi"><div class="n">'+fmt(D.lots.length)+'</div><div class="l">総物件数</div></div>' +
  ops.map(op=>'<div class="kpi"><div class="n" style="color:'+COL[op]+'">'+
    fmt(D.lots.filter(l=>l.op===op).length)+'</div><div class="l">'+LBL[op]+'</div></div>').join('') +
  '<div class="kpi"><div class="n">'+fmt(D.changes.length)+'</div><div class="l">料金変動（累計）</div></div>';

document.getElementById('leg3').innerHTML = ops.map(op=>'<span><span class="dot" style="background:'+COL[op]+'"></span>'+LBL[op]+'</span>').join('');

// 都道府県別 上位15
(function(){
  const cnt={}; D.lots.forEach(l=>cnt[l.pref]=(cnt[l.pref]||0)+1);
  const rows=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,15);
  const max=Math.max(...rows.map(r=>r[1]),1);
  document.getElementById('pref').innerHTML = rows.map(([p,c])=>
    '<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px">'+
    '<div style="width:78px;color:var(--muted)">'+esc(p)+'</div>'+
    '<div style="flex:1;background:#0d1117;border-radius:4px"><div style="width:'+(100*c/max)+'%;background:var(--repark);height:14px;border-radius:4px"></div></div>'+
    '<div class="num" style="width:46px">'+fmt(c)+'</div></div>').join('');
})();

// 地理分布 scatter
(function(){
  const pts=D.lots.filter(l=>l.lat&&l.lng);
  const el=document.getElementById('geo');
  if(!pts.length){ el.innerHTML='<div class="empty">座標を持つ物件がありません</div>'; return; }
  const W=440,H=300, lo=124,hi=146, la0=26,la1=46;
  const X=lng=>(lng-lo)/(hi-lo)*W, Y=lat=>H-(lat-la0)/(la1-la0)*H;
  let s='<svg viewBox="0 0 '+W+' '+H+'" style="background:#0d1117;border-radius:8px">';
  pts.forEach(p=>{ s+='<circle cx="'+X(p.lng).toFixed(1)+'" cy="'+Y(p.lat).toFixed(1)+'" r="1.6" fill="'+COL[p.op]+'" opacity="0.7"/>'; });
  el.innerHTML=s+'</svg>';
})();

// 最近の料金変動
(function(){
  const el=document.getElementById('changes');
  if(!D.changes.length){ el.innerHTML='<div class="empty">まだ料金変動は検知されていません（収集が一巡すると差分が出ます）</div>'; return; }
  let h='<table><tr><th>日時</th><th>事業者</th><th>物件</th><th>時間帯料金</th><th>最大料金</th></tr>';
  D.changes.slice(0,50).forEach(c=>{ h+='<tr><td>'+jst(c.at)+'</td><td><span class="dot" style="background:'+COL[c.op]+'"></span>'+LBL[c.op]+
    '</td><td>'+esc(c.name)+'</td><td class="fee">'+esc(c.unit)+'</td><td class="fee">'+esc(c.max)+'</td></tr>'; });
  el.innerHTML=h+'</table>';
})();

// 物件一覧（生データ・検索）
(function(){
  const tbl=document.getElementById('tbl'), q=document.getElementById('q');
  function draw(f){
    const ls=D.lots.filter(l=>!f || (l.name||'').includes(f) || (l.pref||'').includes(f)).slice(0,300);
    let h='<table><tr><th>事業者</th><th>都道府県</th><th>物件</th><th>時間帯料金(生)</th><th>最大料金(生)</th></tr>';
    ls.forEach(l=>{ h+='<tr><td><span class="dot" style="background:'+COL[l.op]+'"></span>'+LBL[l.op]+
      '</td><td>'+esc(l.pref)+'</td><td>'+esc(l.name)+'</td><td class="fee">'+esc(l.unit)+'</td><td class="fee">'+esc(l.max)+'</td></tr>'; });
    h+='</table>'; if(D.lots.length>300) h+='<div class="empty">※先頭300件のみ表示。検索で絞り込めます</div>';
    tbl.innerHTML=h;
  }
  q.addEventListener('input',e=>draw(e.target.value.trim()));
  draw('');
})();
</script>
</body></html>`;
}

main();
