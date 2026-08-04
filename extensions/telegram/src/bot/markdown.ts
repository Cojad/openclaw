// Telegram markdown affix helpers shared by entity rendering and rich rendering.
// Kept dependency-free (acyclic) so both body-helpers and rich-render can reuse them.

// Minimal entity shape: only the language hint is consumed for code-fence affixes.
type TelegramPreEntity = { language?: string };

export function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function markdownInlineCodeDelimiters(content: string): [string, string] {
  const delimiter = "`".repeat(longestBacktickRun(content) + 1);
  if (content.startsWith(" ") || content.endsWith(" ")) {
    return [`${delimiter} `, ` ${delimiter}`];
  }
  return [delimiter, delimiter];
}

export function markdownPreAffixes(entity: TelegramPreEntity, content: string): [string, string] {
  const language = entity.language?.replace(/[\s`]+/g, "").trim();
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const opener = language ? `${fence}${language}\n` : `${fence}\n`;
  const closer = content.endsWith("\n") ? fence : `\n${fence}`;
  return [opener, closer];
}
