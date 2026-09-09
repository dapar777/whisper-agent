/** Rozpoznání, zda text ve schránce je odpověď modelu (a ne náš vlastní prompt). */

export function normalizeClipboard(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** Text je jeden z promptů, které agent sám vyrábí. */
export function isOwnPrompt(text: string): boolean {
  const t = normalizeClipboard(text);
  return t.startsWith("<whisper-results") || t.startsWith("# Whisper Agent session");
}

/**
 * Text vypadá jako odpověď modelu: obsahuje otevírací tag s číselným kolem
 * a uzavírací tag, není to náš prompt a není shodný s naposledy zkopírovaným promptem.
 */
export function looksLikeReply(text: string, lastPrompt = ""): boolean {
  const t = normalizeClipboard(text);
  if (!t || t === normalizeClipboard(lastPrompt)) return false;
  if (isOwnPrompt(t)) return false;
  return /<whisper\b[^>]*\bturn\s*=\s*["“”„']?\d+/.test(t) && t.includes("</whisper>");
}
