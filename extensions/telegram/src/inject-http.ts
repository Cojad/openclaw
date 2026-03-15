import type { Update } from "@grammyjs/types";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { loadConfig } from "../../../src/config/config.js";
import { getBearerToken } from "../../../src/gateway/http-utils.js";
import { saveMediaBuffer } from "../../../src/media/store.js";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBot } from "./bot.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve({ ok: true, value: parsed });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

const MULTIPART_MAX_BYTES = 10 * 1024 * 1024; // 10MB max for multipart

async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: Buffer } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: true, value: Buffer.concat(chunks) });
    });
    req.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

type MultipartField = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

function parseMultipartFormData(body: Buffer, boundary: string): MultipartField[] {
  const delim = Buffer.from(`--${boundary}`);
  const crlfcrlf = Buffer.from("\r\n\r\n");
  const fields: MultipartField[] = [];
  let pos = body.indexOf(delim, 0);
  if (pos === -1) {
    return fields;
  }

  while (true) {
    pos += delim.length;
    // closing "--"?
    if (pos + 1 < body.length && body[pos] === 0x2d && body[pos + 1] === 0x2d) {
      break;
    }
    // skip CRLF after delimiter
    if (pos + 1 < body.length && body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    }

    // find end of part headers
    const hdrEnd = body.indexOf(crlfcrlf, pos);
    if (hdrEnd === -1) {
      break;
    }
    const hdrStr = body.subarray(pos, hdrEnd).toString("utf-8");
    const dataStart = hdrEnd + 4;

    // find next boundary
    const nextDelim = body.indexOf(delim, dataStart);
    if (nextDelim === -1) {
      break;
    }
    // body ends before CRLF preceding next boundary
    const dataEnd =
      nextDelim >= 2 && body[nextDelim - 2] === 0x0d && body[nextDelim - 1] === 0x0a
        ? nextDelim - 2
        : nextDelim;

    // parse part headers
    const headers: Record<string, string> = {};
    for (const line of hdrStr.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    const disp = headers["content-disposition"] || "";
    const nameMatch = disp.match(/name="([^"]+)"/);
    const filenameMatch = disp.match(/filename="([^"]+)"/);

    fields.push({
      name: nameMatch?.[1] || "",
      filename: filenameMatch?.[1],
      contentType: headers["content-type"],
      data: body.subarray(dataStart, dataEnd),
    });

    pos = nextDelim;
  }

  return fields;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=([^\s;]+)/i);
  return match?.[1]?.replace(/^"(.*)"$/, "$1") ?? null;
}

function isValidUpdate(value: unknown): value is Update {
  if (!value || typeof value !== "object") {
    return false;
  }
  const update = value as Partial<Update>;
  return typeof update.update_id === "number";
}

function getTelegramInjectConfig(cfg: OpenClawConfig, accountId: string) {
  const account = resolveTelegramAccount({ cfg, accountId });
  const inject = account.config.inject;
  if (!inject?.enabled) {
    return null;
  }
  const token = inject.token?.trim();
  if (!token) {
    throw new Error(`telegram.accounts.${accountId}.inject.enabled requires inject.token`);
  }
  return {
    token,
    accountId: account.accountId,
    botToken: account.token,
    config: account.config,
  };
}

export async function handleTelegramInjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/telegram/inject") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const cfg = loadConfig();
  const requestedAccountId = url.searchParams.get("accountId") || undefined;

  // Find enabled inject config
  let injectConfig: ReturnType<typeof getTelegramInjectConfig> = null;
  if (requestedAccountId) {
    try {
      injectConfig = getTelegramInjectConfig(cfg, requestedAccountId);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
  } else {
    // Try default account first (single-account mode)
    try {
      injectConfig = getTelegramInjectConfig(cfg, undefined);
    } catch {
      // If default fails, try multi-account mode
      const accounts = cfg.channels?.telegram?.accounts ?? {};
      for (const [accountId] of Object.entries(accounts)) {
        try {
          const config = getTelegramInjectConfig(cfg, accountId);
          if (config) {
            injectConfig = config;
            break;
          }
        } catch {
          // Skip invalid configs
        }
      }
    }
  }

  if (!injectConfig) {
    sendJson(res, 503, {
      ok: false,
      error: "telegram inject not enabled (set channels.telegram.accounts.<id>.inject.enabled)",
    });
    return true;
  }

  // Verify token
  const token = getBearerToken(req);
  if (!token || token !== injectConfig.token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized");
    return true;
  }

  // Detect content type and read body accordingly
  const reqContentType = req.headers["content-type"] || "";
  const isMultipart = reqContentType.toLowerCase().startsWith("multipart/form-data");

  let payload: Record<string, unknown>;
  let mediaBuffer: Buffer | null = null;
  let mediaFilename: string | undefined;
  let mediaContentType: string | undefined;

  if (isMultipart) {
    const boundary = extractBoundary(reqContentType);
    if (!boundary) {
      sendJson(res, 400, { ok: false, error: "missing multipart boundary" });
      return true;
    }
    const raw = await readRawBody(req, MULTIPART_MAX_BYTES);
    if (!raw.ok) {
      const status = raw.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: raw.error });
      return true;
    }
    const fields = parseMultipartFormData(raw.value, boundary);
    const payloadField = fields.find((f) => f.name === "payload");
    if (!payloadField) {
      sendJson(res, 400, { ok: false, error: "missing payload field in multipart body" });
      return true;
    }
    try {
      const parsed = JSON.parse(payloadField.data.toString("utf-8")) as unknown;
      payload =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid JSON in payload field" });
      return true;
    }
    const mediaField = fields.find((f) => f.name === "media");
    if (mediaField && mediaField.data.length > 0) {
      mediaBuffer = Buffer.from(mediaField.data);
      mediaFilename = mediaField.filename;
      mediaContentType = mediaField.contentType;
    }
  } else {
    // JSON body (backward compatible)
    const body = await readJsonBody(req, 1024 * 1024); // 1MB max
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }
    payload =
      typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
  }

  // Validate payload
  if (!payload.update || typeof payload.update !== "object") {
    sendJson(res, 400, { ok: false, error: "update required" });
    return true;
  }

  if (!isValidUpdate(payload.update)) {
    sendJson(res, 400, { ok: false, error: "invalid update format" });
    return true;
  }

  const update = payload.update;

  // Extract message from update
  const message =
    update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;

  if (!message) {
    sendJson(res, 400, { ok: false, error: "no message in update" });
    return true;
  }

  // Save injected media and attach path to message
  if (mediaBuffer) {
    try {
      const saved = await saveMediaBuffer(
        mediaBuffer,
        mediaContentType,
        "inbound",
        undefined,
        mediaFilename,
      );
      (message as unknown as Record<string, unknown>)._inject_file_path = saved.path;
      (message as unknown as Record<string, unknown>)._inject_content_type = saved.contentType;
    } catch (err) {
      // Media save failure is non-fatal; log and continue without media
      console.error(`telegram inject: failed to save media: ${String(err)}`);
    }
  }

  try {
    // Create bot instance with all handlers registered
    // This reuses the full bot setup including message processing
    const bot = createTelegramBot({
      token: injectConfig.botToken,
      accountId: injectConfig.accountId,
      config: cfg,
      runtime: {
        log: console.log,
        error: console.error,
        exit: () => {
          throw new Error("exit not supported in inject mode");
        },
      },
    });

    // Initialize bot to fetch bot info (required for mention detection, etc.)
    await bot.init();

    // Manually trigger the bot's update handling
    // This will run through all registered middlewares and handlers
    // just like a normal polling update would
    await bot.handleUpdate(update);

    sendJson(res, 202, {
      ok: true,
      message: "update processed",
      updateId: update.update_id,
    });
    return true;
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
    return true;
  }
}
