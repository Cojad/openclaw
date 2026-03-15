# npm 發布指南 — openclaw-cojad

Fork 自 [openclaw/openclaw](https://github.com/openclaw/openclaw)，發布為獨立 npm 套件 `openclaw-cojad`。

## 套件資訊

| 項目       | 值                                                    |
| ---------- | ----------------------------------------------------- |
| npm 套件名 | `openclaw-cojad`                                      |
| npm 帳號   | `cojad`                                               |
| registry   | https://registry.npmjs.org/                           |
| 版本號格式 | `YYMM.D.HHmm`（例：`2603.3.2100` = 26年3月3日 21:00） |
| Git 分支   | `opus46`（rebase 在 `origin/main` 上）                |
| bin 指令   | `openclaw`（主要）+ `openclaw-cojad`（別名）          |

## 版本號機制

### 格式

`YYMM.D.HHmm` — 合法 semver，由建置時間決定：

| 欄位   | 意義                     | 範例               |
| ------ | ------------------------ | ------------------ |
| `YYMM` | MAJOR — 年份(2位) + 月份 | `2603` = 2026年3月 |
| `D`    | MINOR — 日期（無前導零） | `3` = 3日          |
| `HHmm` | PATCH — 時分（24小時制） | `2100` = 21:00     |

範例：

- `2603.3.2100` → 2026年3月3日 21:00
- `2604.15.0930` → 2026年4月15日 09:30

**限制**：semver 不允許前導零，所以月/日必須省略前導零（`03` → `3`）。

### 版本解析優先順序（runtime）

定義在 `src/version.ts`，runtime 讀取版本的順序：

1. `__OPENCLAW_VERSION__` — 建置時 bundler define 注入（目前未使用）
2. `package.json` → `version` — npm 安裝的主要來源（需 `name === "openclaw-cojad"`）
3. `dist/build-info.json` → `version` — fallback（`pnpm build` 自動產生）
4. `OPENCLAW_BUNDLED_VERSION` 環境變數 — Docker 建置時注入
5. `"0.0.0"` — 最終 fallback

### `dist/build-info.json`

`pnpm build` 時由 `scripts/write-build-info.ts` 自動產生：

```json
{
  "version": "2603.3.2100",
  "commit": "abc1234...",
  "builtAt": "2026-03-03T13:00:00.000Z"
}
```

- `version`：從 `package.json` 讀取
- `commit`：優先讀 `GIT_COMMIT` / `GIT_SHA` 環境變數，否則 `git rev-parse HEAD`
- 用途：版本號 fallback + CLI banner 顯示 commit hash

## 修改過的檔案（與上游 openclaw 的差異）

以下檔案需要維護 `"openclaw-cojad"` 相關修改：

| 檔案                           | 修改內容                                     | 用途                                             |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------ |
| `package.json`                 | `name`、`version`、`bin`（雙指令）           | 套件名、版本、CLI 指令名                         |
| `src/version.ts`               | `CORE_PACKAGE_NAME` → `"openclaw-cojad"`     | runtime 版本讀取時比對 package name              |
| `src/infra/update-check.ts`    | registry URL → `openclaw-cojad`              | 檢查新版本時查詢的套件名                         |
| `src/infra/update-runner.ts`   | `DEFAULT_PACKAGE_NAME` → `"openclaw-cojad"`  | `update.run` 全域更新預設套件名                  |
| `src/infra/update-global.ts`   | `PRIMARY_PACKAGE_NAME` → `"openclaw-cojad"`  | 偵測全域安裝的套件名                             |
| `src/cli/update-cli/shared.ts` | `DEFAULT_PACKAGE_NAME` → `"openclaw-cojad"`  | CLI `openclaw update` 預設套件名                 |
| `src/infra/openclaw-root.ts`   | `CORE_PACKAGE_NAMES` 加入 `"openclaw-cojad"` | 解析套件根目錄（template / docs 路徑依賴此邏輯） |

### package.json bin 欄位

```json
"bin": {
  "openclaw": "openclaw.mjs",
  "openclaw-cojad": "openclaw.mjs"
}
```

`npm install -g openclaw-cojad` 後會建立兩個指令：

- `openclaw` — 主要指令，systemd unit / 腳本 / 配置不用改
- `openclaw-cojad` — 別名

### 上游 rebase 衝突注意

上游 rebase 時，以上 7 個檔案可能產生衝突。解決原則：**保留 `"openclaw-cojad"` 相關修改**。

## 快速發布指令（一鍵流程）

```bash
cd /x/srv/bot/openclaw

# 1. 產生版本號
VERSION=$(TZ=Asia/Taipei date +"%y%m.%-d.%H%M")
echo "版本號: $VERSION"

# 2. 設定版本
npm version $VERSION --no-git-tag-version --allow-same-version

# 3. 建置
pnpm build

# 4. 發布（需要 OTP）
npm publish --access public --otp=<OTP碼>

# 5. 驗證
npm view openclaw-cojad version --userconfig "$(mktemp)"
```

## 完整發布流程（詳細步驟）

### 0. 前置：同步上游（如需要）

```bash
cd /x/srv/bot/openclaw
git fetch origin main
MERGE_BASE=$(git merge-base opus46 origin/main)
git rebase --onto origin/main $MERGE_BASE opus46 --ignore-date
# 解衝突（如有），然後 git add + git rebase --continue
```

### 1. 安裝依賴

```bash
pnpm install
```

Rebase 後新依賴可能出現，必須重新安裝。

### 2. 設定版本號

```bash
# 自動計算版本號（YYMM.D.HHmm，亞洲/台北時區）
VERSION=$(TZ=Asia/Taipei date +"%y%m.%-d.%H%M")

# 修改 package.json（不建 git tag）
npm version $VERSION --no-git-tag-version --allow-same-version
```

或手動編輯 `package.json` 的 `"version"` 欄位。

### 3. 建置

```bash
pnpm build
```

這會執行：

1. `pnpm canvas:a2ui:bundle` — 打包 A2UI 前端
2. `tsdown` — TypeScript → JS（輸出到 `dist/`）
3. `pnpm build:plugin-sdk:dts` — 產生 plugin SDK 型別定義
4. `scripts/write-plugin-sdk-entry-dts.ts`
5. `scripts/canvas-a2ui-copy.ts`
6. `scripts/copy-hook-metadata.ts`
7. `scripts/copy-export-html-templates.ts`
8. `scripts/write-build-info.ts` — **產生 `dist/build-info.json`**
9. `scripts/write-cli-startup-metadata.ts`
10. `scripts/write-cli-compat.ts`

### 4. 確認打包內容

```bash
npm pack --dry-run
```

確認：

- `name: openclaw-cojad`
- `version` 正確
- 包含 `dist/build-info.json`
- 包含 `docs/reference/templates/AGENTS.md` 和 `SOUL.md`
- 不包含 `dist/OpenClaw.app/`

### 5. 登入 npm（如未登入）

```bash
npm login
npm whoami  # 確認為 cojad
```

### 6. 發布

```bash
npm publish --access public --otp=<OTP碼>
```

注意：`prepack` hook 會自動觸發 `pnpm build && pnpm ui:build`，所以 publish 時會重新建置一次。

### 7. 驗證

```bash
# 確認版本
npm view openclaw-cojad version --userconfig "$(mktemp)"

# 確認 dist-tags
npm view openclaw-cojad dist-tags --userconfig "$(mktemp)"
```

## 使用者端安裝與切換

### 全新安裝

```bash
npm install -g openclaw-cojad
```

### 從官方 openclaw 切換

```bash
npm uninstall -g openclaw
npm install -g openclaw-cojad
```

安裝後 `openclaw` 和 `openclaw-cojad` 兩個指令都可用，原有的 systemd unit、腳本、配置不需修改。

### 更新到最新版

```bash
npm update -g openclaw-cojad
```

或透過 gateway tool `update.run` 自動更新。

## gateway 自動更新（update.run）

修改後，`update.run` gateway tool 會：

1. 查詢 `https://registry.npmjs.org/openclaw-cojad/latest` 檢查新版本
2. 執行 `npm i -g openclaw-cojad@latest`（或偵測到的套件管理器）
3. 重啟 gateway

## 注意事項

- npm 需要 2FA OTP 驗證碼
- 版本號不可有前導零（`03` → `3`）
- Rebase 上游後記得重新 `pnpm install`
- 上游 rebase 可能會覆蓋修改過的 7 個檔案，衝突時保留 `"openclaw-cojad"` 修改
- Docker 建置（`docker-build.sh`）獨立於 npm 發布，版本標籤格式不同（`cojad-MM.DD.HHhMMm-injection`）
- `src/infra/openclaw-root.ts` 的 `CORE_PACKAGE_NAMES` 必須同時包含 `"openclaw"` 和 `"openclaw-cojad"`，否則 workspace template 路徑解析會失敗

## 發布歷史

| 版本          | 日期       | 備註                                                                               |
| ------------- | ---------- | ---------------------------------------------------------------------------------- |
| `2603.3.2100` | 2026-03-03 | 首次發布                                                                           |
| `2603.3.2155` | 2026-03-03 | 修正 update.run 相關 4 處 hardcoded package name                                   |
| `2603.3.2207` | 2026-03-03 | 重新建置發布                                                                       |
| `2603.4.1553` | 2026-03-04 | 上游 rebase 後重新發布                                                             |
| `2603.4.1558` | 2026-03-04 | 新增 `openclaw-cojad` bin 別名，`openclaw` + `openclaw-cojad` 雙指令               |
| `2603.4.1604` | 2026-03-04 | 修正 `openclaw-root.ts` CORE_PACKAGE_NAMES，解決 "Missing workspace template" 問題 |
