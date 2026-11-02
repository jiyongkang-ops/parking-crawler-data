// SANパーク（パイン株式会社・sanpark.jp）の一覧・詳細ページのパーサ（2026-11-02 追加） ---------------------------------
// 全件は、ブラウザで探すときと同じ3段でたどる（sanpark-enumerate.js）:
//   ① 都県ごとの市区の選択肢 /lib/search_park/select_city.html$/area/{tokyo|kanagawa|saitama|chiba}/（検索画面が読み込むもの）
//   ② 市区ごとの一覧 /search/{市区}/?chk[count_car][min]=1 … 車の台数が1台以上の物件だけ（駐輪場だけの所を外す）。
//      表に名前・所在地と、地図用の data.push({lat, lng, url}) が並ぶ。料金は無い
//   ③ 物件ページ /search/{市区}/{番号}/ … 表（th/td）に 所在地・駐車場台数（「車:6台」）・時間料金・最大料金・緯度経度
//      最大料金は1つの td に「【月-土】12時間最大1,900円　【日祝】12時間最大1,000円　【全日】夜間（19時～8時）最大400円」と並ぶ
// 物件の番号は「市区/番号」（例 56fa1b050e088/459）。物件ページの URL の形のままにする（一覧・巡回の状態・記録で同じ番号）。
// 名前は一覧・物件ページでは「東池袋　2」の形で、ブランド名が付かない。Parkopedia は「SANパーク東池袋2」と書く
// （事業者名は「パイン株式会社」で、Advisor の事業者名の照合は効かない）。名前で同じ駐車場と分かるよう、
// 「SANパーク」＋空白を除いた名前にする。「ECO〜」（ECOパーク）はそのまま、「マンスリー〜」は月極だけなので記録しない（2026-11-01 の点検）。
// robots.txt は 404（制限なし）。サイトの利用規約は無い。

import { parseFeeBlock, strip } from "./jp-fee-text.js";

const BASE = "https://sanpark.jp";
export const SANPARK_AREAS = ["tokyo", "kanagawa", "saitama", "chiba"];

export function cityOptionsUrl(area) {
  return `${BASE}/lib/search_park/select_city.html$/area/${area}/`;
}
/** 市区の一覧（車の台数が1台以上の物件だけ）。city は「56fa1b050e088」「tokyo/chuo」の形 */
export function cityListUrl(city) {
  return `${BASE}/search/${city}/?chk%5Bcount_car%5D%5Bmin%5D=1`;
}
export function detailUrl(id) {
  return `${BASE}/search/${id}/`;
}

/** 市区の選択肢 → 市区（「/search/56fa1b050e088/」の 56fa1b050e088 の部分） */
export function parseCityOptions(html) {
  return [...new Set([...String(html ?? "").matchAll(/<option\s+value="\/search\/([^"?#]+?)\/?"/g)].map((m) => m[1]))];
}

/** 名前の空白を除く（「東池袋　2」→「東池袋2」） */
const tight = (s) => String(s ?? "").replace(/[\s　]+/g, "").trim();

/** 一覧・物件ページの名前 → 記録しない理由。記録するなら null */
export function skipReasonOfName(name) {
  const n = tight(name);
  if (!n) return "名前なし";
  if (/^マンスリー/.test(n)) return "月極";
  if (/駐輪|バイク|自転車/.test(n)) return "駐輪場";
  if (/近日(?:OPEN|オープン|開業)|OPEN予定|オープン予定/i.test(n)) return "近日オープン";
  return null;
}

/** 一覧・物件ページの名前 → 記録する名前。「ECO〜」（ECOパーク）と、自分の名前を持つ物件（「ホワイトジュエルＫパーキング」
 *  「システムパーク中野松ヶ丘 1」「岡田駐車場」）はそのまま、ほか（「東池袋　2」の形）は「SANパーク」＋名前 */
export function sanparkName(name) {
  const n = tight(name).normalize("NFKC");
  if (!n) return null;
  if (/^ECO/i.test(n) || /パーク|パーキング|駐車場|parking/i.test(n)) return n;
  return `SANパーク${n}`;
}

/** 市区の一覧 → { rows: [{ id, name, address, lat, lng }], total（「該当件数 N 件」）} */
export function parseSanparkList(html) {
  const s = String(html ?? "");
  const rows = [];
  for (const tr of s.matchAll(/<tr>\s*<td class="sp">([\s\S]*?)<\/tr>/g)) {
    const body = tr[1];
    const geo = body.match(/data\.push\(\{\s*lat:\s*(-?[\d.]+)\s*,\s*lng:\s*(-?[\d.]+)\s*,\s*url:\s*'\/search\/([^']+?)\/?'\s*\}\)/);
    const id = geo?.[3] ?? body.match(/href="\/search\/([^"]+?\/\d+)\/?"/)?.[1];
    if (!id) continue;
    const tds = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    rows.push({ id, name: tds[0] || null, address: tds[1] || null,
      lat: geo ? Number(geo[1]) : null, lng: geo ? Number(geo[2]) : null });
  }
  const t = s.match(/該当件数\s*(?:<[^>]+>\s*)*([\d,]+)\s*(?:<[^>]+>\s*)*件/);
  return { rows, total: t ? Number(t[1].replace(/,/g, "")) : null };
}

/** 物件ページの表の td（th のラベルで引く） */
function cell(html, label) {
  const m = String(html).match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>\\s*</tr>`));
  return m ? m[1] : null;
}

// 金額の後ろで項目を分ける。「24時間最大1100円 夜間(19時～9時)最大450円」「24時間600円夜間（17時～8時）300円」のように
// 1つの td に項目が続けて書かれる。そのまま渡すと、後ろの項目の時間帯が前の項目にも付く（「3時間最大1800円」が夜間の上限になる）。
// 金額のすぐ後ろのかっこ（「（税込）」）や注記は分けない
const ITEM_SPLIT = /(?<=円)\s*(?![\s)）(（\/／※・,、]|$)/;

/** 見出し（【…】の中）→ 区分。null は記録しない項目（自転車・バイク） */
export function sanparkScope(head) {
  if (head == null) return "全日";
  // 「月‐金」（U+2010）と「月-金」が混ざるのでそろえる
  let h = String(head).normalize("NFKC").replace(/\s+/g, "").replace(/[‐‑–—−]/g, "-");
  if (/^(?:自転車|バイク|原付|二輪)/.test(h)) return null;
  // 「車」「全車室」「1-3番車室」「月～土1.3番」… 車種と車室の注記は区分ではない（同じ帯の上限は低い方が効く）
  h = h.replace(/^(?:自動車|車)[・:]?/, "").replace(/全車室/, "").replace(/[\d.,・･\-‐~～]*\d番(?:車室)?(?:のみ)?/g, "");
  return h || "全日";
}

/** 料金の td → parseFeeBlock が読める行（「【月-土】12時間最大1,900円」）。区分の無い項目は前の見出しの区分を引き継ぐ
 *  （parseFeeBlock と同じ読み方）。自転車・バイクの項目は落とす。「オールタイム」は時間帯の無い単価の書き方なので落とす */
export function sanparkFeeLines(td) {
  let t = String(td ?? "")
    .replace(/<div[^>]*id="bikespace_promobanner"[\s\S]*$/i, " ")   // 時間料金の後ろのバイク置き場の案内（隠し要素）
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, " ");
  t = strip(t).replace(/オールタイム\s*/g, "");
  const out = [];
  let scope = "全日";
  for (const seg of t.split(/(?=【)/)) {
    const hm = seg.match(/^【([^】]*)】/);
    if (hm) scope = sanparkScope(hm[1]);
    const rest = hm ? seg.slice(hm[0].length) : seg;
    for (const item of rest.split(ITEM_SPLIT).map((x) => x.trim()).filter(Boolean)) {
      if (scope == null || !/円/.test(item)) continue;
      out.push(`【${scope}】${item}`);
    }
  }
  return out;
}

/** 物件ページ → 記録の形。記録しない物件は { skip: 理由 } を返す（run.js が記録せずに、閉鎖（404）と同じく寝かせる） */
export function parseSanparkDetail(html, { id } = {}) {
  const s = String(html ?? "");
  const rawName = strip(s.match(/<span itemprop="name">([\s\S]*?)<\/span>/)?.[1] ?? s.match(/<h2 class="cont_h">([\s\S]*?)<\/h2>/)?.[1] ?? "");
  if (!rawName) return null;   // 物件ページの作りではない（run.js が「名前が読めない」として数える）
  const why = skipReasonOfName(rawName);
  if (why) return { skip: why, name: rawName };
  if (/近日(?:OPEN|オープン|開業)|OPEN予定|オープン予定/i.test(strip(s.match(/<div id="mainC">([\s\S]*?)<div class="search_data/)?.[1] ?? ""))) {
    return { skip: "近日オープン", name: rawName };
  }
  const unitLines = sanparkFeeLines(cell(s, "時間料金"));
  const all = parseFeeBlock(unitLines.join("\n")).unitCharges;
  // 「24時間600円」（ECOパーク）は1日ごとの料金で、時間あたりの単価ではない。単価にすると 25円/時 のように周辺の単価の
  // 相場を下げるので採らない（三菱地所パークスの「1000円 / 24時間」と同じ扱い。mecparks.js）
  const unitCharges = all.filter((u) => u.perMinutes < 1440);
  // 時間料金の文が無い（月極だけ・駐輪場だけ・1日単位だけ）物件は記録しない。料金の無いクロールの物件があると、Advisor が
  // 同じ場所の Parkopedia の物件（料金あり）を重複として落とし、相場から料金が消える
  if (!unitCharges.length) return { skip: all.length ? "1日単位の料金だけ" : "時間料金なし", name: rawName };
  const { maxFees } = parseFeeBlock(sanparkFeeLines(cell(s, "最大料金")).join("\n"), "max");

  const capText = strip(cell(s, "駐車場台数") ?? "");
  const cap = capText.match(/車\s*[:：]\s*(\d+)\s*台/) ?? capText.match(/(\d+)\s*台/);
  const lat = Number(s.match(/itemprop="geo\.latitude">\s*(-?[\d.]+)/)?.[1]);
  const lng = Number(s.match(/itemprop="geo\.longitude">\s*(-?[\d.]+)/)?.[1]);
  const address = strip(s.match(/<span itemprop="address">([\s\S]*?)<\/span>/)?.[1] ?? cell(s, "所在地") ?? "") || null;
  return {
    operator: "sanpark",
    parkId: String(id),
    label: null,
    name: sanparkName(rawName),
    address,
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    capacity: cap ? Number(cap[1]) : null,
    openingHours: null,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
