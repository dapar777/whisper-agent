import { Action, BODY_TOOLS, ParsedReply, REQUIRED_ATTRS, TOOL_NAMES } from "./schema";

const CLOSE_TAG = "</whisper>";

/** Normalizuje typografické uvozovky, které chatová UI ráda vkládají (jen v atributech, těla jsou verbatim). */
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

/** Odstraní markdown ohraničení, pokud model zabalil celou odpověď do ``` */
function stripFences(s: string): string {
  return s.replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, "").replace(/\r?\n```[ \t]*$/, "");
}

/** Za uzavíracím tagem těla musí následovat struktura protokolu (další akce, </whisper>, konec). */
const NEXT_STRUCTURE = new RegExp(`^\\s*(?:<(?:${[...TOOL_NAMES, "think"].join("|")})\\b|</whisper>|$)`);

/**
 * Najde konec těla tělové akce. Tělo dokumentu smí obsahovat text shodný s uzavíracím tagem
 * (návrh, který popisuje tento protokol, ukázka hunku…), proto se bere první výskyt, za nímž
 * pokračuje struktura protokolu; není-li takový, první výskyt vůbec. Vlastní end="MARKER"
 * platí jen na začátku řádku, aby ho neukončil třeba heredoc `<<EOF` v ukázce kódu.
 */
function findBodyEnd(src: string, from: number, marker: string, custom: boolean): number {
  let first = -1;
  let pos = src.indexOf(marker, from);
  while (pos >= 0) {
    const atLineStart = pos === from || src[pos - 1] === "\n" || /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", pos - 1) + 1, pos));
    if (!custom || atLineStart) {
      if (first < 0) first = pos;
      const after = src.slice(pos + marker.length);
      const rest = custom ? after.replace(/^[ \t]*<\/\w+>/, "") : after;
      if (NEXT_STRUCTURE.test(rest)) return pos;
    }
    pos = src.indexOf(marker, pos + marker.length);
  }
  return first;
}

/** Nejbližší uzavírací tag jiné tělové akce, za kterým pokračuje struktura (model zaměnil </edit> a </write>). */
function findWrongClose(src: string, from: number): { tag: string; end: number } | null {
  const re = /<\/(write|edit|run|ask|status|done|plan|suggest|dialog)>/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (NEXT_STRUCTURE.test(src.slice(m.index + m[0].length))) return { tag: m[0], end: m.index + m[0].length };
  }
  return null;
}

interface Scan {
  actions: Action[];
  errors: string[];
  notes: string[];
  /** index uzavíracího </whisper> na úrovni akcí, -1 když chybí */
  close: number;
}

/**
 * Strukturní průchod blokem od `start`: střídají se akce a jejich těla, konec je první
 * </whisper> MIMO tělo akce. Text uvnitř těl (ukázky protokolu v dokumentu) se přeskakuje.
 */
function scanBlock(src: string, start: number): Scan {
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>|<\/whisper>/g;
  tagRe.lastIndex = start;
  const out: Scan = { actions: [], errors: [], notes: [], close: -1 };
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = tagRe.exec(src))) {
    if (m[0] === CLOSE_TAG) {
      out.close = m.index;
      break;
    }
    const [full, name, rawAttrs, selfClose] = m;
    if (name === "think") {
      const close = src.indexOf("</think>", m.index);
      tagRe.lastIndex = close < 0 ? src.length : close + "</think>".length;
      continue;
    }
    if (!TOOL_NAMES.has(name)) {
      // zmínka <whisper> v prose, echo <whisper-results>, HTML v textu mezi akcemi: není to akce
      if (name === "whisper" || name === "whisper-results") continue;
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
      const custom = !!attrs.end;
      const endMarker = custom ? attrs.end : `</${name}>`;
      const end = findBodyEnd(src, bodyStart, endMarker, custom);
      const label = `<${name}${attrs.path ? ` path="${attrs.path}"` : ""}>`;
      if (end < 0) {
        // špatně uzavřené tělo (</write> místo </edit>) nebo useknutá odpověď: akci nevykonat,
        // ale pokračovat za nejbližším uzavíracím tagem, aby se neztratily další akce
        const wrong = findWrongClose(src, bodyStart);
        if (wrong) {
          out.errors.push(`${label} was closed with ${wrong.tag} instead of ${endMarker}; the action was SKIPPED. Resend it with the right closing tag.`);
          tagRe.lastIndex = wrong.end;
          continue;
        }
        out.errors.push(`Missing closing ${endMarker} for ${label}; the action was SKIPPED (the reply may have been cut off). Resend it complete.`);
        break;
      }
      action.body = trimBody(src.slice(bodyStart, end));
      let pos = end + endMarker.length;
      if (custom) {
        const rest = src.slice(pos).match(/^[ \t]*<\/\w+>/);
        if (rest) pos += rest[0].length;
      }
      tagRe.lastIndex = pos;
    }
    if (validate(action, out)) out.actions.push(action);
  }
  return out;
}

interface Candidate {
  attrs: Record<string, string>;
  tagStart: number;
  start: number;
  scan: Scan;
}

/**
 * Vybere správný blok. Otevíracích tagů může být víc: ukázka v prose, zmínka „blok <whisper>“
 * ve shrnutí, příklad uvnitř zapisovaného dokumentu. Kandidáti ležící uvnitř jiného uzavřeného
 * kandidáta se zahodí; z ostatních se bere ten s akcemi a uzavřením, přednostně s číselným kolem
 * (a s očekávaným kolem, je-li známé); při shodě poslední.
 */
function pickBlock(src: string, expectedTurn?: number): Candidate | null {
  const openRe = /<whisper\b(?!-)([^>]*)>/g;
  const all: Candidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(src))) {
    const start = m.index + m[0].length;
    all.push({ attrs: parseAttrs(m[1]), tagStart: m.index, start, scan: scanBlock(src, start) });
  }
  if (!all.length) return null;
  const top: Candidate[] = [];
  let coveredUntil = -1;
  for (const c of all) {
    if (c.tagStart < coveredUntil) continue;
    top.push(c);
    if (c.scan.close >= 0) coveredUntil = c.scan.close + CLOSE_TAG.length;
  }
  const score = (c: Candidate): number => {
    const turn = Number(c.attrs.turn);
    let s = 0;
    if (c.scan.actions.length) s += 100;
    if (c.scan.close >= 0) s += 10;
    if (c.attrs.turn && !Number.isNaN(turn)) s += 5;
    if (expectedTurn !== undefined && turn === expectedTurn) s += 3;
    return s;
  };
  let best = top[0];
  for (const c of top) if (score(c) >= score(best)) best = c;
  return best;
}

/**
 * Rozebere odpověď modelu. `expectedTurn` (číslo kola, na které se čeká) pomáhá vybrat správný
 * blok, když jich odpověď obsahuje víc.
 */
export function parseReply(text: string, expectedTurn?: number): ParsedReply {
  const result: ParsedReply = { turn: null, session: null, actions: [], errors: [], notes: [], prose: "", raw: text };
  const cleaned = stripFences(text.replace(/\r\n/g, "\n"));
  const block = pickBlock(cleaned, expectedTurn);
  if (!block) {
    result.errors.push('No <whisper turn="N"> ... </whisper> block found in the reply.');
    result.prose = text.trim();
    return result;
  }
  if (block.scan.close < 0) {
    result.errors.push("Missing closing </whisper> tag (the reply may have been cut off).");
  }
  const turn = Number(block.attrs.turn);
  result.turn = block.attrs.turn && !Number.isNaN(turn) ? turn : null;
  result.session = block.attrs.session ?? null;
  result.prose = block.tagStart > 0 ? cleaned.slice(0, block.tagStart).trim() : "";
  result.actions = block.scan.actions;
  result.errors.push(...block.scan.errors);
  result.notes.push(...block.scan.notes);
  if (result.actions.length === 0 && block.scan.errors.length === 0) {
    result.errors.push("The <whisper> block contains no actions.");
  }
  return result;
}

/** Odstraní právě jeden úvodní newline a koncové bílé znaky posledního řádku. */
function trimBody(s: string): string {
  return s.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
}

/** Model občas HTML-escapuje značky hunků uvnitř dokumentu, aby „nerozbil“ agenta; do souboru patří skutečné znaky. */
function decodeHunkMarkers(body: string): string {
  return body
    .replace(/^(\s*)(?:&lt;){5,}(\s*SEARCH)/gm, (_m, ws: string, tail: string) => `${ws}<<<<<<<${tail}`)
    .replace(/^(\s*)(?:&gt;){5,}(\s*REPLACE)/gm, (_m, ws: string, tail: string) => `${ws}>>>>>>>${tail}`);
}

/** Tělo zabalené celé do ``` … ``` (model „pro jistotu“): ohrazení pryč, obsah zůstává. */
function stripBodyFence(body: string): string | null {
  const m = body.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
  return m ? m[1] : null;
}

/** Vrátí false, když je akce natolik poškozená, že se nemá vykonat. */
function validate(action: Action, out: Scan): boolean {
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
  if (action.tool === "write" && action.body) {
    const unfenced = stripBodyFence(action.body);
    if (unfenced !== null) {
      action.body = unfenced;
      out.notes.push(`<write path="${action.attrs.path}">: the whole body was wrapped in a \`\`\` fence; the fence was removed, bodies are verbatim.`);
    }
    action.body = decodeHunkMarkers(action.body);
  }
  return ok;
}
