// Telegram plugin module implements api logging behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function resolveTelegramApiLogger(runtime?: RuntimeEnv, logger?: TelegramApiLogger) {
  if (logger) {
    return logger;
  }
  if (runtime?.error) {
    return runtime.error;
  }
  return (message: string) => fallbackLogger.error(message);
}

/** Try to extract a raw body string from an object (response-like or error-like). */
function extractRawBody(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  // Check common body properties: body, text, data, responseBody
  for (const key of ["body", "text", "data", "responseBody", "responseText"]) {
    const val = rec[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

/** Extract detailed error info from grammY HttpError / GrammyError. */
function formatTelegramApiError(err: unknown): string {
  const base = formatErrorMessage(err);
  if (!err || typeof err !== "object") {
    return base;
  }
  const parts: string[] = [base];

  // GrammyError: API responded with an error code — dump raw response body
  if ("error_code" in err && typeof (err as { error_code: unknown }).error_code === "number") {
    const e = err as { ok: false; error_code: number; description?: string; parameters?: unknown };
    const rawBody: Record<string, unknown> = { ok: false, error_code: e.error_code };
    if (e.description) rawBody.description = e.description;
    if (e.parameters && typeof e.parameters === "object" && Object.keys(e.parameters).length > 0) {
      rawBody.parameters = e.parameters;
    }
    parts.push(`[${e.error_code}]`);
    parts.push(JSON.stringify(rawBody));
  }

  // HttpError: network-level failure — dig into the nested .error
  if ("error" in err) {
    const inner = (err as { error: unknown }).error;
    if (inner && typeof inner === "object") {
      const code = "code" in inner && typeof (inner as { code: unknown }).code === "string"
        ? (inner as { code: string }).code
        : undefined;
      const status = "status" in inner && typeof (inner as { status: unknown }).status === "number"
        ? (inner as { status: number }).status
        : "statusCode" in inner && typeof (inner as { statusCode: unknown }).statusCode === "number"
          ? (inner as { statusCode: number }).statusCode
          : undefined;
      const innerMsg = formatErrorMessage(inner);
      const cause = "cause" in inner ? (inner as { cause: unknown }).cause : undefined;
      const causeMsg = cause ? formatErrorMessage(cause) : undefined;
      if (code || status) {
        parts.push(`[${[status, code].filter(Boolean).join(" ")}]`);
      }
      const detail = [innerMsg, causeMsg].filter(Boolean).join(" ");
      if (detail && detail !== base) {
        parts.push(`(${detail})`);
      }
      // Append raw body if available on the inner error or its cause
      const body = extractRawBody(inner) ?? extractRawBody(cause);
      if (body) {
        parts.push(`body=${body}`);
      }
    }
  }

  return parts.join(" ");
}

export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      const errText = formatTelegramApiError(err);
      const log = resolveTelegramApiLogger(runtime, logger);
      log(`telegram ${operation} failed: ${errText}`);
    }
    throw err;
  }
}
