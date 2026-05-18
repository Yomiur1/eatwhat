# 🍽️ 今天吃什麼？— 部署指南

多人即時選餐廳 Web App，整合 Google Maps 真實餐廳資料 + Firebase 多人同步。

---

## 📦 技術架構

| 層面 | 技術 |
|------|------|
| 前端框架 | React 18 + Vite |
| 即時資料庫 | Firebase Realtime Database |
| 身份驗證 | Firebase Anonymous Auth |
| 餐廳搜尋 | Google Maps JavaScript API + Places API |
| 部署 | Vercel（免費）|

---

## 🚀 第一步：取得 API 金鑰

### A. Google Maps API Key

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案（或選擇現有的）
3. 側邊欄 → **API 和服務** → **程式庫**
4. 啟用以下兩個 API：
   - ✅ **Maps JavaScript API**
   - ✅ **Places API**
5. 側邊欄 → **憑證** → **建立憑證** → **API 金鑰**
6. 複製金鑰（建議設定「HTTP 推薦來源」限制到你的網域）

> ⚠️ Google Maps API 每月有免費額度（$200 USD），學生專案通常夠用。

---

### B. Firebase 設定

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 新增專案 → 輸入名稱（例：eatwhat）
3. **建立 Realtime Database**：
   - 左欄 → 建置 → Realtime Database → 建立資料庫
   - 選擇**測試模式**（開發用，之後再設規則）
   - 地區選 `asia-southeast1`
4. **啟用 Authentication**：
   - 左欄 → 建置 → Authentication → 開始使用
   - 登入方式 → 匿名 → 啟用
5. **取得設定值**：
   - 專案設定（齒輪圖示）→ 一般設定 → 你的應用程式
   - 點「</> 網頁」新增應用程式
   - 複製 `firebaseConfig` 裡的所有值

---

## 🛠️ 第二步：本地開發

```bash
# 1. 進入專案資料夾
cd eatwhat

# 2. 安裝依賴
npm install

# 3. 複製環境變數範本
cp .env.example .env

# 4. 編輯 .env，填入你的 API 金鑰（用文字編輯器開啟）
#    把所有「你的...」替換成真實的值

# 5. 啟動開發伺服器
npm run dev

# 瀏覽器開啟 http://localhost:5173
```

### .env 填寫範例

```env
VITE_GOOGLE_MAPS_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_FIREBASE_API_KEY=AIzaSyYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY
VITE_FIREBASE_AUTH_DOMAIN=eatwhat-abc12.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://eatwhat-abc12-default-rtdb.asia-southeast1.firebasedatabase.app
VITE_FIREBASE_PROJECT_ID=eatwhat-abc12
VITE_FIREBASE_STORAGE_BUCKET=eatwhat-abc12.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef1234567890
```

---

## ☁️ 第三步：部署到 Vercel（免費）

### 方法一：用 GitHub 部署（推薦）

```bash
# 1. 在 GitHub 建立新 repository（public 或 private 都可以）

# 2. 上傳程式碼（注意：.env 不要上傳！）
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/你的帳號/eatwhat.git
git push -u origin main
```

3. 前往 [vercel.com](https://vercel.com/) → 用 GitHub 登入
4. **New Project** → Import 你的 repository
5. **Environment Variables** → 把 `.env` 裡的所有項目一一加入
6. 點 **Deploy** 🎉

部署完成後會得到 `https://eatwhat-xxx.vercel.app` 的網址！

### 方法二：用 Vercel CLI

```bash
npm install -g vercel
vercel login
vercel          # 跟著步驟走，第一次部署
vercel --prod   # 之後更新
```

---

## 🔒 第四步：Firebase 安全規則（上線前設定）

Firebase Console → Realtime Database → 規則，貼上：

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": "auth != null",
        "members": {
          "$uid": {
            ".write": "$uid === auth.uid"
          }
        },
        "votes": {
          "$uid": {
            ".write": "$uid === auth.uid",
            ".read": "auth != null"
          }
        }
      }
    }
  }
}
```

---

## 🗺️ Google Maps API 金鑰限制（建議）

部署後在 Google Cloud Console → 憑證 → 你的金鑰 → 新增「HTTP 推薦來源」：

```
https://eatwhat-xxx.vercel.app/*
http://localhost:5173/*
```

---

## 🐛 常見問題

| 問題 | 原因 | 解決方法 |
|------|------|----------|
| 地圖不顯示 | API 金鑰錯誤 | 確認 .env 的 VITE_GOOGLE_MAPS_API_KEY |
| 找不到餐廳 | Places API 未啟用 | 確認啟用了 Places API |
| 登入失敗 | Firebase 設定錯誤 | 確認 .env 的 Firebase 值都正確 |
| 房間同步失敗 | Database URL 錯誤 | 確認 VITE_FIREBASE_DATABASE_URL 結尾沒有 `/` |
| GPS 無法取得 | HTTPS 要求 | 本機開發用 localhost，部署後用 Vercel 的 HTTPS 網址 |

---

## 📁 專案結構

```
eatwhat/
├── src/
│   ├── App.jsx          ← 主程式（所有畫面）
│   ├── firebase.js      ← Firebase 初始化
│   └── main.jsx         ← React 入口點
├── index.html
├── vite.config.js
├── package.json
├── .env                 ← 你的 API 金鑰（不要上傳到 GitHub）
├── .env.example         ← 金鑰範本（可以上傳）
└── .gitignore
```

---

## 🎓 系統分析重點（給報告用）

- **多人即時同步**：Firebase Realtime Database WebSocket
- **位置取得**：Browser Geolocation API (`navigator.geolocation`)
- **餐廳搜尋邏輯**：取所有成員距離的最小值為搜尋半徑、最小預算對應 Google price_level 篩選
- **中心點計算**：所有成員座標的平均值（Haversine formula）
- **匿名登入**：Firebase Anonymous Auth，無需個人資料
