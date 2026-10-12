# 校園設備報修系統

這是一個適合 MIS 課堂使用的最小前後端範例。學生透過網頁表單建立報修單，Flask 後端接收 JSON 資料、產生案件編號，再將結果回傳網頁。而目前報修系統缺乏維修時段預約與案件取消功能，且報修者送出報修單後無法指定維修時間，管理者也無法預先安排時段，需另外聯絡確認，容易造成溝通不便與時段衝突。此外，前台案件清單直接顯示報修者的姓名與電話，存在個資外洩風險，為改善上述問題，系統新增維修時段預約、個資遮蔽及案件取消功能。管理者可預先開放每小時一個的維修時段，並可一次新增半天的時段；報修者送單時僅能選擇尚未被預約的時段，確保每個時段僅供一人預約。前台僅顯示遮蔽後的姓名，不公開電話；報修者若需取消預約，可輸入送單時填寫的電話進行驗證，取消成功後將釋出時段，供其他人預約。

## 系統需求

- Windows 10/11
- Python 3.13.x
- 瀏覽器（Edge、Chrome 皆可）

## 第一次啟動

在此專案資料夾開啟 PowerShell，依序執行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

看到下列訊息後，以瀏覽器開啟 <http://127.0.0.1:5000>：

```text
Running on http://127.0.0.1:5000
```

按 `Ctrl + C` 可停止伺服器。

管理後台位址為 <http://127.0.0.1:5000/admin>。可在此查看案件並更新狀態。

## 第二次以後啟動

```powershell
.\.venv\Scripts\python.exe app.py
```

## 觀察重點

1. 在 `templates/index.html` 找到表單欄位。
2. 在 `static/app.js` 找到 `fetch("/api/tickets")`：前端在這裡呼叫後端 API。
3. 在 `app.py` 找到 `@app.post("/api/tickets")`：Python 在這裡接收、驗證並回傳資料。
4. 在 `templates/admin.html` 與 `static/admin.js` 看管理員如何透過 `PATCH /api/tickets/<案件編號>` 更新狀態。

## 注意事項

本範例把案件資料存在 Python 的記憶體中，停止或重啟程式後，資料會清空。
