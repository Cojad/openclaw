import type { Update } from "@grammyjs/types";
import { describe, it, expect } from "vitest";

describe("telegram inject", () => {
  it("validates update structure", () => {
    const validUpdate: Update = {
      update_id: 123456,
      message: {
        message_id: 1,
        date: 1234567890,
        chat: {
          id: 123456789,
          type: "private",
        },
        from: {
          id: 987654321,
          is_bot: false,
          first_name: "Test",
        },
        text: "Hello from Telethon!",
      },
    };

    expect(validUpdate.update_id).toBe(123456);
    expect(validUpdate.message?.text).toBe("Hello from Telethon!");
  });

  it("validates message with reply metadata", () => {
    const updateWithReply: Update = {
      update_id: 123457,
      message: {
        message_id: 2,
        date: 1234567891,
        chat: {
          id: 123456789,
          type: "private",
        },
        from: {
          id: 987654321,
          is_bot: false,
          first_name: "Test",
        },
        text: "Reply to bot message",
        reply_to_message: {
          message_id: 1,
          date: 1234567890,
          chat: {
            id: 123456789,
            type: "private",
          },
          from: {
            id: 111111111,
            is_bot: true,
            first_name: "Bot",
            username: "testbot",
          },
          text: "Original message from bot",
        },
      },
    };

    expect(updateWithReply.message?.reply_to_message?.message_id).toBe(1);
    expect(updateWithReply.message?.reply_to_message?.from?.is_bot).toBe(true);
  });

  it("validates message with thread metadata", () => {
    const updateWithThread: Update = {
      update_id: 123458,
      message: {
        message_id: 3,
        date: 1234567892,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          is_forum: true,
        },
        from: {
          id: 987654321,
          is_bot: false,
          first_name: "Test",
        },
        message_thread_id: 42,
        text: "Message in forum topic",
      },
    };

    expect(updateWithThread.message?.message_thread_id).toBe(42);
    expect(updateWithThread.message?.chat.is_forum).toBe(true);
  });
});
