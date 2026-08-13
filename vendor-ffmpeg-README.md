# ⚠️ 此檔案與 vendor/ffmpeg/ 資料夾已不再需要

先前為了排查 FFmpeg.wasm 卡住的問題，一度改成自行代管核心檔案
（放在 vendor/ffmpeg/ 資料夾底下）。經過多輪測試後確認：問題其實出在
`@ffmpeg/ffmpeg` 0.12.x 版本的內部架構（classWorker 交握機制）在此
環境下會無聲卡住，跟自行代管與否無關。

最終解法是改用架構完全不同的舊版 `@ffmpeg/ffmpeg@0.11.6`，這個版本
內部自己處理 Worker 建立，直接透過 CDN 網址載入即可正常運作，
不再需要自行下載、代管任何核心檔案。

**你可以刪除 `vendor/` 這整個資料夾，不會影響任何功能。**
`workers/ffmpeg-worker.js` 已經改成直接從 CDN
（unpkg.com/@ffmpeg/ffmpeg@0.11.6、unpkg.com/@ffmpeg/core@0.11.0）
載入，不會再去讀取本機的 vendor 檔案。
