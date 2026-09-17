/**
 * Kódování a konce řádků souborů.
 *
 * Agent dřív četl i zapisoval vždy UTF-8 bez BOM a s konci řádků, jaké poslal model. U souboru
 * ve Windows-1250 to z diakritiky udělalo zmatek, u souboru s BOM (české Excel CSV, starší
 * projekty) BOM zmizel a u projektu s CRLF se řádky rozešly. Proto se u každého čtení zjistí,
 * jak soubor vypadá, a při zápisu se to zachová: stejné kódování, stejný BOM, stejné konce řádků.
 */

/** Jak je soubor uložený; `utf8` bez BOM a `lf` jsou výchozí pro nové soubory. */
export interface FileEncoding {
  /** název kódování pro TextDecoder (utf8, windows-1250, utf-16le…) */
  encoding: string;
  /** soubor začíná značkou BOM */
  bom: boolean;
  /** převažující konce řádků */
  eol: "lf" | "crlf";
}

export const DEFAULT_ENCODING: FileEncoding = { encoding: "utf8", bom: false, eol: "lf" };

/** Kódování, která umíme číst i zapisovat (zápis jiných než UTF variant přes tabulku níže). */
const SINGLE_BYTE: Record<string, string> = {
  "windows-1250":
    "€�‚�„…†‡�‰Š‹ŚŤŽŹ" +
    "�‘’“”•–—�™š›śťžź" +
    " ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż" +
    "°±˛ł´µ¶·¸ąş»Ľ˝ľż" +
    "ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ" +
    "ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß" +
    "ŕáâăäĺćçčéęëěíîď" +
    "đńňóôőö÷řůúűüýţ˙",
  "windows-1252":
    "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�" +
    "�‘’“”•–—˜™š›œ�žŸ" +
    " ¡¢£¤¥¦§¨©ª«¬­®¯" +
    "°±²³´µ¶·¸¹º»¼½¾¿" +
    "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ" +
    "ÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß" +
    "àáâãäåæçèéêëìíîï" +
    "ðñòóôõö÷øùúûüýþÿ",
  "iso-8859-2":
    "" +
    "" +
    " Ą˘Ł¤ĽŚ§¨ŠŞŤŹ­ŽŻ" +
    "°ą˛ł´ľśˇ¸šşťź˝žż" +
    "ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ" +
    "ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß" +
    "ŕáâăäĺćçčéęëěíîď" +
    "đńňóôőö÷řůúűüýţ˙",
};

/** Normalizuje zápis názvu kódování na to, co používáme dál (utf8, windows-1250…). */
export function normalizeEncoding(name: string | undefined): string {
  const n = (name ?? "").trim().toLowerCase().replace(/[_\s]/g, "-");
  if (!n) return "utf8";
  if (["utf8", "utf-8"].includes(n)) return "utf8";
  if (["utf8bom", "utf-8-bom", "utf8-bom"].includes(n)) return "utf8";
  if (["utf16le", "utf-16le", "utf-16"].includes(n)) return "utf-16le";
  if (["utf16be", "utf-16be"].includes(n)) return "utf-16be";
  if (["cp1250", "win1250", "windows1250", "windows-1250"].includes(n)) return "windows-1250";
  if (["cp1252", "win1252", "windows1252", "windows-1252", "ansi"].includes(n)) return "windows-1252";
  if (["latin2", "iso8859-2", "iso-8859-2"].includes(n)) return "iso-8859-2";
  if (["latin1", "iso8859-1", "iso-8859-1"].includes(n)) return "windows-1252"; // nadmnožina, lepší pro zápis
  return n;
}

/** Skutečně platný UTF-8? (Kontrola podle struktury bajtů, ne podle náhradních znaků.) */
function isValidUtf8(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;
    if (i + need > buf.length - 1) return false; // useknutá sekvence na konci
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if (c < 0x80 || c > 0xbf) return false;
    }
    i += need + 1;
  }
  return true;
}

/**
 * Pozná kódování z bajtů: BOM má přednost, pak platný UTF-8, jinak jednobajtová stránka
 * (`fallback`, výchozí windows-1250 kvůli českým souborům z Windows).
 */
export function detectEncoding(buf: Buffer, fallback = "windows-1250"): FileEncoding {
  const eolOf = (text: string): "lf" | "crlf" => {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    return crlf > lf ? "crlf" : "lf";
  };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf8", bom: true, eol: eolOf(buf.subarray(3).toString("utf8")) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf-16le", bom: true, eol: eolOf(buf.subarray(2).toString("utf16le")) };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf-16be", bom: true, eol: eolOf(decodeBytes(buf.subarray(2), "utf-16be")) };
  }
  // UTF-16 bez BOM: hodně nulových bajtů na sudých/lichých pozicích
  if (buf.length >= 16) {
    let zerosOdd = 0;
    let zerosEven = 0;
    const n = Math.min(buf.length, 512);
    for (let i = 0; i < n; i++) {
      if (buf[i] !== 0) continue;
      if (i % 2) zerosOdd++;
      else zerosEven++;
    }
    if (zerosOdd > n / 8 && zerosEven === 0) return { encoding: "utf-16le", bom: false, eol: eolOf(buf.toString("utf16le")) };
    if (zerosEven > n / 8 && zerosOdd === 0) return { encoding: "utf-16be", bom: false, eol: eolOf(decodeBytes(buf, "utf-16be")) };
  }
  if (isValidUtf8(buf)) return { encoding: "utf8", bom: false, eol: eolOf(buf.toString("utf8")) };
  const enc = normalizeEncoding(fallback);
  return { encoding: SINGLE_BYTE[enc] ? enc : "windows-1250", bom: false, eol: eolOf(decodeBytes(buf, enc)) };
}

/** Bajty → text podle kódování (bez BOM, ten se odstraní). */
export function decodeBytes(buf: Buffer, encoding: string): string {
  const enc = normalizeEncoding(encoding);
  if (enc === "utf8") return buf.toString("utf8").replace(/^﻿/, "");
  if (enc === "utf-16le") return buf.toString("utf16le").replace(/^﻿/, "");
  if (enc === "utf-16be") {
    const swapped = Buffer.allocUnsafe(buf.length - (buf.length % 2));
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString("utf16le").replace(/^﻿/, "");
  }
  const table = SINGLE_BYTE[enc];
  if (!table) return buf.toString("utf8").replace(/^﻿/, "");
  let out = "";
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
  return out;
}

/** Text → bajty podle kódování (a BOM, pokud ho soubor měl). Znak mimo stránku se nahradí „?“. */
export function encodeText(text: string, enc: FileEncoding): Buffer {
  const encoding = normalizeEncoding(enc.encoding);
  if (encoding === "utf8") return Buffer.concat([enc.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
  if (encoding === "utf-16le") return Buffer.concat([enc.bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
  if (encoding === "utf-16be") {
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.allocUnsafe(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    return Buffer.concat([enc.bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), be]);
  }
  const table = SINGLE_BYTE[encoding];
  if (!table) return Buffer.from(text, "utf8");
  const out = Buffer.allocUnsafe(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[i] = code;
      continue;
    }
    const idx = table.indexOf(text[i]);
    out[i] = idx >= 0 ? idx + 0x80 : 0x3f; // "?"
  }
  return out;
}

/** Sjednotí konce řádků na LF (text pro model a pro porovnávání je vždy s LF). */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Vrátí text s konci řádků podle zjištěného stavu souboru. */
export function applyEol(text: string, eol: "lf" | "crlf"): string {
  const lf = toLf(text);
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** Krátký popis pro model a pro uživatele: „UTF-8 s BOM, CRLF“. */
export function describeEncoding(enc: FileEncoding): string {
  const name = enc.encoding === "utf8" ? "UTF-8" : enc.encoding === "utf-16le" ? "UTF-16 LE" : enc.encoding === "utf-16be" ? "UTF-16 BE" : enc.encoding;
  return `${name}${enc.bom ? " s BOM" : ""}, ${enc.eol === "crlf" ? "CRLF" : "LF"}`;
}

/** Stejný popis anglicky (do promptu pro model). */
export function describeEncodingEn(enc: FileEncoding): string {
  const name = enc.encoding === "utf8" ? "UTF-8" : enc.encoding === "utf-16le" ? "UTF-16 LE" : enc.encoding === "utf-16be" ? "UTF-16 BE" : enc.encoding;
  return `${name}${enc.bom ? " with BOM" : ""}, ${enc.eol === "crlf" ? "CRLF" : "LF"} line endings`;
}
