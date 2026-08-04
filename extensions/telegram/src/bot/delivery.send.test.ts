import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { sendTelegramWithThreadFallback } from "./delivery.send.js";

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: () => {
      throw new Error("exit");
    },
  };
}

function createGrammyError(description: string): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: 400, description },
    "sendMessage",
    {},
  );
}

describe("sendTelegramWithThreadFallback reply-not-found fallback", () => {
  it("retries without reply_to_message_id on reply-not-found 400", async () => {
    const runtime = createRuntime();
    const send = vi.fn();
    send.mockRejectedValueOnce(createGrammyError("Bad Request: replied message not found"));
    send.mockResolvedValueOnce({ message_id: 42 });

    const result = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      requestParams: { reply_to_message_id: 100, message_thread_id: 5 },
      send,
      thread: { id: 5, scope: "forum" },
    });

    expect(result).toEqual({ message_id: 42 });
    expect(send).toHaveBeenCalledTimes(2);
    // First call includes reply_to_message_id.
    expect(send.mock.calls[0]?.[0]).toHaveProperty("reply_to_message_id", 100);
    // Retry should strip reply_to_message_id but keep other params.
    const retryParams = send.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retryParams).not.toHaveProperty("reply_to_message_id");
    expect(retryParams).toHaveProperty("message_thread_id", 5);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("replied message not found"));
  });

  it("retries without reply_parameters on reply-not-found 400", async () => {
    const runtime = createRuntime();
    const send = vi.fn();
    send.mockRejectedValueOnce(createGrammyError("Bad Request: message to be replied not found"));
    send.mockResolvedValueOnce({ message_id: 43 });

    const result = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      requestParams: { reply_parameters: { message_id: 100 } },
      send,
    });

    expect(result).toEqual({ message_id: 43 });
    const retryParams = send.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retryParams).not.toHaveProperty("reply_parameters");
  });

  it("does not retry on non-reply errors", async () => {
    const runtime = createRuntime();
    const send = vi.fn();
    send.mockRejectedValueOnce(createGrammyError("Bad Request: chat not found"));

    await expect(
      sendTelegramWithThreadFallback({
        operation: "sendMessage",
        runtime,
        requestParams: { reply_to_message_id: 100 },
        send,
      }),
    ).rejects.toThrow("chat not found");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry reply-not-found when no reply param present", async () => {
    const runtime = createRuntime();
    const send = vi.fn();
    send.mockRejectedValueOnce(createGrammyError("Bad Request: replied message not found"));

    await expect(
      sendTelegramWithThreadFallback({
        operation: "sendMessage",
        runtime,
        requestParams: { message_thread_id: 5 },
        send,
      }),
    ).rejects.toThrow("replied message not found");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
