import { Action, BODY_TOOLS, ParsedReply, REQUIRED_ATTRS, TOOL_NAMES } from "./schema";

const CLOSE_TAG = "</whisper>";

/** Normalizuje typografické uvozovky, které chatová UI ráda vkládají. */
function normalizeQuotes(s: string): string {
  return s.replace(/[“”„″]/g, '"').replace(/[‘’‚′]/g, "'");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>\/]+))/g;
  let m: RegExpExecArray | null;
  const src = normalizeQuotes(raw);
  while ((m = re.exec(src))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Odstraní markdown ohraničení, pokud model zabalil celý blok do ``` */
function stripFences(s: string): string {
  return s.replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, "").replace(/\r?\n```[ \t]*$/, "");
}

/**
 * Najde poslední blok <whisper ...>...</whisper> v textu. Bere poslední,
 * protože model může v textu před ním citovat příklad z preambule.
 */
function extractBlock(src: string): { attrs: Record<string, string>; inner: string; start: number } | null {
  const openRe = /<whisper\b(?!-)([^>]*)>/g;
  let last: { attrs: Record<string, string>; start: number; tagStart: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(src))) {
    last = { attrs: parseAttrs(m[1]), start: m.index + m[0].length, tagStart: m.index };
  }
  if (!last) return null;
  let end = src.indexOf(CLOSE_TAG, last.start);
  if (end < 0) end = src.length; // chybějící uzavření tolerujeme, nahlásíme
  return { attrs: last.attrs, inner: src.slice(last.start, end), start: last.tagStart };
}

export function parseReply(text: string): ParsedReply {
  const result: ParsedReply = { turn: null, session: null, actions: [], errors: [], prose: "" };
  const cleaned = normalizeQuotes(stripFences(text.replace(/\r\n/g, "\n")));
  const block = extractBlock(cleaned);
  if (!block) {
    result.errors.push('No <whisper turn="N"> ... </whisper> block found in the reply.');
    result.prose = text.trim();
    return result;
  }
  if (!cleaned.includes(CLOSE_TAG, block.start)) {
    result.errors.push("Missing closing </whisper> tag (the reply may have been cut off).");
  }
  const turn = Number(block.attrs.turn);
  result.turn = block.attrs.turn && !Number.isNaN(turn) ? turn : null;
  result.session = block.attrs.session ?? null;
  result.prose = block.start > 0 ? cleaned.slice(0, block.start).trim() : "";

  parseActions(block.inner, result);
  return result;
}

function parseActions(inner: string, out: ParsedReply): void {
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = tagRe.exec(inner))) {
    const [full, name, rawAttrs, selfClose] = m;
    if (name === "think") {
      const close = inner.indexOf("</think>", m.index);
      tagRe.lastIndex = close < 0 ? inner.length : close + "</think>".length;
      continue;
    }
    if (!TOOL_NAMES.has(name)) {
      out.errors.push(`Unknown action <${name}>; allowed: ${[...TOOL_NAMES].join(", ")}.`);
      continue;
    }
    const attrs = parseAttrs(rawAttrs);
    const action: Action = { tool: name, attrs, index: index++ };
    if (BODY_TOOLS.has(name)) {
      if (selfClose) {
        out.errors.push(`<${name}> requires a body and a closing </${name}> tag.`);
        continue;
      }
      const bodyStart = m.index + full.length;
      const endMarker = attrs.end ? attrs.end : `</${name}>`;
      let end = inner.indexOf(endMarker, bodyStart);
      if (end < 0) {
        out.errors.push(`Missing closing ${endMarker} for <${name}${attrs.path ? ` path="${attrs.path}"` : ""}>.`);
        end = inner.length;
      }
      action.body = trimBody(inner.slice(bodyStart, end));
      let pos = end + endMarker.length;
      // za vlastním end markerem může ještě následovat </name>
      if (attrs.end) {
        const rest = inner.slice(pos).match(/^\s*<\/\w+>/);
        if (rest) pos += rest[0].length;
      }
      tagRe.lastIndex = pos;
    }
    if (validate(action, out)) out.actions.push(action);
  }
  if (out.actions.length === 0 && out.errors.length === 0) {
    out.errors.push("The <whisper> block contains no actions.");
  }
}

/** Odstraní právě jeden úvodní newline a koncové bílé znaky posledního řádku. */
function trimBody(s: string): string {
  return s.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
}

/** Vrátí false, když je akce natolik poškozená, že se nemá vykonat. */
function validate(action: Action, out: ParsedReply): boolean {
  let ok = true;
  for (const a of REQUIRED_ATTRS[action.tool] ?? []) {
    if (!action.attrs[a]) {
      out.errors.push(`<${action.tool}> is missing required attribute "${a}".`);
      ok = false;
    }
  }
  if (BODY_TOOLS.has(action.tool) && action.tool !== "status" && !action.body?.trim()) {
    out.errors.push(`<${action.tool}> has an empty body.`);
    ok = false;
  }
  // zbloudilý uzavírací tag jiné tělové akce uvnitř těla (typicky </write> v <edit>) by se zapsal do souboru
  if ((action.tool === "write" || action.tool === "edit") && action.body) {
    const stray = action.body.match(/^\s*<\/(write|edit|run|ask|status|done)>\s*$/m);
    if (stray && stray[1] !== action.tool) {
      out.errors.push(
        `<${action.tool} path="${action.attrs.path}"> was SKIPPED: its body contains a stray closing tag ${stray[0].trim()} on its own line. Resend that action without it (or use end="MARKER" if the tag is real content).`,
      );
      ok = false;
    }
  }
  return ok;
}
