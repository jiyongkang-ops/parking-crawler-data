// JR九州レンタカー＆パーキング（parking-kyushu.jp / 九州 約745件）詳細のパーサ
// 列挙は駅ページ（/station/{駅名}）→ /number/{8桁コード}。robots.txt は Allow: /。
// 詳細は表形式（物件コード/駐車場名/所在地/時間貸料金/月極料金/収容台数）。
// 時間貸料金の書式:
//   平日 8時～19時：30分200円／最大料金なし
//   土日祝 19時～8時：60分100円／最大400円
// 月極専用の物件は時間貸料金の行が無い（unitCharges/maxFees は空で返す）。
// 座標と「時間貸OK」の印は詳細ページに無いので、駅の一覧で読んだ分（jqparks-enumerate.js の listMeta）を run.js から受け取る（2026-11-02）。
//   lat/lng … 一覧の地図のピン（makePin。世界測地系）。以前は読まず、住所から引いていたので32件（6%）が座標なしで相場から抜けていた
//   hourlyOk … 一覧の「時間貸OK」の印。true＝時間貸あり、false＝月極だけ、null＝一覧で読めていない。
//     月極だけの物件も記録には残す（相場や件数に入れるかは別に決める）

export function detailUrl(id) {
  return `https://www.parking-kyushu.jp/number/${id}`;
}

const z2h = (s) => (s ?? "")
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/：/g, ":").replace(/／/g, "/");

// 「時間貸料金」等のラベルセルに対応する値セル。
// ラベルの直後には幅調整用の <td><img></td> が挟まるため、
// 画像だけのセルを読み飛ばして最初の実体のあるセルを返す。
function fieldValue(html, label) {
  const li = html.search(new RegExp(`>\\s*${label}\\s*(?:<br\\s*/?>)?\\s*(?:\\(税込\\))?\\s*</td>`));
  if (li < 0) return null;
  const rest = html.slice(li);
  for (const m of rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const inner = m[1];
    const text = inner.replace(/<img[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
    if (text) return inner;
  }
  return null;
}

/** 一覧で読んだ座標・時間貸の印（{ lat, lng, hourlyOk }。無ければ null）を記録の形にする */
function fromList(meta) {
  const ok = (v) => v != null && Number.isFinite(Number(v)) && Number(v) !== 0;
  const geo = meta && ok(meta.lat) && ok(meta.lng) ? { lat: Number(meta.lat), lng: Number(meta.lng) } : { lat: null, lng: null };
  return { ...geo, hourlyOk: typeof meta?.hourlyOk === "boolean" ? meta.hourlyOk : null };
}

export function parseJqparksDetail(html, { id, listMeta = null } = {}) {
  const name = (fieldValue(html, "駐車場名") ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  const address = (fieldValue(html, "所在地") ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  const capRaw = (fieldValue(html, "収容台数") ?? "").replace(/<[^>]+>/g, " ").trim();
  const capacity = Number((capRaw.match(/(\d+)/) || [])[1]) || null;

  const unitCharges = [];
  const maxFees = [];
  const feeRaw = fieldValue(html, "時間貸料金") ?? "";
  for (const seg of feeRaw.split(/<br\s*\/?>/i)) {
    const line = z2h(seg.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!line || !/円/.test(line)) continue;
    // scope（平日 / 土日祝 / 全日 など）と時間帯
    const rg = line.match(/(\d{1,2})\s*時\s*[～~〜-]\s*(\d{1,2})\s*時/);
    const scope = (line.split(/\s+/)[0] || "全日").replace(/[:：].*$/, "");
    const timeRange = rg ? `${rg[1]}:00-${rg[2]}:00` : "00:00-24:00";
    const unit = line.match(/(\d+)\s*分\s*([\d,]+)\s*円/);
    if (unit) unitCharges.push({ scope, timeRange, perMinutes: Number(unit[1]), amountYen: Number(unit[2].replace(/,/g, "")) });
    if (/最大料金なし/.test(line)) continue;
    const mx = line.match(/最大\s*([\d,]+)\s*円/);
    if (mx) maxFees.push({ scope, condition: `時間内最大 ${timeRange}`, amountYen: Number(mx[1].replace(/,/g, "")) });
  }
  const { lat, lng, hourlyOk } = fromList(listMeta);
  return { operator: "jqparks", parkId: String(id), label: null, name, address,
    lat, lng, capacity, openingHours: null,
    unitCharges, maxFees, hourlyOk, sourceUrl: detailUrl(id) };
}
