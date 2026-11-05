# 足迹地图 · Wander Pins

把「去过哪里」变成一张可以染色的世界地图。点在地图上记一条，按真实行政区划逐级染色（国 → 省 → 市 → 区县），配照片和时间轴，全部数据留在本地。

纯色矢量底图，不用瓦片地图。没有 POI、没有路线规划、没有实时路况——它不是导航工具，是**个人地理记忆的可视化**。

---

## 1. 它解决什么问题

市面上「涂色地图」要么只到国家层级（Been、Visited），要么得手工一笔笔画（Google My Maps），要么只能看不能改（Google 时间轴）。

这个项目做的是第三件：**录入一个坐标，自动判断它落在哪个真实行政边界里，然后按你选择的尺度染色**。

---

## 2. 快速开始

### 方式 A：纯静态运行（最快，不需要任何后端）

```bash
# 项目根目录执行
python -m http.server 8138
# 浏览器打开 http://127.0.0.1:8138
```

所有记录存在浏览器 IndexedDB 里，刷新不丢，换浏览器就没了。想带走数据用「导出备份」。

> 必须用 HTTP 打开，直接双击 `index.html`（`file://`）会因安全策略导致部分功能不可用。

### 方式 B：带账户与云端同步

```bash
# 1. 安装后端依赖
cd backend
pip install -r requirements.txt

# 2. 配置环境变量
cp .env.example .env    # 然后填入真实的 Supabase 配置

# 3. 启动
uvicorn main:app --reload --port 8000
```

前端登录走 Supabase Auth，数据读写走 Supabase Edge Function `wander-api`。

---

## 3. 目录结构

```
tree1/
├── index.html              单页入口（全部 UI 结构）
├── css/style.css           设计系统：配色、布局、组件
├── js/
│   ├── db.js               IndexedDB 封装（本地数据层）
│   ├── account.js          账户：Supabase Auth / 本地账户 / 微信登录
│   ├── app.js              主逻辑 2.4k 行：地图、染色、表单、日志、搜索、导入导出
│   └── (渲染分层在 app.js 内部：底图 → 染色 → 标注 → 标记 → 面板)
├── assets/vendor/          本地化的第三方依赖（断网可用，见第 5 节）
├── server.py               零依赖本地服务：账户 + 同步 + 静态托管 + 微信回调
├── config.json             本地服务配置（端口、微信 AppID）
└── backend/                FastAPI + Supabase 版本（仅 3 个 auth 路由，非当前主线）
```

**运行模式（`js/account.js` 顶部的 `CLOUD_ENABLED` 开关）：**

| 模式 | 说明 |
|---|---|
| **纯本地（当前默认）** | `CLOUD_ENABLED = false`。不连接任何后端，数据只存 IndexedDB，登录与云同步入口隐藏。`server.py` 仍可作为本地账户服务备选 |
| 云同步（可选） | `CLOUD_ENABLED = true`。登录走 Supabase Auth，数据读写走 Edge Function `wander-api`，需自行配置密钥与函数 |

设计原则：**本地优先**。云端同步是可选的增强，不是前提——关掉它应用功能完整、离线可用。

---

## 4. 数据流

```
用户操作
   ↓
js/app.js  ──写──>  IndexedDB（js/db.js）  ←── 唯一数据源，离线可用
   ↓                        │
   │                        └──「导出备份」→ JSON 文件（含照片 base64）
   ↓
登录后 ──> Supabase Auth 取 session ──> Edge Function `wander-api` ──> 云端副本
```

设计原则：**本地优先**。断网时一切照常，登录与同步是可选的增强，不是前提。

---

## 5. 离线能力（哪些数据在本机）

`assets/vendor/` 里放了第三方依赖，页面本地优先加载，失败才回落到 CDN（`onerror` 兜底）。

| 资源 | 本地路径 | 大小 |
|---|---|---|
| Leaflet 1.9.4（js + css + 图标） | `vendor/leaflet/` | 165 KB |
| topojson-client 3.1.0 | `vendor/topojson/` | 7 KB |
| Supabase JS v2 (UMD) | `vendor/supabase/` | 215 KB |
| world-atlas：land/countries 50m + 110m | `vendor/world-atlas/` | 1.4 MB |
| DataV 全国省界 `100000_full.json` | `vendor/datav/` | 569 KB |

**断网时仍然可用**：地图底图、国家与省界染色、记录浏览、照片、日志。

**断网时不可用（按需在线拉取）**：
- 市/区县级边界（`{adcode}_full.json`，全国 300+ 个文件，按需请求）
- 境外省级界线（Natural Earth admin-1，约 20 MB，不随仓库分发；加载失败时自动降级为按国界染色）
- 地名搜索（Open-Meteo Geocoding / Nominatim）

---

## 6. 环境变量

`backend/.env`（**已在 `.gitignore` 中，禁止提交**）：

| 变量 | 说明 |
|---|---|
| `SUPABASE_URL` | Supabase 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端专用，绕过 RLS，等同数据库 root。绝不能出现在前端或仓库 |
| `JWT_SECRET` | 会话签名密钥，`openssl rand -hex 32` 生成 |
| `JWT_ALGORITHM` | 默认 `HS256` |
| `FRONTEND_ORIGIN` | 允许的前端来源 |

模板见 `backend/.env.example`。

---

## 7. 已知限制

- 照片以原图存 IndexedDB，大图累积可能触发 `QuotaExceededError`（计划：入库前压缩到 1500px WebP）
- HEIC 仅在 Safari 可解码，Chrome 下会被过滤（UI 提示待修正）
- 市/区县边界与地名搜索依赖网络
- 移动端「点地图加记录」与地图拖拽存在手势冲突

---

## 8. 更新日志

**2026-11-05**
- 安全：将 `.env`、`footprints.db`、`__pycache__`、`.idea` 移出版本控制，新增 `.gitignore` 与 `.env.example`
- 依赖：Leaflet / topojson / Supabase JS / world-atlas / 全国省界本地化，断网可演示
- 修复：`Natural Earth admin-1` 数据源改为国内可达的 jsDelivr 优先
- 修复：云端同步两处致命 bug（supabase-js v1 接口残留导致调用即抛错；同步请求缺 `Authorization` 头被网关 401）
- 修复：OAuth 回跳由写死域名改为 `window.location.origin`，本地与线上均可登录
- 模式：新增 `CLOUD_ENABLED` 开关，默认纯本地模式（隐藏登录与云同步），云端作为可选增强

（更早的提交历史见 `git log`）
- 新增：足迹统计面板（📊 统计）——从 records 派生「足迹数 / 大洲 / 国家 / 省份·州」，复用既有行政区解析缓存，不新增数据结构
- 新增：分享海报（1080×1920 Canvas）——离线绘制世界底图与到访国家/中国省份染色，一键导出 PNG
