# ユアー・パーキングの一覧の置き場（月1回・人が置く）

ユアー・パーキングの地図（waxds.com）は、クラウド（GitHub・Google Cloud）からのアクセスを止めているので、自動の巡回では取れません。
月1回、人がふつうにブラウザで一覧を開いて保存し、このフォルダに置くと、`import-ypark` のワークフローが取り込みます（2026-11-09）。
一覧には料金が無いので、名前・住所・台数・場所だけが入ります。料金は Parkopedia で補います。

## 手順（5分ほど）

1. ブラウザ（Chrome など）で、次のアドレスを開きます。地図が日本全体を表示したときに読む一覧と同じものです。
   https://www.waxds.com/ypark/mapc.php?crud=getallpoint&areaid=undefined&neLat=46&neLng=146&swLat=24&swLng=122
2. 文字（`[{"id":"…` で始まる一覧）が表示されたら、⌘S（Windows は Ctrl+S）で保存します。名前は何でもかまいません
   （例: `ypark-2026-12.json`）。
3. GitHub の https://github.com/jiyongkang-ops/parking-crawler-data/tree/main/data/ypark-inbox を開き、
   「Add file」→「Upload files」で保存したファイルを置いて「Commit changes」を押します。
4. 数分で `import-ypark` のワークフローが動き、取り込んだあと置いたファイルを消します。
   取り込んだ件数は、Actions の import-ypark の記録と、Advisor の朝の知らせ（health の import-ypark）で見られます。

## 決まり
- 地図の一覧を1回開くだけにします。物件ページを1件ずつ開いて料金を集めることはしません（自動でも手でも）。
- 置くのは、そのとき保存した一覧のファイル1つだけです。このフォルダの README.md は消さないでください。
