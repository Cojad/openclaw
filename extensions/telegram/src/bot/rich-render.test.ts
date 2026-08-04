// Tests cover the inbound Telegram rich_message renderer (rich-render.ts).
// The renderer must be pure and total: it never throws, even on malformed/exotic
// payloads, because a throw would reach polling spool release and risk a replay loop.
import { describe, expect, it } from "vitest";
import {
  renderRichCommandText,
  type RichRenderMode,
  renderRichMessageToText,
} from "./rich-render.js";

// Helper: wrap a single block in a RichMessage and render it.
function renderBlock(block: unknown, mode: RichRenderMode = "markdown"): string {
  return renderRichMessageToText({ blocks: [block] } as never, mode);
}

// Helper: render a single inline RichText node inside a paragraph so we exercise
// the inline mapping through the public entry point.
function renderInline(text: unknown, mode: RichRenderMode = "markdown"): string {
  return renderBlock({ type: "paragraph", text }, mode);
}

describe("renderRichMessageToText — real payload", () => {
  it("renders the contiguous inline run with inline code backticks", () => {
    // Real Telegram payload shape: ["text", {code...}, "text"].
    const text = ["對，", { type: "code", text: "message" }, " update"];
    expect(renderInline(text)).toBe("對，`message` update");
  });

  it("strips inline code affixes in plain mode", () => {
    const text = ["對，", { type: "code", text: "message" }, " update"];
    expect(renderInline(text, "plain")).toBe("對，message update");
  });
});

describe("renderRichMessageToText — inline RichText wraps (markdown)", () => {
  // Affixes intentionally match renderTelegramTextEntities (see helpers.test.ts:882+)
  // so entity-rendered and rich-rendered text stay consistent.
  it.each([
    { name: "bold", node: { type: "bold", text: "x" }, expected: "**x**" },
    { name: "italic", node: { type: "italic", text: "x" }, expected: "_x_" },
    { name: "underline", node: { type: "underline", text: "x" }, expected: "__x__" },
    { name: "strikethrough", node: { type: "strikethrough", text: "x" }, expected: "~~x~~" },
    { name: "spoiler", node: { type: "spoiler", text: "x" }, expected: "||x||" },
    { name: "code", node: { type: "code", text: "x" }, expected: "`x`" },
    // GFM has no <mark>; bold is the chosen portable fallback.
    { name: "marked -> bold", node: { type: "marked", text: "x" }, expected: "**x**" },
    {
      name: "url",
      node: { type: "url", text: "docs", url: "https://e.x" },
      expected: "[docs](https://e.x)",
    },
    { name: "mention", node: { type: "mention", text: "@bob", username: "bob" }, expected: "@bob" },
    {
      name: "mention field fallback",
      node: { type: "mention", username: "bob" },
      expected: "@bob",
    },
    {
      name: "hashtag",
      node: { type: "hashtag", text: "#tag", hashtag: "tag" },
      expected: "#tag",
    },
    {
      name: "hashtag field fallback",
      node: { type: "hashtag", hashtag: "tag" },
      expected: "#tag",
    },
  ])("renders $name", ({ node, expected }) => {
    expect(renderInline(node)).toBe(expected);
  });

  it("renders custom_emoji as alternative_text (leaf, no .text)", () => {
    expect(
      renderInline({ type: "custom_emoji", custom_emoji_id: "1", alternative_text: "🙂" }),
    ).toBe("🙂");
  });

  it("renders custom_emoji as empty when alternative_text is missing", () => {
    expect(renderInline({ type: "custom_emoji", custom_emoji_id: "1" })).toBe("");
  });

  it("renders leaf mathematical_expression as $expr$", () => {
    expect(renderInline({ type: "mathematical_expression", expression: "a+b" })).toBe("$a+b$");
  });

  it("renders an unknown RichText type as its inner text without throwing", () => {
    expect(() => renderInline({ type: "totally_new_inline_type_v9", text: "inner" })).not.toThrow();
    const out = renderInline({ type: "totally_new_inline_type_v9", text: "inner" });
    expect(out).toBe("inner");
    // Forward-compat: never leak the raw type string into flattened text.
    expect(out).not.toContain("totally_new_inline_type_v9");
  });

  it("renders an unknown leaf RichText type as empty (no inner text)", () => {
    const out = renderInline({ type: "totally_new_leaf_v9" });
    expect(out).toBe("");
    expect(out).not.toContain("totally_new_leaf_v9");
  });

  it("escapes ()/whitespace in a link destination so parens can't break the link", () => {
    expect(renderInline({ type: "url", text: "wiki", url: "https://e.x/Foo_(bar)" })).toBe(
      "[wiki](https://e.x/Foo_\\(bar\\))",
    );
  });

  it("renders an email_address as an escaped mailto link", () => {
    expect(renderInline({ type: "email_address", text: "me", email_address: "a@b.c" })).toBe(
      "[me](mailto:a@b.c)",
    );
  });
});

describe("renderRichMessageToText — inline RichText wraps (plain)", () => {
  it.each([
    { name: "bold", node: { type: "bold", text: "x" }, expected: "x" },
    { name: "italic", node: { type: "italic", text: "x" }, expected: "x" },
    { name: "underline", node: { type: "underline", text: "x" }, expected: "x" },
    { name: "strikethrough", node: { type: "strikethrough", text: "x" }, expected: "x" },
    { name: "spoiler", node: { type: "spoiler", text: "x" }, expected: "x" },
    { name: "code", node: { type: "code", text: "x" }, expected: "x" },
    { name: "marked", node: { type: "marked", text: "x" }, expected: "x" },
  ])("strips $name affixes for gating text", ({ node, expected }) => {
    expect(renderInline(node, "plain")).toBe(expected);
  });

  it("keeps url link text only (no parens) in plain mode", () => {
    expect(renderInline({ type: "url", text: "docs", url: "https://e.x" }, "plain")).toBe("docs");
  });
});

describe("renderRichMessageToText — first-class blocks", () => {
  it("renders a paragraph", () => {
    expect(renderBlock({ type: "paragraph", text: "hello" })).toBe("hello");
  });

  it("renders a footer as a plain paragraph", () => {
    expect(renderBlock({ type: "footer", text: "the footer" })).toBe("the footer");
  });

  it.each([
    { size: 1, expected: "# Title" },
    { size: 2, expected: "## Title" },
    { size: 3, expected: "### Title" },
    { size: 6, expected: "###### Title" },
    // Out-of-range sizes clamp into [1, 6].
    { size: 0, expected: "# Title" },
    { size: 9, expected: "###### Title" },
  ])("renders heading size $size as $expected", ({ size, expected }) => {
    expect(renderBlock({ type: "heading", text: "Title", size })).toBe(expected);
  });

  it("defaults heading to level 1 when size is missing/non-integer", () => {
    expect(renderBlock({ type: "heading", text: "Title" })).toBe("# Title");
    expect(renderBlock({ type: "heading", text: "Title", size: 2.5 })).toBe("# Title");
  });

  it("renders heading without prefix in plain mode", () => {
    expect(renderBlock({ type: "heading", text: "Title", size: 3 }, "plain")).toBe("Title");
  });

  it("renders pre as a fenced code block with language", () => {
    expect(renderBlock({ type: "pre", text: "const x = 1;", language: "ts" })).toBe(
      "```ts\nconst x = 1;\n```",
    );
  });

  it("widens the pre fence so it cannot close inside the content", () => {
    expect(renderBlock({ type: "pre", text: "a\n```\nb", language: "md" })).toBe(
      "````md\na\n```\nb\n````",
    );
  });

  it("renders pre as raw inner text in plain mode", () => {
    expect(renderBlock({ type: "pre", text: "const x = 1;", language: "ts" }, "plain")).toBe(
      "const x = 1;",
    );
  });

  it("renders a pullquote with > prefix and em-dash credit", () => {
    expect(renderBlock({ type: "pullquote", text: "to be or not", credit: "Shakespeare" })).toBe(
      "> to be or not\n> — Shakespeare",
    );
  });

  it("renders a pullquote without quote prefix in plain mode", () => {
    expect(
      renderBlock({ type: "pullquote", text: "to be or not", credit: "Shakespeare" }, "plain"),
    ).toBe("to be or not\n— Shakespeare");
  });

  it("renders a blockquote by recursing into nested blocks with > prefix", () => {
    const block = {
      type: "blockquote",
      blocks: [
        { type: "paragraph", text: "first line" },
        { type: "paragraph", text: "second line" },
      ],
      credit: "Author",
    };
    expect(renderBlock(block)).toBe("> first line\n> \n> second line\n> — Author");
  });

  it.each([
    { mode: "markdown" as const, expected: "---" },
    // Dividers vanish in plain (gating) text so stray dashes do not leak into mentions.
    { mode: "plain" as const, expected: "" },
  ])("renders divider in $mode mode", ({ mode, expected }) => {
    expect(renderBlock({ type: "divider" }, mode)).toBe(expected);
  });
});

describe("renderRichMessageToText — lists", () => {
  function listItem(text: string, extra: Record<string, unknown> = {}): unknown {
    return { blocks: [{ type: "paragraph", text }], ...extra };
  }

  it("renders an unordered list", () => {
    const block = { type: "list", items: [listItem("one"), listItem("two")] };
    expect(renderBlock(block)).toBe("- one\n- two");
  });

  it("renders an ordered list using item.value", () => {
    const block = {
      type: "list",
      items: [listItem("first", { value: 1 }), listItem("second", { value: 2 })],
    };
    expect(renderBlock(block)).toBe("1. first\n2. second");
  });

  it("continues ordered numbering from an explicit value (like <li value=N>)", () => {
    const block = {
      type: "list",
      items: [
        listItem("a", { type: "1", value: 5 }),
        listItem("b", { type: "1" }),
        listItem("c", { type: "1" }),
      ],
    };
    expect(renderBlock(block)).toBe("5. a\n6. b\n7. c");
  });

  it("renders checkbox items (checked and unchecked)", () => {
    const block = {
      type: "list",
      items: [
        listItem("done", { has_checkbox: true, is_checked: true }),
        listItem("todo", { has_checkbox: true, is_checked: false }),
      ],
    };
    expect(renderBlock(block)).toBe("- [x] done\n- [ ] todo");
  });

  it("degrades an alpha-typed ordered list to decimal markers", () => {
    // GFM only renders decimal ordered lists; alpha/roman markers degrade to decimal.
    const block = {
      type: "list",
      items: [listItem("alpha", { type: "a" }), listItem("beta", { type: "a" })],
    };
    expect(renderBlock(block)).toBe("1. alpha\n2. beta");
  });

  it("renders a bold label before list item content in markdown mode", () => {
    const block = { type: "list", items: [listItem("value", { label: "Key" })] };
    expect(renderBlock(block)).toBe("- **Key** value");
  });

  it("omits the bold label in plain mode", () => {
    const block = { type: "list", items: [listItem("value", { label: "Key" })] };
    expect(renderBlock(block, "plain")).toBe("- value");
  });

  it("indents nested item blocks under the marker line", () => {
    const block = {
      type: "list",
      items: [
        {
          blocks: [
            { type: "paragraph", text: "parent" },
            { type: "list", items: [listItem("child")] },
          ],
        },
      ],
    };
    // First line on the marker, nested lines indented by two spaces; blank
    // continuation lines stay empty (not indented).
    expect(renderBlock(block)).toBe("- parent\n\n  - child");
  });
});

describe("renderRichMessageToText — media blocks", () => {
  it.each([
    { type: "photo", tag: "<media:image>" },
    { type: "video", tag: "<media:video>" },
    { type: "animation", tag: "<media:video>" },
    { type: "audio", tag: "<media:audio>" },
    { type: "voice_note", tag: "<media:audio>" },
  ])("renders $type as the $tag placeholder", ({ type, tag }) => {
    expect(renderBlock({ type })).toBe(tag);
  });

  it("appends the caption.text (caption is an object, not a string)", () => {
    const block = { type: "photo", caption: { text: "a sunset" } };
    expect(renderBlock(block)).toBe("<media:image>\na sunset");
  });

  it("renders inline-formatted caption text", () => {
    const block = { type: "photo", caption: { text: ["see ", { type: "bold", text: "this" }] } };
    expect(renderBlock(block)).toBe("<media:image>\nsee **this**");
  });

  it("spoiler-wraps the placeholder in markdown when has_spoiler is set", () => {
    const block = { type: "photo", has_spoiler: true, caption: { text: "hidden" } };
    expect(renderBlock(block)).toBe("||<media:image>||\nhidden");
  });

  it("does not spoiler-wrap the placeholder in plain mode", () => {
    const block = { type: "photo", has_spoiler: true, caption: { text: "hidden" } };
    expect(renderBlock(block, "plain")).toBe("<media:image>\nhidden");
  });
});

describe("renderRichMessageToText — generic fallback for exotic blocks", () => {
  it("renders an unknown future block via its .text when present", () => {
    const out = renderBlock({ type: "some_future_block", text: "summary text" });
    expect(out).toBe("summary text");
    expect(out).not.toContain("some_future_block");
  });

  it("renders an unknown future container block via its nested .blocks", () => {
    const block = {
      type: "some_future_container",
      blocks: [{ type: "paragraph", text: "cell body" }],
    };
    const out = renderBlock(block);
    expect(out).toBe("cell body");
    expect(out).not.toContain("some_future_container");
  });

  it("renders an unknown block with neither .text nor .blocks as empty", () => {
    const out = renderBlock({ type: "some_unknown_block", foo: 1 });
    expect(out).toBe("");
    expect(out).not.toContain("some_unknown_block");
  });
});

describe("renderRichMessageToText — table / math / map / details / collage blocks", () => {
  it("renders a block-level mathematical_expression as a fenced $$ expression", () => {
    expect(renderBlock({ type: "mathematical_expression", expression: "x^2" })).toBe("$$x^2$$");
    expect(renderBlock({ type: "mathematical_expression", expression: "x^2" }, "plain")).toBe(
      "x^2",
    );
  });

  it("renders a table as a GFM pipe table with a header separator", () => {
    const out = renderBlock({
      type: "table",
      cells: [
        [
          { text: "Item", is_header: true },
          { text: "Price", is_header: true },
        ],
        [{ text: "Tea" }, { text: ["$", { type: "code", text: "5" }] }],
      ],
    });
    expect(out).toBe("| Item | Price |\n| --- | --- |\n| Tea | $`5` |");
  });

  it("escapes pipes and collapses newlines inside table cells", () => {
    const out = renderBlock({ type: "table", cells: [[{ text: "a|b" }, { text: "c\nd" }]] });
    expect(out).toBe("| a\\|b | c d |\n| --- | --- |");
  });

  it("pads ragged table rows and appends the table caption", () => {
    const out = renderBlock({
      type: "table",
      cells: [[{ text: "A" }, { text: "B" }], [{ text: "1" }]],
      caption: "tbl",
    });
    expect(out).toBe("| A | B |\n| --- | --- |\n| 1 |  |\ntbl");
  });

  it("renders a table as plain space-joined rows for gating", () => {
    const out = renderBlock(
      {
        type: "table",
        cells: [
          [{ text: "Item" }, { text: "Price" }],
          [{ text: "Tea" }, { text: "5" }],
        ],
      },
      "plain",
    );
    expect(out).toBe("Item Price\nTea 5");
  });

  it("renders a map block as a coordinate placeholder plus caption", () => {
    const out = renderBlock({
      type: "map",
      location: { latitude: 25.03, longitude: 121.56 },
      zoom: 15,
      width: 600,
      height: 400,
      caption: { text: "Taipei" },
    });
    expect(out).toBe("<media:map> (25.03, 121.56)\nTaipei");
  });

  it("renders a details block as a bold summary plus its body", () => {
    const out = renderBlock({
      type: "details",
      summary: "More",
      blocks: [{ type: "paragraph", text: "hidden body" }],
    });
    expect(out).toBe("**More**\n\nhidden body");
  });

  it("renders a collage as its media blocks plus caption", () => {
    const out = renderBlock({
      type: "collage",
      blocks: [{ type: "photo" }, { type: "video" }],
      caption: { text: "trip" },
    });
    expect(out).toBe("<media:image>\n\n<media:video>\n\ntrip");
  });

  it("never throws for any exotic/unknown block type", () => {
    for (const block of [
      { type: "details", summary: "s", blocks: [], is_open: true },
      { type: "collage", blocks: [{ type: "photo" }] },
      { type: "slideshow", blocks: [] },
      { type: "anchor", name: "top" },
      { type: "table", cells: [[{}]] },
      { type: "brand_new_block_type" },
    ]) {
      expect(() => renderBlock(block)).not.toThrow();
    }
  });
});

describe("renderRichMessageToText — robustness", () => {
  it("ignores a thinking block (never inbound) producing empty output", () => {
    // thinking has .text, so fallback would render it; assert it does not crash and,
    // when empty, yields empty output.
    expect(renderBlock({ type: "thinking" })).toBe("");
    expect(renderBlock({ type: "thinking", text: "" })).toBe("");
  });

  it("returns an empty string for a message with no blocks", () => {
    expect(renderRichMessageToText({ blocks: [] } as never)).toBe("");
    expect(renderRichMessageToText({} as never)).toBe("");
  });

  it("drops whitespace-only blocks and trims the result", () => {
    const blocks = [
      { type: "paragraph", text: "   " },
      { type: "paragraph", text: "real" },
      { type: "paragraph", text: "" },
    ];
    expect(renderRichMessageToText({ blocks } as never)).toBe("real");
  });

  it("ignores the is_rtl presentation flag (text is unaffected)", () => {
    const ltr = renderRichMessageToText({ blocks: [{ type: "paragraph", text: "hi" }] } as never);
    const rtl = renderRichMessageToText({
      blocks: [{ type: "paragraph", text: "hi" }],
      is_rtl: true,
    } as never);
    expect(rtl).toBe(ltr);
  });

  it("does not throw on missing/null fields", () => {
    const cases: unknown[] = [
      { type: "paragraph" },
      { type: "heading" },
      { type: "pre" },
      { type: "pullquote" },
      { type: "blockquote" },
      { type: "list" },
      { type: "list", items: [{}] },
      { type: "list", items: [null] },
      { type: "photo", caption: null },
      null,
      undefined,
      "not-an-object",
      42,
    ];
    for (const block of cases) {
      expect(() => renderBlock(block)).not.toThrow();
    }
  });

  it("does not throw and stops at the depth cap for deeply nested blocks", () => {
    // Build nesting deeper than MAX_DEPTH (32) to exercise the recursion cutoff.
    let nested: unknown = { type: "paragraph", text: "bottom" };
    for (let i = 0; i < 50; i += 1) {
      nested = { type: "blockquote", blocks: [nested] };
    }
    expect(() => renderBlock(nested)).not.toThrow();
    const out = renderBlock(nested);
    expect(typeof out).toBe("string");
  });

  it("does not throw and stops at the depth cap for deeply nested inline wraps", () => {
    // Inline trees are hostile input too: a deep wrap chain (nested bold) would
    // overflow the call stack without the inline-path depth cap.
    let nested: unknown = "bottom";
    for (let i = 0; i < 5000; i += 1) {
      nested = { type: "bold", text: nested };
    }
    expect(() => renderInline(nested)).not.toThrow();
    const out = renderInline(nested);
    expect(typeof out).toBe("string");
  });

  it("does not throw and stops at the depth cap for deeply nested inline arrays", () => {
    // Nested RichText[] arrays are another inline descent the cap must cover.
    let nested: unknown = ["bottom"];
    for (let i = 0; i < 5000; i += 1) {
      nested = [nested];
    }
    expect(() => renderInline(nested)).not.toThrow();
    expect(typeof renderInline(nested)).toBe("string");
  });

  it("does not throw on a self-referential (cyclic) block payload", () => {
    const cyclic: Record<string, unknown> = { type: "blockquote" };
    cyclic.blocks = [cyclic];
    expect(() => renderBlock(cyclic)).not.toThrow();
  });
});

describe("renderRichMessageToText — binary/control-char content", () => {
  // The binary guard lives in getTelegramTextParts (the caller); the renderer itself
  // must still not throw when handed control-char payloads (e.g. a pre/code block).
  it("does not throw on control chars in a pre block", () => {
    const block = { type: "pre", text: "PK\x00\x03\x04binary", language: "bin" };
    expect(() => renderBlock(block)).not.toThrow();
    expect(renderBlock(block)).toContain("PK");
  });

  it("does not throw on control chars in an inline code node", () => {
    const node = { type: "code", text: "\x00\x01\x02" };
    expect(() => renderInline(node)).not.toThrow();
  });
});

describe("renderRichMessageToText — multi-block joining", () => {
  it("joins blocks with a blank line", () => {
    const blocks = [
      { type: "paragraph", text: "one" },
      { type: "paragraph", text: "two" },
    ];
    expect(renderRichMessageToText({ blocks } as never)).toBe("one\n\ntwo");
  });

  it("concatenates mixed first-class and fallback blocks", () => {
    const blocks = [
      { type: "heading", text: "Title", size: 2 },
      { type: "paragraph", text: "body" },
      { type: "divider" },
      { type: "photo", caption: { text: "pic" } },
    ];
    expect(renderRichMessageToText({ blocks } as never)).toBe(
      "## Title\n\nbody\n\n---\n\n<media:image>\npic",
    );
  });
});

describe("renderRichCommandText — prose-only command gating", () => {
  it("ignores a code/pre block beginning with a slash command", () => {
    // A code snippet starting with /restart must not be misread as a typed control command.
    const rich = { blocks: [{ type: "pre", text: "/restart now", language: "sh" }] };
    expect(renderRichCommandText(rich as never)).toBe("");
  });

  it("ignores a blockquote beginning with a slash command", () => {
    const rich = {
      blocks: [{ type: "blockquote", blocks: [{ type: "paragraph", text: "/deploy" }] }],
    };
    expect(renderRichCommandText(rich as never)).toBe("");
  });

  it("keeps a slash command typed in a paragraph", () => {
    const rich = { blocks: [{ type: "paragraph", text: "/help me" }] };
    expect(renderRichCommandText(rich as never)).toBe("/help me");
  });
});
