// Telegram inbound rich_message renderer: flattens RichMessage blocks into text
// so rich-only messages are not dropped and rich content can join mention/command gating.
// Pure + total: NEVER throws (a throw would reach polling spool release and risk a replay loop).
import type { RichBlock, RichBlockListItem, RichMessage, RichText } from "grammy/types";
import { markdownInlineCodeDelimiters, markdownPreAffixes } from "./markdown.js";

export type RichRenderMode = "markdown" | "plain";

// Payload is external/untyped at runtime; cap recursion so near-cyclic or pathological
// nesting cannot run away. The ellipsis stops the branch without throwing.
const MAX_DEPTH = 32;
const DEPTH_CUTOFF = "…";

// Forward-compat loose read: rich types evolve faster than the pinned grammy union,
// so default/fallback branches inspect unknown shapes defensively.
type LooseRecord = Record<string, unknown>;
function asLoose(value: unknown): LooseRecord {
  return value && typeof value === "object" ? (value as LooseRecord) : {};
}

// Single GFM inline-link emitter shared by url/email/phone so escaping can't diverge.
// Backslash-escape ()/ and whitespace in the destination: an unescaped ) (e.g. a
// Wikipedia URL ...Foo_(bar)) would otherwise terminate the (…) early and corrupt the link.
function renderInlineLink(label: string, target: string, plain: boolean): string {
  if (plain || !label || !target) {
    return label || target;
  }
  return `[${label}](${target.replace(/[()\\\s]/g, "\\$&")})`;
}

export function renderRichMessageToText(
  rich: RichMessage,
  mode: RichRenderMode = "markdown",
): string {
  const blocks = Array.isArray(rich.blocks) ? rich.blocks : [];
  // rich.is_rtl is a presentation-only flag; it has no bearing on flattened text.
  const rendered = renderBlocks(blocks, mode, 0);
  return rendered.trim();
}

// Command detection (control commands, abort) must ignore verbatim/quoted content: a code,
// pre, blockquote, or pullquote block beginning with "/cmd" is user content, not a typed
// command. Flatten only top-level prose blocks (where a user types a command) for gating.
const COMMAND_PROSE_BLOCK_TYPES = new Set(["paragraph", "heading", "footer"]);
export function renderRichCommandText(rich: RichMessage): string {
  const blocks = Array.isArray(rich.blocks)
    ? rich.blocks.filter((block) => COMMAND_PROSE_BLOCK_TYPES.has(asLoose(block).type as string))
    : [];
  return renderRichMessageToText({ blocks } as RichMessage, "plain");
}

function renderBlocks(blocks: unknown, mode: RichRenderMode, depth: number): string {
  if (!Array.isArray(blocks)) {
    return "";
  }
  return blocks
    .map((block) => renderBlock(block as RichBlock, mode, depth))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function renderRichText(node: unknown, mode: RichRenderMode, depth: number): string {
  // Inline trees are external/untyped too: a deep wrap/array chain
  // (e.g. nested bold) would overflow the call stack and throw, so the inline
  // path shares the same depth budget as blocks. The cutoff stops without throwing.
  if (depth > MAX_DEPTH) {
    return DEPTH_CUTOFF;
  }
  if (typeof node === "string") {
    // No markdown escaping: matches renderTelegramTextEntities (also non-escaping); avoids divergence.
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => renderRichText(child, mode, depth + 1)).join("");
  }
  // Block-level callers pass a loose .text that may be undefined/null (a paragraph
  // with no text) or a stray primitive on hostile input; degrade to empty, never read off it.
  if (node == null || typeof node !== "object") {
    return "";
  }
  const wrap = node as { type?: string; text?: RichText } & LooseRecord;
  const inner = wrap.text != null ? renderRichText(wrap.text, mode, depth + 1) : "";
  return renderInline(wrap, inner, mode);
}

function renderInline(
  node: { type?: string } & LooseRecord,
  inner: string,
  mode: RichRenderMode,
): string {
  const str = (key: string): string => (typeof node[key] === "string" ? node[key] : "");
  const plain = mode === "plain";
  switch (node.type) {
    // GFM has no <mark>; bold is the closest portable fallback. Sub/superscript have
    // no portable markdown, so they fall through to inner text in both modes.
    case "bold":
    case "marked":
      return plain ? inner : `**${inner}**`;
    case "italic":
      return plain ? inner : `_${inner}_`;
    case "underline":
      return plain ? inner : `__${inner}__`;
    case "strikethrough":
      return plain ? inner : `~~${inner}~~`;
    case "spoiler":
      return plain ? inner : `||${inner}||`;
    case "code": {
      if (plain) {
        return inner;
      }
      const [open, close] = markdownInlineCodeDelimiters(inner);
      return open + inner + close;
    }
    case "url":
      return renderInlineLink(inner, str("url"), plain);
    case "email_address": {
      const email = str("email_address");
      return renderInlineLink(inner || email, email ? `mailto:${email}` : "", plain);
    }
    case "phone_number": {
      const phone = str("phone_number");
      return renderInlineLink(inner || phone, phone ? `tel:${phone}` : "", plain);
    }
    case "mention":
      return inner || (str("username") ? `@${str("username")}` : "");
    case "hashtag":
      return inner || (str("hashtag") ? `#${str("hashtag")}` : "");
    case "custom_emoji":
      return str("alternative_text");
    case "mathematical_expression":
      return str("expression") ? (plain ? str("expression") : `$${str("expression")}$`) : "";
    // Wrappers/leaves with no portable markup and unknown types: render inner text only;
    // never print the raw type string, never throw.
    default:
      return inner;
  }
}

function renderBlock(block: RichBlock, mode: RichRenderMode, depth: number): string {
  if (depth > MAX_DEPTH) {
    return DEPTH_CUTOFF;
  }
  const loose = asLoose(block);
  const type = typeof loose.type === "string" ? loose.type : "";
  switch (type) {
    case "paragraph":
    case "footer":
      // footer treated as a plain paragraph (no extra marker) to stay lean.
      return renderRichText(loose.text, mode, depth).trim();
    case "heading": {
      const text = renderRichText(loose.text, mode, depth).trim();
      if (mode === "plain") {
        return text;
      }
      const rawSize = loose.size;
      const size =
        typeof rawSize === "number" && Number.isInteger(rawSize)
          ? Math.min(Math.max(rawSize, 1), 6)
          : 1;
      return `${"#".repeat(size)} ${text}`;
    }
    case "pre": {
      const inner = renderRichText(loose.text, "plain", depth);
      if (mode === "plain") {
        return inner;
      }
      // Reuse the shared code-fence affix helper so rich and entity rendering can't drift.
      const [open, close] = markdownPreAffixes(
        { language: typeof loose.language === "string" ? loose.language : undefined },
        inner,
      );
      return open + inner + close;
    }
    case "pullquote": {
      const body = renderRichText(loose.text, mode, depth).trim();
      return renderQuoted(body, loose.credit, mode, depth);
    }
    case "blockquote": {
      const body = renderBlocks(loose.blocks, mode, depth + 1);
      return renderQuoted(body, loose.credit, mode, depth);
    }
    case "divider":
      // Drop dividers from plain (gating) text so no stray dashes leak into mentions.
      return mode === "plain" ? "" : "---";
    case "list":
      return renderList(loose, mode, depth);
    case "photo":
      return mediaPlaceholder("<media:image>", loose, mode, depth);
    case "video":
    case "animation":
      return mediaPlaceholder("<media:video>", loose, mode, depth);
    case "audio":
    case "voice_note":
      return mediaPlaceholder("<media:audio>", loose, mode, depth);
    case "table":
      return renderTable(loose, mode, depth);
    case "mathematical_expression": {
      const expr = typeof loose.expression === "string" ? loose.expression : "";
      // Block math: $$...$$ fenced expression in markdown, raw LaTeX in plain gating text.
      return expr ? (mode === "plain" ? expr : `$$${expr}$$`) : "";
    }
    case "map": {
      const loc = asLoose(loose.location);
      const lat = typeof loc.latitude === "number" ? loc.latitude : undefined;
      const lon = typeof loc.longitude === "number" ? loc.longitude : undefined;
      const coords = lat != null && lon != null ? ` (${lat}, ${lon})` : "";
      return [`<media:map>${coords}`, renderCaption(loose.caption, mode, depth)]
        .filter(Boolean)
        .join("\n");
    }
    case "details": {
      const summary =
        loose.summary != null ? renderRichText(loose.summary, mode, depth).trim() : "";
      const head = summary && mode === "markdown" ? `**${summary}**` : summary;
      return [head, renderBlocks(loose.blocks, mode, depth + 1)].filter(Boolean).join("\n\n");
    }
    case "collage":
    case "slideshow":
      return [
        renderBlocks(loose.blocks, mode, depth + 1),
        renderCaption(loose.caption, mode, depth),
      ]
        .filter(Boolean)
        .join("\n\n");
    default:
      return renderFallbackBlock(loose, mode, depth);
  }
}

// Forward-compat fallback for unknown future block types (and anchor/thinking, which carry no
// inbound body): prefer any .text as a paragraph, else recurse into .blocks; never print the type.
function renderFallbackBlock(loose: LooseRecord, mode: RichRenderMode, depth: number): string {
  const text = loose.text;
  if (typeof text === "string" || Array.isArray(text)) {
    return renderRichText(text, mode, depth).trim();
  }
  if (Array.isArray(loose.blocks)) {
    return renderBlocks(loose.blocks, mode, depth + 1);
  }
  return "";
}

function renderQuoted(body: string, credit: unknown, mode: RichRenderMode, depth: number): string {
  const lines: string[] = [];
  if (body) {
    if (mode === "plain") {
      lines.push(body);
    } else {
      for (const line of body.split("\n")) {
        lines.push(`> ${line}`);
      }
    }
  }
  if (credit != null) {
    const creditText = renderRichText(credit, mode, depth).trim();
    if (creditText) {
      // Em dash credit, mirroring a quote attribution line.
      lines.push(mode === "plain" ? `— ${creditText}` : `> — ${creditText}`);
    }
  }
  return lines.join("\n");
}

// RichBlockCaption ({ text, credit? }) used by media/map/collage/slideshow blocks.
// (RichBlockTable.caption is a bare RichText, not this object — handled in renderTable.)
function renderCaption(caption: unknown, mode: RichRenderMode, depth: number): string {
  if (caption == null) {
    return "";
  }
  const c = asLoose(caption);
  const text = c.text != null ? renderRichText(c.text, mode, depth).trim() : "";
  const credit = c.credit != null ? renderRichText(c.credit, mode, depth).trim() : "";
  return [text, credit ? `— ${credit}` : ""].filter(Boolean).join("\n");
}

function mediaPlaceholder(
  tag: string,
  loose: LooseRecord,
  mode: RichRenderMode,
  depth: number,
): string {
  // Spoiler-wrap the placeholder only in markdown; plain gating text keeps the bare tag.
  const placeholder = mode === "markdown" && loose.has_spoiler === true ? `||${tag}||` : tag;
  return [placeholder, renderCaption(loose.caption, mode, depth)].filter(Boolean).join("\n");
}

function renderTable(loose: LooseRecord, mode: RichRenderMode, depth: number): string {
  const rows = (Array.isArray(loose.cells) ? loose.cells : []).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => {
      const c = asLoose(cell);
      // Cell text is optional (invisible cell). Flatten inline, collapse newlines, and escape
      // pipes so a cell cannot break the single-row GFM structure.
      const text = c.text != null ? renderRichText(c.text, mode, depth) : "";
      return text.replace(/\s*\n\s*/g, " ").trim();
    }),
  );
  const caption = loose.caption != null ? renderRichText(loose.caption, mode, depth).trim() : "";
  if (mode === "plain") {
    // Gating text: rows as lines, cells space-joined; no GFM syntax.
    const lines = rows.map((r) => r.join(" ").trim()).filter(Boolean);
    return [...lines, caption].filter(Boolean).join("\n");
  }
  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (cols === 0) {
    return caption;
  }
  const toRow = (r: string[]): string => {
    const cells = r.slice(0, cols);
    while (cells.length < cols) {
      cells.push("");
    }
    return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
  };
  // GFM needs a header row + separator; the first row is treated as the header (Telegram marks
  // header cells with is_header, but GFM cannot express a headerless table). colspan/rowspan
  // collapse to single cells — GFM has no span syntax.
  const grid = [
    toRow(rows[0] ?? []),
    `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map(toRow),
  ].join("\n");
  return [grid, caption].filter(Boolean).join("\n");
}

function renderList(loose: LooseRecord, mode: RichRenderMode, depth: number): string {
  const items = Array.isArray(loose.items) ? (loose.items as RichBlockListItem[]) : [];
  const lines: string[] = [];
  let ordinal = 0;
  for (const rawItem of items) {
    const item = asLoose(rawItem);
    // An explicit value resets the running ordinal (like <li value=N>); later valueless
    // items continue from it, so mixed value/valueless items stay coherently numbered.
    ordinal = typeof item.value === "number" ? item.value : ordinal + 1;
    const marker = resolveListMarker(item, ordinal);
    const label =
      mode === "markdown" && typeof item.label === "string" && item.label
        ? `**${item.label}** `
        : "";
    const content = renderBlocks(item.blocks, mode, depth + 1);
    const contentLines = content ? content.split("\n") : [""];
    const firstLine = `${marker}${label}${contentLines[0] ?? ""}`.trimEnd();
    lines.push(firstLine);
    // Indent continuation/nested lines by two spaces to keep list structure readable.
    for (const extra of contentLines.slice(1)) {
      lines.push(extra ? `  ${extra}` : "");
    }
  }
  return lines.join("\n");
}

const ORDERED_LIST_TYPES = new Set(["a", "A", "i", "I", "1"]);

function resolveListMarker(item: LooseRecord, ordinal: number): string {
  if (item.has_checkbox === true) {
    return item.is_checked === true ? "- [x] " : "- [ ] ";
  }
  const isOrdered =
    typeof item.value === "number" ||
    (typeof item.type === "string" && ORDERED_LIST_TYPES.has(item.type));
  // GFM only renders decimal ordered lists; alpha/roman markers degrade to decimal.
  return isOrdered ? `${ordinal}. ` : "- ";
}
