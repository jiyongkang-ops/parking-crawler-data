// 料金が変わっていなくても、前の記録に無かった名前・住所・座標が読めたら、料金の記録に1回だけ足す ------------
// 料金の記録（prices*.jsonl）は「新規か、料金が変わったとき」しか追記しない（run.js の handleRecord）。そのため、
// 最初の行で名前・住所・座標が読めなかった物件は、あとで読めるようになっても料金が変わるまで記録に残らず、
// 座標が付かないので Advisor の相場に入らなかった（エコロの76件は毎回取れているのに、住所が一度も入っていなかった。2026-10-18）。
// 行が増えすぎないよう、「無かったものが入ったとき」だけにする（値が変わっただけでは足さない）。
import { isAddressLike, isTruncatedAddress } from "./address-like.js";

/** 住所らしいか。タイムズの住所の読み取り（times.js）と同じ判定（src/address-like.js）。
 *  以前は「都道府県市区町村郡の字が1つでもあれば住所」としていたので、タイムズで題名のかっこを住所と取り違えた
 *  「京都市総合教育センター」「さがみ信用金庫緑町支店」「西宮市立北口」なども住所とみなし、正しい住所が読めても
 *  記録に残らなかった（5件。2026-10-18 点検）。空・物件名だけ・施設名は住所とみなさない */
export const looksLikeAddress = isAddressLike;

/** 住所として足りているか（住所らしく、途中で切れていない） */
const fullAddress = (s) => isAddressLike(s) && !isTruncatedAddress(s);

const coordOk = (v) => v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) !== 0;
/** 座標があるか（0,0 は「無い」と同じ。名鉄協商の掲載終了の雛形が 0,0 を出す） */
export const hasCoord = (r) => !!r && coordOk(r.lat) && coordOk(r.lng);

/** 前の記録 prev に無く、今回の rec で読めたもの（"名前・住所" など）。足すものが無ければ null。
 *  住所は「前が住所らしくない、または途中で切れている（かっこが閉じていない。例「北海道札幌市白石区本通（北」）」で、
 *  今回は途中で切れていない住所らしい住所」のときだけ足す。足したあとは前の記録が完全な住所になるので、2回目は足さない。
 *  coords … 座標も見るか。満空のある社（タイムズ・リパーク・NPC）は座標を満空の控え（vacancy-lots.jsonl）に
 *  持っているので見ない（見ると prices-times.jsonl だけで約2万行増える） */
export function gapFilled(prev, rec, { coords = true } = {}) {
  if (!prev || !rec) return null;
  const got = [];
  if (!prev.name && rec.name) got.push("名前");
  if (!fullAddress(prev.address) && fullAddress(rec.address)) got.push("住所");
  if (coords && !hasCoord(prev) && hasCoord(rec)) got.push("座標");
  return got.length ? got.join("・") : null;
}
