# formatInboundEnvelope 規則

## 輸出格式

```
[{channel} {from} {+elapsed} {timestamp}] {senderLabel}: {body}
```

## Header 部分 `[...]`

| 欄位        | 說明                                     | 範例                                                                 |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `channel`   | 通道名稱                                 | `Telegram`                                                           |
| `from`      | 由 `formatInboundFromLabel` 產生         | 群組: `Cojad_buy 柯姊敗家團 id:-1001068509881`，DM: `Alice id:12345` |
| `+elapsed`  | 距離上次訊息的時間差                     | `+1m`、`+3h`、`+2d`                                                  |
| `timestamp` | 時間戳（受 `envelopeTimezone` 設定影響） | `2026-02-08 16:27 GMT+8`                                             |

## Body 部分

- **群組**：`{senderLabel}: {body}` — 前面會加上發送者標籤
- **DM**：直接就是 `{body}` — 不加發送者

## Sender Label 規則（`resolveSenderLabel`）

優先順序：`name` > `username` > `tag`，加上 ID 部分 `(e164 or id)`

| 情境                     | 輸出                 |
| ------------------------ | -------------------- |
| name=小喵, id=405055366  | `小喵 (405055366)`   |
| name=踏踏, id=8471027234 | `踏踏 (8471027234)`  |
| 只有 username=alice      | `alice`              |
| name 跟 id 相同          | 只顯示一次，不加括號 |

## From Label 規則（`formatInboundFromLabel`）

- **群組**：`{title} id:{chatId}` 或 `group:{chatId}`（無 title 時）
- **DM**：`{name} id:{userId}` 或只有 `{name}`（name == id 時省略）

## 非文字訊息處理（Media Placeholder）

當訊息不含文字時，body 會用 placeholder 替代：

| 訊息類型                            | Placeholder                                 |
| ----------------------------------- | ------------------------------------------- |
| 圖片 `msg.photo`                    | `<media:image>`                             |
| 影片 `msg.video`                    | `<media:video>`                             |
| 圓形影片 `msg.video_note`           | `<media:video>`                             |
| 音訊/語音 `msg.audio` / `msg.voice` | `<media:audio>`                             |
| 檔案 `msg.document`                 | `<media:document>`                          |
| 貼圖 `msg.sticker`                  | `<media:sticker>`                           |
| 多張圖片                            | `<media:image> (N images)`                  |
| 貼圖有快取描述                      | `[Sticker {emoji} from "{setName}"] {描述}` |

- 如果訊息同時有文字（`text` 或 `caption`），文字優先，placeholder 不使用
- 如果訊息無文字也無 media，直接丟棄（return null）

## 位置訊息

`msg.location` / `msg.venue` 會透過 `formatLocationText` 轉成文字，附加在 body 後面

## Reply / Forward / Quote 格式

| 情境     | 格式                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 回覆訊息 | `{body}\n\n[Replying to {sender} id:{msgId}]\n{replyBody}\n[/Replying]` |
| 引用訊息 | `{body}\n\n[Quoting {sender} id:{msgId}]\n"{quotedBody}"\n[/Quoting]`   |
| 轉發訊息 | `[Forwarded from {origin} at {isoDate}]\n{body}`                        |

## 完整 Body 組合順序

```
{forwardPrefix}{bodyText}{replySuffix}
```

即：轉發標記在最前，主體文字在中間，回覆/引用在最後。

---

## 各類型訊息範例輸出

### 群組純文字訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:27 GMT+8] 小喵 (405055366): 今天天氣真好
```

### DM 純文字訊息

```
[Telegram 小喵 id:405055366 +3m 2026-02-08 16:30 GMT+8] 幫我查一下明天的天氣
```

### 圖片訊息（有 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +2m 2026-02-08 16:32 GMT+8] 小喵 (405055366): 看看我家的貓
```

caption 作為文字優先使用，圖片檔案另外透過 MediaPath 傳給 agent（非 envelope 內容）。

### 圖片訊息（無 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +5s 2026-02-08 16:32 GMT+8] 小喵 (405055366): <media:image>
```

### 多張圖片（無 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +10s 2026-02-08 16:33 GMT+8] 小喵 (405055366): <media:image> (3 images)
```

### 影片訊息（無 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:34 GMT+8] 小喵 (405055366): <media:video>
```

### 圓形影片（video note）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +30s 2026-02-08 16:35 GMT+8] 小喵 (405055366): <media:video>
```

### 語音訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +2m 2026-02-08 16:36 GMT+8] 小喵 (405055366): <media:audio>
```

### 檔案訊息（有 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:37 GMT+8] 小喵 (405055366): 這是會議記錄
```

### 檔案訊息（無 caption）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:37 GMT+8] 小喵 (405055366): <media:document>
```

### 貼圖訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +5s 2026-02-08 16:38 GMT+8] 小喵 (405055366): <media:sticker>
```

### 貼圖訊息（有快取描述）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +5s 2026-02-08 16:38 GMT+8] 小喵 (405055366): [Sticker 😂 from "FunnyCats"] A cat rolling on the floor laughing
```

### 位置訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:39 GMT+8] 小喵 (405055366): 📍 25.0330, 121.5654
```

### 回覆訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:40 GMT+8] 小喵 (405055366): 就這樣吧

[Replying to 踏踏 id:69372]
【Claude API 剩餘用量】 Session ██████▌░░░ 66% 2h19m
[/Replying]
```

### 引用訊息（quote）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +2m 2026-02-08 16:41 GMT+8] 小喵 (405055366): 這段我不同意

[Quoting 踏踏 id:69370]
"很多用語差異已經深入訓練資料了"
[/Quoting]
```

### 轉發訊息

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +3m 2026-02-08 16:42 GMT+8] 小喵 (405055366): [Forwarded from Alice at 2026-02-07T10:00:00.000Z]
這是一條很有用的訊息
```

### 回覆 + 圖片 + caption（組合）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +1m 2026-02-08 16:43 GMT+8] 小喵 (405055366): 你看這張比較好

[Replying to 踏踏 id:69380]
哪張照片比較好看？
[/Replying]
```

圖片檔案透過 MediaPath/MediaType 另外傳遞。

### 轉發 + 回覆（組合）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 +2m 2026-02-08 16:44 GMT+8] 小喵 (405055366): [Forwarded from Bob at 2026-02-07T15:30:00.000Z]
推薦這家餐廳

[Replying to 踏踏 id:69385]
有什麼好吃的嗎？
[/Replying]
```

### DM 圖片（有 caption）

```
[Telegram 小喵 id:405055366 +5m 2026-02-08 16:45 GMT+8] 幫我看看這張圖
```

DM 不加發送者標籤，caption 直接作為 body。

### message_id 附加格式（群組 history buffer 中的訊息）

```
[Telegram Cojad_buy 柯姊敗家團 id:-1001068509881 2026-02-08 16:20 GMT+8] 小喵 (405055366): 等一下要開會 [id:69360 chat:-1001068509881]
```

history buffer 中的訊息會在尾部附加 `[id:{messageId} chat:{chatId}]`。

---

## Envelope 設定選項

- `envelopeTimezone`：`local` / `utc` / `user` / IANA 時區字串
- `envelopeTimestamp`：`off` 可關閉時間戳
- `envelopeElapsed`：`off` 可關閉時間差顯示

## 原始碼位置

- `src/auto-reply/envelope.ts` — formatInboundEnvelope, formatAgentEnvelope, formatInboundFromLabel
- `src/channels/sender-label.ts` — resolveSenderLabel
- `src/telegram/bot-message-context.ts` — Telegram 通道的呼叫點（含 media placeholder、reply/forward 組裝）
