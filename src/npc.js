// 日本パーキング(NPC) のパーサ ---------------------------------------------
// NPC は Nuxt の SPA で、料金は JSON API から取得する（HTMLスクレイピング不要）。
//   検索:   /api/parking/search.json?city_id={cityId}
//   地理:   /api/parking/location.json?latitude=..&northLat=.. (将来の半径検索用)
// search.json は city_id 単位でその市区の全 NPC 物件を配列で返す。
// 1リクエスト＝複数物件なので parse() はレコード配列を返す。

const API_BASE = "https://parking.npc-npc.co.jp/api/parking";

// city_id 単位の検索 URL
export function searchUrl(cityId) {
  return `${API_BASE}/search.json?city_id=${encodeURIComponent(cityId)}`;
}

// 地理(bbox)検索 URL。location.json は search.json と同じ物件スキーマ（料金込み）を返す。
// 日本全体を覆う bbox なら1リクエストで全国の NPC 物件を取得できる（2026時点 約1,700件）。
export function locationUrl(bbox, { limit = 2000, page = 1 } = {}) {
  const { northLat, southLat, eastLng, westLng } = bbox;
  const lat = (northLat + southLat) / 2;
  const lng = (eastLng + westLng) / 2;
  const q = new URLSearchParams({
    latitude: lat, longitude: lng,
    northLat, southLat, eastLng, westLng,
    limit, page,
  });
  return `${API_BASE}/location.json?${q.toString()}`;
}

// 日本全体を覆う bbox
export const JAPAN_BBOX = {
  northLat: 46, southLat: 24, eastLng: 146, westLng: 122,
};

// 人が見る詳細ページ（出典表示用）
export function detailUrl(prefId, cityId) {
  return `https://parking.npc-npc.co.jp/p/${prefId}/${cityId}`;
}

// "全日 終日 220円/20分" / 複数は <br> 区切り
function parseUnitCharges(usuallyCharge) {
  if (!usuallyCharge) return [];
  const units = [];
  for (const seg of usuallyCharge.split(/<br\s*\/?>/i)) {
    const text = seg.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const fm = text.match(/(\d[\d,]*)\s*円\s*\/\s*(\d+)\s*分/);
    if (!fm) continue;
    // 料金表記より前を「適用範囲(scope/時間帯)」とみなす
    const label = text.slice(0, fm.index).trim();
    units.push({
      timeRange: label || "全日", // 例: "全日 終日"
      perMinutes: Number(fm[2]),
      amountYen: Number(fm[1].replace(/,/g, "")),
    });
  }
  return units;
}

// "全日 入庫後最大（繰返有） 24時間 2,300円<br>全日 区間最大 18:00-08:00 600円"
function parseMaxFees(maxCharge) {
  if (!maxCharge) return [];
  const fees = [];
  for (const seg of maxCharge.split(/<br\s*\/?>/i)) {
    const text = seg.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const fm = text.match(/(\d[\d,]*)\s*円/);
    if (!fm) continue;
    const desc = text.slice(0, fm.index).trim();
    // 先頭語を scope(全日/平日 等)、残りを condition とみなす
    const parts = desc.split(/\s+/);
    const scope = parts.shift() ?? "";
    fees.push({
      scope: scope || "全日",
      condition: parts.join(" ").trim(),
      amountYen: Number(fm[1].replace(/,/g, "")),
    });
  }
  return fees;
}

// full_empty_status: "0"=空/不明 等。表示用ラベルに変換（取得できる範囲で）。
function emptyStatusLabel(code) {
  const map = { 0: "空", 1: "混雑", 2: "満車" };
  return map[String(code)] ?? null;
}

// JSON文字列 → 正規化レコード配列（共通スキーマ）
export function parseNpcSearch(body, { cityId, prefId, label } = {}) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  const parkings = Array.isArray(json?.parkings) ? json.parkings : [];
  return parkings.map((p) => ({
    operator: "npc",
    parkId: p.parking_code ?? String(p.id), // 物件単位の安定キー
    label: label ?? null,
    name: p.parking_name ?? null,
    address: p.address ?? null,
    lat: p.latitude ?? null,
    lng: p.longitude ?? null,
    capacity: p.rental_cabins ?? null,
    openingHours: p.features?.f02 === "24時間入出庫可" ? "24時間" : null,
    unitCharges: parseUnitCharges(p.usually_charge),
    maxFees: parseMaxFees(p.max_charge),
    fullEmptyStatus: emptyStatusLabel(p.full_empty_status), // 満空（NPCのみ取得可）
    sourceUrl: detailUrl(prefId ?? p.prefecture_id, cityId ?? p.city_id),
  }));
}
