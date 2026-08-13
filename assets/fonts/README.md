# NotoSansTC-Regular.ttf 字型說明

## 目前狀態：已是可正式使用的真實字型檔案

此檔案是從 Google Fonts 官方 [Noto Sans TC](https://fonts.google.com/noto/specimen/Noto+Sans+TC)
可變字型（variable font）萃取出 Regular（wght=400）靜態實例，再用
[fonttools](https://github.com/fonttools/fonttools) 裁切到常用範圍
（Basic Latin、標點、全形符號、CJK Unified Ideographs 主要區塊）後產出，
約 5.5MB。已實際測試內嵌進 pdf-lib 產出的 PDF，中文、標點、中英混排皆能
正確顯示，不會缺字。

## ⚠️ 極重要：pdf-worker.js 內嵌這個字型時，必須使用 `{ subset: false }`

**不可以**改回 `{ subset: true }`。

原因：實測發現 `pdf-lib`（底層透過 `@pdf-lib/fontkit` 做執行階段子集化）
對這個字型檔案的複合字符（composite glyph，中文字形有大量是透過「引用
其他字形部件組合而成」的方式儲存，例如「測」由部首與聲符組合構成）在
子集化時處理有 bug：子集化完成後，PDF 檔案「表面上產生成功、不會拋出
任何錯誤」，但實際打開一看，會發現大量常用字直接消失、變成空白，且
`pdftotext` 這類文字擷取工具依然能正確讀出隱藏在 PDF 裡的文字內容
（代表文字資料本身沒壞，只是對應的字形圖案沒有被正確畫出來）——這是
非常隱蔽的問題，只從程式碼或錯誤訊息完全看不出來，必須實際渲染出 PDF
畫面才會發現。

因為這個原因，字型裁切這件事已經在「建置階段」透過 fonttools 事先做好
（就是你現在看到的這個已裁切過的檔案），執行階段改用
`pdfDoc.embedFont(fontBytes, { subset: false })` 直接整份內嵌，
不再依賴 pdf-lib 的執行階段子集化邏輯。

## 若要重新產生這個檔案（例如想換字重、換字族、或縮小體積）

```bash
# 1. 下載官方可變字型
curl -L -o NotoSansTC-var.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf"

# 2. 安裝 fonttools
pip install fonttools --break-system-packages

# 3. 萃取出 Regular（wght=400）靜態實例
fonttools varLib.instancer -o NotoSansTC-Regular-static.ttf NotoSansTC-var.ttf wght=400

# 4. 裁切到常用字範圍（可依需求調整 --unicodes 範圍）
fonttools subset NotoSansTC-Regular-static.ttf \
  --output-file=NotoSansTC-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2000-206F,U+3000-303F,U+FF00-FFEF,U+4E00-9FFF" \
  --no-hinting --desubroutinize --drop-tables+=DSIG
```

產生後務必：
1. 用 `pdf-lib` + `@pdf-lib/fontkit` 搭配 `{ subset: false }` 實際內嵌一份
   測試 PDF，打開來目視確認中文正確顯示（不要只看程式沒有噴錯就假設
   沒問題——如上所述，這個 bug 不會拋出任何錯誤）。
2. 調高 `font-cache-manager.js` 內的 `FONT_CONTENT_VERSION` 常數，
   否則已經快取過舊字型的使用者瀏覽器不會自動重新下載新版本。
3. 若檔案體積有明顯變化，同步調整 `font-cache-manager.js` 內用來估算
   下載百分比的除數常數，以及 `index.html` Modal 文案裡的「約 X MB」字樣。
