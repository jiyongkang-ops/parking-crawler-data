// ザ・パーク（第一興商 / dkparking.com）のパーサ ----------------------------
// 全物件が単一JSON(data/search.json)に入っており、1リクエストで全件取得できる。
//   各物件: id, name, pref, address, lat/lng(※フィールドが逆), car_cnt, price(HTML文字列)
// price は <br /> 区切り・全角記号混じりのテキスト（例:「7：00～20：00　30分100円」）。
// robots.txt は制限なし。

const SEARCH_JSON = "https://www.dkparking.com/data/search.json?ver=1";

export function searchUrl() {
  return SEARCH_JSON;
}

// 全角→半角の正規化（コロン・スペース）
function normalize(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ") // 残存タグ(<font>等)を除去
    .replace(/：/g, ":")
    .replace(/　/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// price文字列 → { unitCharges, maxFees }
function parsePrice(price) {
  const unitCharges = [];
  const maxFees = [];
  for (const raw of (price || "").split(/<br\s*\/?>/i)) {
    const line = normalize(raw);
    if (!line) continue;
    const am = line.match(/([\d,]+)\s*円/);
    if (!am) continue;
    const amountYen = Number(am[1].replace(/,/g, ""));
    const um = line.match(/(\d+)\s*分\s*([\d,]+)\s*円/);
    const tr = line.match(/(\d{1,2}:\d{2}\s*[~～-]\s*\d{1,2}:\d{2})/);
    if (um && !/最大/.test(line)) {
      unitCharges.push({
        scope: "全日",
        timeRange: tr ? tr[1].replace(/\s*[~～]\s*/, "-") : "全日",
        perMinutes: Number(um[1]),
        amountYen: Number(um[2].replace(/,/g, "")),
      });
    } else {
      const condition = line.slice(0, am.index).replace(/最大料金|最大/g, " ").replace(/\s+/g, " ").trim();
      maxFees.push({ scope: "全日", condition, amountYen });
    }
  }
  return { unitCharges, maxFees };
}

// JSON文字列/オブジェクト → 正規化レコード配列
export function parseTheparkJson(body, { label } = {}) {
  let arr;
  try {
    arr = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => {
    const { unitCharges, maxFees } = parsePrice(p.price);
    // ザ・パークの JSON は lat/lng フィールドが逆（"lng"に緯度, "lat"に経度）
    const lat = Number(p.lng) || null;
    const lng = Number(p.lat) || null;
    return {
      operator: "thepark",
      parkId: String(p.id),
      label: label ?? null,
      name: p.name ?? null,
      address: p.address ?? null,
      lat,
      lng,
      capacity: p.car_cnt ? Number(p.car_cnt) || null : null,
      openingHours: null,
      unitCharges,
      maxFees,
      sourceUrl: "https://www.dkparking.com/search.html",
    };
  });
}
