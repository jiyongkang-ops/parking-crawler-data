// Dパーキング（大和ハウスパーキング / dh-parking.co.jp）一覧型パーサ ----------------------------------------------
// 2026-11-27 本人「新しい社は Dパーキングから作ってよい」「画面に出ている項目だけ取る」。
//
// 駐車場を探すページ（https://www.dh-parking.co.jp/d-parking/parking_list/ に埋め込まれた /data/）は、
// /data/assets/data/parking.filtered.json（約53MB・約8,400件。社内のシステムから書き出したもの）を1回読み、
// ページの中で絞り込んで（下の shown）、名前・住所・地図の位置だけを並べている。
// 料金・台数の欄もファイルには入っているが、画面には出していない（台数・料金の欄は styleMode 2 のときだけ・
// 項目の一覧は CSS で display:none。2026-11-27 にページの JS と CSS で確かめた）。
// そこで、記録するのは画面に出ている「名前・住所・位置」だけにする。料金・台数・社内の項目（拠点・地番など）は記録しない。
// 料金は Advisor が Parkopedia の料金で補う（pk-dedupe の mergeWithPk。ユアー・パーキングと同じ形）。
// 絞り込みに使う欄（論理削除フラグ・収入区分・時間貸の台数・開設確定日・閉鎖日）はページと同じ決まりで読むだけで、記録しない。
//
// robots.txt は無い（404）＝制限なし。免責事項（/company/terms/）に自動収集・転載を禁止する文は無い（2026-11-27 確認）。
// ファイルは大きく、中身はたまにしか変わらない（2026-10-23 のまま）ので、週1回だけ読む（run.js の Dパーキング）。

export const DATA_URL = "https://www.dh-parking.co.jp/data/assets/data/parking.filtered.json";
export const PAGE_URL = "https://www.dh-parking.co.jp/d-parking/parking_list/";

// 記録の読み方の版。読み方を変えたら上げる
export const PARSE_VERSION = 1;

// ページの収入区分の決まり（incomeCategoryAllowList）。直営と管理受託だけが画面に出る（機械の保守だけを請けている他社の駐車場は出ない）
const INCOME_OK = ["直営", "管理受託(固定業務委託)", "管理受託(固定+変動委託)"];
const JAPAN = { minLat: 24, maxLat: 46, minLng: 122, maxLng: 146 };

/** ページの getFieldValue と同じ: 欄の value を文字にして前後の空白を落とす（配列は「,」でつなぐ） */
const fv = (rec, k) => {
  const v = rec?.[k]?.value;
  return v === null || v === undefined ? "" : String(v).trim();
};
const nfkc = (s) => String(s ?? "").normalize("NFKC").trim();
const num = (s) => { const t = nfkc(s).replace(/,/g, ""); if (!t) return 0; const n = Number(t); return Number.isFinite(n) ? n : 0; };
const coord = (s) => { const t = nfkc(s).replace(/,/g, ""); if (!t) return NaN; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
/** 日付（YYYY-MM-DD・YYYY/M/D・ISO）→ "YYYY-MM-DD"。読めなければ null */
const ymd = (s) => {
  const t = nfkc(s);
  if (!t) return null;
  const m = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const flagSet = (s) => { const t = nfkc(s).toLowerCase(); return !!t && t !== "0" && t !== "false"; };
const incomeOk = (s) => nfkc(s).split(",").map(nfkc).filter(Boolean).some((x) => INCOME_OK.includes(x));

/** ページに出る物件か（ページの matchesRecordConditions と同じ）。today は日本時間の "YYYY-MM-DD"。出ないときは理由 */
export function hiddenReason(rec, today) {
  if (flagSet(fv(rec, "論理削除フラグ"))) return "削除";
  if (!incomeOk(fv(rec, "収入区分"))) return "収入区分";              // 機械の保守だけ・月極など
  if (num(fv(rec, "四輪_時間貸")) + num(fv(rec, "自動二輪_時間貸")) < 1) return "時間貸なし";
  const open = ymd(fv(rec, "開設確定日"));
  if (!open || open > today) return "開設前";
  const closeRaw = rec?.["閉鎖日"]?.value;
  if (closeRaw !== null && closeRaw !== undefined && String(closeRaw).trim() !== "") {
    const close = ymd(fv(rec, "閉鎖日"));
    if (!close || close < today) return "閉鎖";
  }
  return null;
}

/** ページの buildParkingTitle と同じ名前（ブランド名＋物件名称。ブランドが「その他」ならその他の欄）。半角カナは NFKC で全角に */
function titleOf(rec) {
  const brand = fv(rec, "ブランド名");
  const label = nfkc(brand) === "その他" ? fv(rec, "ブランド名_その他") : brand;
  return nfkc([label, fv(rec, "物件名称")].filter(Boolean).join(" ")) || null;
}

/** 元データ（JSON の文字列かオブジェクト）→ { records, total, hidden: {理由: 件数} }。形が違えば null。
 *  records は画面に出る物件だけ・画面に出る項目（名前・住所・位置）だけ */
export function parseDparkingData(body, { today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), label = "Dパーキング全国" } = {}) {
  let j;
  try { j = typeof body === "string" ? JSON.parse(body) : body; } catch { return null; }
  const rows = Array.isArray(j) ? j : Array.isArray(j?.records) ? j.records : null;
  if (!rows) return null;
  const records = [], hidden = {};
  for (const rec of rows) {
    const why = hiddenReason(rec, today);
    if (why) { hidden[why] = (hidden[why] ?? 0) + 1; continue; }
    const parkId = fv(rec, "$id");
    if (!parkId) { hidden["番号なし"] = (hidden["番号なし"] ?? 0) + 1; continue; }
    const lat = coord(fv(rec, "緯度")), lng = coord(fv(rec, "経度"));
    const okGeo = lat && lng && lat >= JAPAN.minLat && lat <= JAPAN.maxLat && lng >= JAPAN.minLng && lng <= JAPAN.maxLng;
    records.push({
      operator: "dparking",
      parkId,
      label,
      name: titleOf(rec),
      address: nfkc(fv(rec, "地図表示用_所在地")) || null,
      lat: okGeo ? lat : null,
      lng: okGeo ? lng : null,
      datum: "wgs84",
      capacity: null,          // 画面に出していない
      openingHours: null,
      hourlyOk: true,          // 時間貸の区画がある物件だけが画面に出る（分析側が「月極だけ」とみなさないように）
      unitCharges: [],         // 画面に出していない（料金は Advisor が Parkopedia で補う）
      maxFees: [],
      parseV: PARSE_VERSION,
      sourceUrl: PAGE_URL,
    });
  }
  return { records, total: rows.length, hidden };
}
