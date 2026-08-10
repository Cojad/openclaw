# opus46 分支 — openclaw-cojad 客製版

> **Fork:** [Cojad/openclaw](https://github.com/Cojad/openclaw) `opus46` 分支
> **npm:** `openclaw-cojad` ([npmjs.com](https://www.npmjs.com/package/openclaw-cojad))
> **Base:** 持續 rebase 於 [openclaw/openclaw](https://github.com/openclaw/openclaw) `main`

此分支在 upstream OpenClaw 基礎上增加以下自訂改進，透過 `upgrade.sh` 自動 rebase、建置、部署、發布。

---

## Commit 1：Telegram Inject Endpoint、Docker Tooling、Session Image Stripping

### 1. openclaw-cojad 包名系統（npm fork 發布）

| 檔案                           | 改動                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `package.json`                 | 加入 `openclaw-cojad` bin alias、`publishConfig`、額外打包 `src/`、`extensions/`、`tool-display.json` |
| `src/version.ts`               | `CORE_PACKAGE_NAME` → `"openclaw-cojad"`                                                              |
| `src/infra/update-runner.ts`   | `DEFAULT_PACKAGE_NAME` → `"openclaw-cojad"`                                                           |
| `src/infra/update-global.ts`   | `PRIMARY_PACKAGE_NAME` → `"openclaw-cojad"`                                                           |
| `src/infra/update-check.ts`    | npm registry URL → `openclaw-cojad`                                                                   |
| `src/infra/openclaw-root.ts`   | `CORE_PACKAGE_NAMES` 同時認 `"openclaw"` 和 `"openclaw-cojad"`                                        |
| `src/cli/update-cli/shared.ts` | `DEFAULT_PACKAGE_NAME` → `"openclaw-cojad"`                                                           |

讓使用者能透過 `npm install -g openclaw-cojad` 安裝客製版，自動更新也會檢查正確的 registry。

### 2. Telegram Inject Endpoint（外部注入 Telegram Update）

| 檔案                                          | 說明                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `extensions/telegram/src/inject-http.ts`      | 413 行 — HTTP POST `/telegram/inject` 端點，接收外部 Telegram Update JSON，支援 multipart media |
| `extensions/telegram/src/inject-http.test.ts` | 95 行測試                                                                                       |
| `src/gateway/server-http.ts`                  | inject handler 掛載到 gateway HTTP pipeline                                                     |
| `src/config/types.telegram.ts`                | 新增 `inject.enabled` + `inject.token` 配置型別                                                 |
| `src/config/zod-schema.providers-core.ts`     | inject 配置的 Zod schema 驗證                                                                   |
| `docs/channels/telegram-inject.md`            | 346 行文件                                                                                      |
| `examples/telegram-inject-test.sh`            | 測試用 curl 範例                                                                                |

讓 intergram-js（Telethon userbot）能把監聽到的群組訊息轉發給 OpenClaw 處理。

### 3. Session Image Stripping（減少 session 檔案大小）

| 檔案                                           | 說明                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 新增 `stripImageBlocksFromMessages()`，每個 turn 結束後移除 base64 image blocks，保留 `MediaPath:` 文字參照 |

解決 session JSONL 因累積 base64 圖片而膨脹的問題。

### 4. Docker 建置工具

| 檔案               | 說明                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `Dockerfile.cojad` | 自訂 Dockerfile，在 upstream image 上補 `src/`、`tool-display.json`、`dist/runtime/` re-export wrapper |
| `docker-build.sh`  | 建置腳本（先 build upstream，再套 Dockerfile.cojad）                                                   |
| `.dockerignore`    | 新增忽略規則                                                                                           |

### 5. 備忘文件

| 檔案                       | 說明                      |
| -------------------------- | ------------------------- |
| `formatInboundEnvelope.md` | inbound envelope 格式說明 |
| `npm-deploy-cojad.md`      | npm 發布流程備忘          |
| `reduceSessionFileSize.md` | session 檔案瘦身方案      |

---

## Commit 2：Telegram Reply-to Foreign Bot 修復

**來源：** cherry-pick 自 [tata-meow/openclaw](https://github.com/tata-meow/openclaw) `tg-injection` 分支 (`af2f958`)

**問題：** reply 到 foreign bot 訊息時，Telegram Bot API 回傳 `400: replied message not found`。

**兩層防護：**

| 層級          | 檔案                                              | 說明                                                                  |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| 主動避免      | `extensions/telegram/src/bot-message-dispatch.ts` | foreign bot（`is_bot=true` 且非自己）訊息不設 `draftReplyToMessageId` |
| 被動 fallback | `extensions/telegram/src/bot/delivery.send.ts`    | 捕捉 "replied message not found"，移除 `reply_to_message_id` 後重試   |
| 被動 fallback | `extensions/telegram/src/draft-stream.ts`         | draft preview 路徑同樣加入 fallback                                   |
| 被動 fallback | `extensions/telegram/src/send.ts`                 | legacy 發送路徑同樣加入 fallback                                      |

測試：

- `bot-message-dispatch.test.ts` — +72 行，3 個新 test case
- `bot/delivery.send.test.ts` — +99 行新檔案，4 個 test case

---

## 發布鏈

```
origin/main (upstream)
  → rebase opus46 (自訂 commits)
    → upgrade.sh 自動執行:
      → pnpm build → docker build → claw_boot.sh 部署
      → npm publish openclaw-cojad
      → git push fork opus46
      → Telegram 群組通知
```

## 安裝

```bash
npm install -g openclaw-cojad
```

## 統計

- **29 個檔案**，+2313 / -87 行（相對於 upstream）
- **2 個自訂 commit**，持續 rebase 於 upstream `main`
