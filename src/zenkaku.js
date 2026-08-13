// 全角→半角・HTML実体参照・タグ除去の共通ヘルパ -----------------------------
// 日本の駐車場サイトは「２４時間：４００円」「12ｈ500円」のように全角数字・全角
// コロン・全角英字を多用する。パース前にここで半角へ寄せてから正規表現をかける。

// U+FF01(！)〜U+FF5E(～) は ASCII の U+0021〜U+007E と 0xFEE0 差でそのまま対応する。
// これで ０-９ / Ａ-Ｚ / ａ-ｚ / ： / （） / ／ / ， / ．/ ～ がまとめて半角化される。
export function toHalfWidth(s) {
  if (s == null) return s;
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[〜∼]/g, "~") // 波ダッシュ・チルダ類（U+301C など）
    // 各種ダッシュ。長音記号 ー(U+30FC) は日本語の一部なので絶対に変換しない。
    .replace(/[―‐‒–—]/g, "-")
    .replace(/　/g, " "); // 全角スペース
}

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  yen: "¥", middot: "・", minus: "-", ndash: "-", mdash: "-", times: "x",
  hellip: "...", deg: "度", sup2: "2", sup3: "3", frac12: "1/2", bull: "・",
};

export function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// タグを除去し、実体参照を戻し、全角を半角化して空白を畳む。
export function textOf(html) {
  if (html == null) return null;
  const t = toHalfWidth(decodeEntities(String(html).replace(/<[^>]+>/g, " ")))
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

// <br> を \n に変換したうえで textOf 相当の正規化を行い、行配列を返す。
export function linesOf(html) {
  if (html == null) return [];
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|tr|div)>/gi, "\n")
    .split("\n")
    .map((l) => textOf(l))
    .filter((l) => l);
}

// "8:00~20:00" / "8:00-20:00" / "20-8時" を "8:00-20:00" 形式へ。無ければ null。
export function timeRangeOf(text) {
  const t = toHalfWidth(text || "");
  const hm = t.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(\d{1,2}):(\d{2})/);
  if (hm) return `${Number(hm[1])}:${hm[2]}-${Number(hm[3])}:${hm[4]}`;
  const h = t.match(/(\d{1,2})\s*(?:時)?\s*[~\-]\s*(\d{1,2})\s*時/);
  if (h) return `${Number(h[1])}:00-${Number(h[2])}:00`;
  return null;
}

// "平日" / "土日祝" / "全日" のいずれかへ寄せる。
export function scopeOf(text) {
  const t = (text || "").replace(/\s+/g, "");
  if (/土日祝|土・日・祝|日祝|土日|休日/.test(t)) return "土日祝";
  if (/平日/.test(t)) return "平日";
  return "全日";
}

export const yen = (s) => Number(String(s).replace(/,/g, ""));
