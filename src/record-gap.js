// 料金が変わっていなくても、前の記録に無かった名前・住所・座標が読めたら、料金の記録に1回だけ足す ------------
// 料金の記録（prices*.jsonl）は「新規か、料金が変わったとき」しか追記しない（run.js の handleRecord）。そのため、
// 最初の行で名前・住所・座標が読めなかった物件は、あとで読めるようになっても料金が変わるまで記録に残らず、
// 座標が付かないので Advisor の相場に入らなかった（エコロの76件は毎回取れているのに、住所が一度も入っていなかった。2026-10-18）。
// 行が増えすぎないよう、「無かったものが入ったとき」だけにする（値が変わっただけでは足さない）。

/** 住所らしいか（都道府県・市区町村郡のどれかの字を含む）。空・物件名だけのものは住所とみなさない */
export const looksLikeAddress = (s) => typeof s === "string" && /[都道府県市区町村郡]/.test(s);

const coordOk = (v) => v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) !== 0;
/** 座標があるか（0,0 は「無い」と同じ。名鉄協商の掲載終了の雛形が 0,0 を出す） */
export const hasCoord = (r) => !!r && coordOk(r.lat) && coordOk(r.lng);

/** 前の記録 prev に無く、今回の rec で読めたもの（"名前・住所" など）。足すものが無ければ null。
 *  coords … 座標も見るか。満空のある社（タイムズ・リパーク・NPC）は座標を満空の控え（vacancy-lots.jsonl）に
 *  持っているので見ない（見ると prices-times.jsonl だけで約2万行増える） */
export function gapFilled(prev, rec, { coords = true } = {}) {
  if (!prev || !rec) return null;
  const got = [];
  if (!prev.name && rec.name) got.push("名前");
  if (!looksLikeAddress(prev.address) && looksLikeAddress(rec.address)) got.push("住所");
  if (coords && !hasCoord(prev) && hasCoord(rec)) got.push("座標");
  return got.length ? got.join("・") : null;
}
