# Strip Base64 Image Blocks from Session JSONL

## 問題

當使用者發送圖片給 bot 時，圖片經由 `detectAndLoadPromptImages()` 從磁碟讀取並轉為 base64，再透過 `injectHistoryImagesIntoMessages()` 注入到 `activeSession.messages` 中。`prompt()` 執行後，SessionManager 將完整訊息（含 base64）序列化至 session JSONL 檔案，導致檔案過大。

## 解決方案

在 `prompt()` 完成後，從 session messages 中移除 image content blocks 並重新持久化，讓 JSONL 檔案不再包含巨大的 base64 資料。圖片仍可在後續 turn 從磁碟重新載入（因為 `MediaPath:` 文字仍在）。

## 修改檔案

`src/agents/pi-embedded-runner/run/attempt.ts`

### 修改 1：新增 `stripImageBlocksFromMessages()` helper

在 `injectHistoryImagesIntoMessages()` 之後新增：

```typescript
export function stripImageBlocksFromMessages(messages: AgentMessage[]): boolean {
  let didStrip = false;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
        content.splice(i, 1);
        didStrip = true;
      }
    }
  }
  return didStrip;
}
```

反向遍歷陣列以安全移除元素，避免正向遍歷 `splice()` 後跳過元素的問題。

### 修改 2：移除提前持久化

```diff
  injectHistoryImagesIntoMessages(
    activeSession.messages,
    imageResult.historyImagesByIndex,
  );
- if (didMutate) {
-   activeSession.agent.replaceMessages(activeSession.messages);
- }
```

不再在 `prompt()` 之前就把 base64 圖片持久化到 JSONL。圖片只在記憶體中注入，AI 呼叫時仍可看到。

### 修改 3：在 `prompt()` 之後清除 image blocks

```typescript
if (imageResult.images.length > 0) {
  await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
} else {
  await abortable(activeSession.prompt(effectivePrompt));
}

// Strip base64 image blocks from stored messages to reduce session file size.
if (stripImageBlocksFromMessages(activeSession.messages)) {
  activeSession.agent.replaceMessages(activeSession.messages);
}
```

## 修改後的資料流

```
Turn N:
  1. detectImagesFromHistory() 掃描文字 → 找到 MediaPath → 從磁碟載入 base64
  2. injectHistoryImagesIntoMessages() → 注入 base64 到 messages（記憶體）
  3. prompt({ images }) → AI 看到圖片 → SessionManager 持久化（含 base64）
  4. stripImageBlocksFromMessages() → 移除 image blocks
  5. replaceMessages() → 重新持久化（無 base64）

Turn N+1:
  1. detectImagesFromHistory() → messageHasImageContent() = false → 重新掃描文字
  2. 重複步驟 1-5
```

## 為何可行

`detectImagesFromHistory()` (images.ts) 的邏輯：

- 若訊息**有** image blocks → 跳過偵測（使用快取的 base64）
- 若訊息**沒有** image blocks → 掃描文字中的圖片路徑 → 從磁碟重新載入

移除 image blocks 後，下一個 turn 會自動重新偵測文字中的 `MediaPath:` 路徑並從磁碟載入，不影響 AI 的視覺能力。

## 部署標籤

`openclaw:cojad-2026.2.22-strip-img`
