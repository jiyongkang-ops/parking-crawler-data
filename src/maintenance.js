// 相手先のサイトのメンテナンスを見分ける（2026-10-24 週次の見直し） ----------------------------------------
// 10/22〜23 に名鉄協商・近鉄不動産・ザ・パーク・あなぶきの4社が「断られている（403）」「多すぎる（429）」と
// 記録されたが、実際は4社とも相手先のサイトが「緊急メンテナンス」「メンテナンス中」だった。
// メンテナンスの告知ページを 403・429 で返すサイトがあり、状態コードだけでは断られたのと区別できない。
// 断られたと取り違えると、朝のお知らせで「断られている」の欄に並び、止める判断を誤るおそれがある。
//
// 見分け方は**ページの題名（<title>・無ければ最初の見出し）だけ**で行う。普段のトップページにも
// 「システムメンテナンスのお知らせ（10/30）」のような見出しが本文に並ぶことはよくあるため、本文は見ない。

const RE = /メンテナンス|maintenance|一時停止|一時休止|サービス停止|システム停止|臨時休止|ただいま工事中/i;

/** ページの題名（<title>。無ければ最初の <h1>）がメンテナンスの告知なら、その題名を返す。違えば null */
export function maintenanceTitle(html) {
  const s = String(html ?? "").slice(0, 20000);
  const strip = (x) => x.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
  const title = strip(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const h1 = strip(s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const head = title || h1;
  return head && RE.test(head) ? head.slice(0, 60) : null;
}

/** 事業者のサイトの入口（トップページ）。巡回で失敗した事業者のメンテナンスを確かめるときに、ここを1回だけ見る */
export const ORIGINS = {
  anabuki: "https://www.anabuki-housing.co.jp", carshares: "https://www.carshares.jp", comnet: "https://comnet-p.co.jp",
  ecolo: "https://service.ecolocity.co.jp", gspark: "https://www.gs-park.com", jqparks: "https://www.parking-kyushu.jp",
  keio: "https://www.keiofudosan.co.jp", kintetsu: "https://parking.kintetsu-re.co.jp", kyotech: "https://kte.ne.jp",
  leparc: "https://sasp.mapion.co.jp", mden: "https://m-dentechno.co.jp", mkp: "https://mkp.jp",
  navipark: "https://www.navipark1.com", npc: "https://parking.npc-npc.co.jp", parknet: "https://parknet.shinmaywa.co.jp",
  repark: "https://www.repark.jp", seiwapark: "https://www.seiwapark.co.jp", systempark: "https://systempark.biz",
  tamapark: "https://www.tamapark.co.jp", thepark: "https://www.dkparking.com", times: "https://times-info.net",
  tokyulifia: "https://www.tokyulifia.co.jp",
  // 止めている社（space24・odakyu）は載せない。許可が出るまでトップにも行かない
};

/** メンテナンスを確かめる失敗の種類。取り違えが実際に起きた「断られた・多すぎる・0件」だけ。
 *  届かない（network・503・タイムアウト）は、もともと一時的な失敗として扱っていて取り違えても困らないので、入口を見に行かない
 *  （相手先の不調のあいだに1回でも多く送らないため）。止めている（paused）・閉鎖が一斉に出た（mass-gone）・一覧の作り直しも対象外 */
const CHECK = new Set(["blocked", "rate", "parse"]);

/** health の行のうち、失敗した事業者の入口を1回ずつ見て、メンテナンスなら kind と reason を書き換える。
 *  fetchTop(url) は politeFetch（robots.txt と間隔を守る）。同じ入口は1回の巡回で1回だけ見る。
 *  入口を見られなかった（robots.txt で断られた・届かない）ときは元の行のまま */
export async function markMaintenance(rows, fetchTop) {
  const seen = new Map();
  // 0件（parse）でも、送ったページの答えが閉鎖（404・410）中心なら閉鎖の扱いでメンテナンスではない。
  // 見に行くのは「ページは取れた（200）のに読めない」とき（パークネットは 200 の空のページを返していた）
  const mostlyGone = (r) => { const c = r.statusCounts ?? {}; const all = Object.values(c).reduce((a, b) => a + b, 0);
    return all > 0 && ((c["404"] ?? 0) + (c["410"] ?? 0)) * 2 >= all; };
  for (const r of rows) {
    if (r.ok || !CHECK.has(r.kind)) continue;
    if (r.kind === "parse" && mostlyGone(r)) continue;
    const origin = ORIGINS[r.op];
    if (!origin) continue;
    if (!seen.has(origin)) {
      let title = null;
      try {
        const res = await fetchTop(`${origin}/`);
        title = res?.maintenance ?? (res?.html ? maintenanceTitle(res.html) : null);
      } catch { /* 見られなければ元のまま */ }
      seen.set(origin, title);
    }
    const title = seen.get(origin);
    if (!title) continue;
    r.reason = `相手先のサイトがメンテナンス中（「${title}」）。この回は見送り（巡回の記録: ${r.reason ?? r.kind}）`;
    r.kind = "maintenance";
  }
  return rows;
}
