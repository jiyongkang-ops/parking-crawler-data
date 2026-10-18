// タイムズの詳細ページから住所を読むところのテスト（npm test）。事業者サイトには繋がない。
// 2026-10-18: 名前にかっこがある施設（「タイムズJR札幌病院（上層階）」など）で、題名の最初のかっこ
// （「上層階」「平面」「第２」「B1」など）を住所として保存していた（最新の行で344件）。
// ページ全体の HTML はリポジトリに入れず、題名・見出し・住所の行など必要な部分だけを書く。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTimesDetail, timesTitleAddress, timesBodyAddress } from "../src/times.js";

const SUFFIX = "の時間貸駐車場・満車/空車・料金情報 ｜タイムズ駐車場検索";
const URL = "https://times-info.net/P01-hokkaido/C101/park-detail-BUK0000001/";
// 題名と見出しだけのページ（本文の住所の行が無い作りでも題名から読めることを確かめる）
const page = (title, h1) => `<html><head><title>${title}</title></head><body>`
  + (h1 ? `<h1 class="c-topInfo_ttl">${h1}</h1>` : "") + "</body></html>";
// 本文「基本情報」の住所の行（2026-10-18 に実ページで確かめた形）
const addressRow = (region, locality, street) => `
  <table class="p-basicInfo_table">
    <!--住所-->
    <tr class="p-basicInfo_table_tr">
      <th class="p-basicInfo_table_th">住所</th>
      <td class="p-basicInfo_table_td">
        <p class="p-basicInfo_table_td_address">
          <span class="p-basicInfo_table_td_address_txt">
            <span itemprop="addressRegion">${region}</span><span itemprop="addressLocality">${locality}</span><span itemprop="streetAddress">${street}</span>

          </span>
          <a id="s_showMap" class="p-basicInfo_table_td_maplink" href="#d_page_map"><img class="p-basicInfo_table_td_maplink_img" src="/x.png" alt="地図を見る" /></a>
        </p>
      </td>
    </tr>
  </table>`;
// 以前の読み方（題名の最初のかっこ）
const oldAddress = (title) => (title.match(/^(.+?)[（(](.+?)[)）]/) || [])[2] ?? null;

test("普通の題名「名前（都道府県…）の時間貸駐車場」は今までと同じ結果になる", () => {
  for (const [name, addr] of [
    ["タイムズ南３西２", "北海道札幌市中央区南３条西2-5"],
    ["タイムズステーション札幌すすきの", "北海道札幌市中央区南４条西6-5"],
    ["タイムズ京都府立医大病院北", "京都府京都市上京区栄町"],
    ["タイムズ柏の葉", "千葉県柏市若柴178-4"],
  ]) {
    const title = `${name}（${addr}）${SUFFIX}`;
    const r = parseTimesDetail(page(title, name), { url: URL });
    assert.equal(r.address, addr);
    assert.equal(r.address, oldAddress(title));
    assert.equal(r.name, name);
  }
});

test("かっこが2つの題名「名前（上層階）（北海道札幌市…）」は2つ目を住所にする", () => {
  const title = `タイムズJR札幌病院（上層階）（北海道札幌市中央区北３条東1-1）${SUFFIX}`;
  assert.equal(oldAddress(title), "上層階"); // 以前はこうなっていた
  const r = parseTimesDetail(page(title, "タイムズJR札幌病院（上層階）"), { url: URL });
  assert.equal(r.address, "北海道札幌市中央区北３条東1-1");
  assert.equal(r.name, "タイムズJR札幌病院（上層階）"); // 名前は見出しのまま
  // 見出しが無くても、名前は住所のかっこの前まで
  assert.equal(parseTimesDetail(page(title), { url: URL }).name, "タイムズJR札幌病院（上層階）");
  // 半角のかっこ・名前の途中のかっこ・かっこの後に続く名前
  assert.equal(timesTitleAddress(`タイムズ柏市役所第１駐車場(上)(千葉県柏市柏5-10-1)${SUFFIX}`).address, "千葉県柏市柏5-10-1");
  assert.equal(timesTitleAddress(`タイムズ（大本山）護国寺（東京都文京区大塚5-40-1）${SUFFIX}`).address, "東京都文京区大塚5-40-1");
  assert.equal(timesTitleAddress(`タイムズ諏訪赤十字病院第１（外来）駐車場（長野県諏訪市湖岸通り5-11-50）${SUFFIX}`).address,
    "長野県諏訪市湖岸通り5-11-50");
});

test("住所の無い題名「名前（第２）の時間貸…」は null になる", () => {
  for (const label of ["第２", "上層階", "平面", "屋上", "Ｂ１", "B1・B2", "南", "４Ｆ、ＲＦ", "Ｐ１", "バス", "二輪",
    "京都市総合教育センター", "西宮市立北口", "さがみ信用金庫緑町支店", "京都府立医科大学", "ﾊｲﾙｰﾌ満空配信用"]) {
    const title = `タイムズ東京都済生会中央病院（${label}）${SUFFIX}`;
    assert.equal(timesTitleAddress(title).address, null, label);
    assert.equal(parseTimesDetail(page(title, `タイムズ東京都済生会中央病院（${label}）`), { url: URL }).address, null, label);
  }
  assert.equal(parseTimesDetail(page(`タイムズ南３西２${SUFFIX}`, "タイムズ南３西２"), { url: URL }).address, null);
});

test("名前に都道府県で始まるかっこがあっても、「の時間貸」に近い住所を選ぶ", () => {
  assert.equal(timesTitleAddress(`タイムズ（京都府立医科大学）（京都府京都市上京区河原町通広小路上る梶井町465）${SUFFIX}`).address,
    "京都府京都市上京区河原町通広小路上る梶井町465");
  assert.equal(timesTitleAddress(`タイムズ（北海道札幌市）（北海道札幌市中央区北1条西2）${SUFFIX}`).address, "北海道札幌市中央区北1条西2");
});

test("住所の中のかっこで途中で切れない（以前は「北海道札幌市白石区本通（北」で切れていた）", () => {
  const title = `タイムズ本通２丁目北第２（北海道札幌市白石区本通（北）2丁目1-1）${SUFFIX}`;
  assert.equal(oldAddress(title), "北海道札幌市白石区本通（北");
  assert.equal(timesTitleAddress(title).address, "北海道札幌市白石区本通（北）2丁目1-1");
});

test("都道府県が無ければ、市区町村郡と番地のあるかっこを使う", () => {
  assert.equal(timesTitleAddress(`タイムズ大通（上層階）（札幌市中央区北3条西2）${SUFFIX}`).address, "札幌市中央区北3条西2");
  // 最後のかっこが市区町村で始まるだけなら、ゆるく住所とみなす
  assert.equal(timesTitleAddress(`タイムズ銀座（中央区銀座）${SUFFIX}`).address, "中央区銀座");
  // 「の時間貸」の直前でないかっこは、ゆるい形では住所にしない
  assert.equal(timesTitleAddress(`タイムズ（中央区）銀座${SUFFIX}`).address, null);
});

test("本文の住所の行があれば、それを使う", () => {
  const html = page(`タイムズJR札幌病院（上層階）（北海道札幌市中央区北３条東1-1）${SUFFIX}`, "タイムズJR札幌病院（上層階）")
    .replace("</body>", addressRow("北海道", "札幌市中央区", "北３条東1-1") + "</body>");
  assert.equal(timesBodyAddress(html), "北海道札幌市中央区北３条東1-1");
  assert.equal(parseTimesDetail(html, { url: URL }).address, "北海道札幌市中央区北３条東1-1");
  // 題名に住所が無くても本文から読める
  const noTitleAddr = page(`タイムズ東京都済生会中央病院（第２）${SUFFIX}`, "タイムズ東京都済生会中央病院（第２）")
    .replace("</body>", addressRow("東京都", "港区", "三田1-4-17") + "</body>");
  assert.equal(parseTimesDetail(noTitleAddr, { url: URL }).address, "東京都港区三田1-4-17");
  // 本文の行が住所らしくなければ題名から選ぶ
  const badRow = page(`タイムズ南３西２（北海道札幌市中央区南３条西2-5）${SUFFIX}`, "タイムズ南３西２")
    .replace("</body>", addressRow("", "", "－") + "</body>");
  assert.equal(timesBodyAddress(badRow), null);
  assert.equal(parseTimesDetail(badRow, { url: URL }).address, "北海道札幌市中央区南３条西2-5");
});

test("混み合っているページは料金の記録に書かない（例外で飛ばす）", () => {
  const busy = page("ただいま大変混み合っております", "ただいま大変混み合っております");
  assert.throws(() => parseTimesDetail(busy, { url: URL }), (e) => e.transient === true);
});
