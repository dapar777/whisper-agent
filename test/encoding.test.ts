import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NodeHost } from "../src/host/NodeHost";
import { TurnEngine } from "../src/agent/TurnEngine";
import { createSession } from "../src/session/SessionData";
import { applyEol, decodeBytes, describeEncodingEn, detectEncoding, encodeText, normalizeEncoding, toLf } from "../src/tools/encoding";

const CZ = "Příliš žluťoučký kůň úpěl ďábelské ódy.";

function hostIn(files: Record<string, Buffer | string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-enc-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content as never);
  }
  return { root, host: new NodeHost(root, { autoConfirm: true, log: () => undefined }) };
}

describe("detectEncoding", () => {
  it("recognises UTF-8, UTF-8 with BOM, UTF-16 and windows-1250", () => {
    expect(detectEncoding(Buffer.from(CZ, "utf8"))).toEqual({ encoding: "utf8", bom: false, eol: "lf" });
    expect(detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CZ, "utf8")]))).toMatchObject({ encoding: "utf8", bom: true });
    expect(detectEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CZ, "utf16le")]))).toMatchObject({ encoding: "utf-16le", bom: true });
    // stejný text ve windows-1250 není platný UTF-8, takže padne na fallback
    const cp1250 = encodeText(CZ, { encoding: "windows-1250", bom: false, eol: "lf" });
    expect(detectEncoding(cp1250)).toMatchObject({ encoding: "windows-1250", bom: false });
    expect(decodeBytes(cp1250, "windows-1250")).toBe(CZ);
  });

  it("recognises line endings and keeps ASCII files as UTF-8", () => {
    expect(detectEncoding(Buffer.from("a\r\nb\r\nc\r\n")).eol).toBe("crlf");
    expect(detectEncoding(Buffer.from("a\nb\nc\n")).eol).toBe("lf");
    expect(detectEncoding(Buffer.from("plain ascii\n")).encoding).toBe("utf8");
    expect(detectEncoding(Buffer.alloc(0))).toEqual({ encoding: "utf8", bom: false, eol: "lf" });
  });

  it("normalises encoding names and describes them for the model", () => {
    expect(normalizeEncoding("CP1250")).toBe("windows-1250");
    expect(normalizeEncoding("UTF-8")).toBe("utf8");
    expect(normalizeEncoding("latin1")).toBe("windows-1252");
    expect(describeEncodingEn({ encoding: "windows-1250", bom: false, eol: "crlf" })).toBe("windows-1250, CRLF line endings");
    expect(describeEncodingEn({ encoding: "utf8", bom: true, eol: "lf" })).toBe("UTF-8 with BOM, LF line endings");
  });

  it("round-trips text through every supported encoding and replaces what does not fit", () => {
    for (const enc of ["utf8", "windows-1250", "iso-8859-2", "utf-16le", "utf-16be"]) {
      const buf = encodeText(CZ, { encoding: enc, bom: false, eol: "lf" });
      expect(decodeBytes(buf, enc), enc).toBe(CZ);
    }
    // znak mimo kódovou stránku: "?" místo rozbitého bajtu
    expect(decodeBytes(encodeText("cena 5 €uro ☃", { encoding: "iso-8859-2", bom: false, eol: "lf" }), "iso-8859-2")).toBe("cena 5 ?uro ?");
    expect(applyEol("a\nb", "crlf")).toBe("a\r\nb");
    expect(toLf("a\r\nb")).toBe("a\nb");
  });
});

describe("host keeps the encoding of an existing file", () => {
  it("reads windows-1250 correctly and writes it back in the same encoding", async () => {
    const cp1250 = encodeText(`# Popis\n${CZ}\n`, { encoding: "windows-1250", bom: false, eol: "lf" });
    const { root, host } = hostIn({ "doc.txt": cp1250 });
    expect(await host.readFile("doc.txt")).toBe(`# Popis\n${CZ}\n`);
    expect(await host.fileEncoding("doc.txt")).toMatchObject({ encoding: "windows-1250", bom: false });
    await host.writeFile("doc.txt", `# Popis\n${CZ}\nnový řádek s háčky\n`);
    const raw = fs.readFileSync(path.join(root, "doc.txt"));
    expect(detectEncoding(raw)).toMatchObject({ encoding: "windows-1250" });
    expect(decodeBytes(raw, "windows-1250")).toContain("nový řádek s háčky");
    expect(raw.includes(Buffer.from("nový", "utf8"))).toBe(false); // opravdu ne UTF-8
  });

  it("keeps a BOM and CRLF (Czech Excel CSV) through an <edit>", async () => {
    const csv = encodeText("id;nazev\r\n1;Příliš\r\n", { encoding: "utf8", bom: true, eol: "crlf" });
    const { root, host } = hostIn({ "tasks.csv": csv });
    const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50, reviewBeforeDone: false });
    const s = createSession("Přidej řádek.", "stateful");
    const reply = '<whisper turn="1">\n<edit path="tasks.csv">\n<<<<<<< SEARCH\n1;Příliš\n=======\n1;Příliš\n2;Žluťoučký\n>>>>>>> REPLACE\n</edit>\n<done>ok</done>\n</whisper>';
    const step = await engine.execute(s, engine.parse(reply, 1), 1000);
    expect(step.kind).toBe("done");
    const raw = fs.readFileSync(path.join(root, "tasks.csv"));
    expect(raw[0]).toBe(0xef); // BOM zůstal
    expect(detectEncoding(raw)).toMatchObject({ encoding: "utf8", bom: true, eol: "crlf" });
    expect(decodeBytes(raw, "utf8")).toBe("id;nazev\r\n1;Příliš\r\n2;Žluťoučký\r\n");
  });

  it("tells the model the encoding of a non-plain file in <read> and <write> results", async () => {
    const { host } = hostIn({
      // applyEol se v encodeText nevolá, konce řádků musí do textu vložit volající
      "cp.txt": encodeText(applyEol(`${CZ}\ndruhý řádek\n`, "crlf"), { encoding: "windows-1250", bom: false, eol: "crlf" }),
      "plain.txt": Buffer.from("hello\n", "utf8"),
    });
    const engine = new TurnEngine(host, { mode: "stateful", maxChars: 60000, resultMaxChars: 12000, language: "cs", treeMaxEntries: 50, reviewBeforeDone: false });
    const s = createSession("Přečti oba soubory.", "stateful");
    const step = await engine.execute(s, engine.parse('<whisper turn="1">\n<read path="cp.txt"/>\n<read path="plain.txt"/>\n</whisper>', 1), 1000);
    if (step.kind !== "next") throw new Error("unreachable");
    expect(step.prompt).toContain('path="cp.txt" status="ok" totalLines="3" encoding="windows-1250, CRLF line endings"');
    expect(step.prompt).toContain('path="plain.txt" status="ok" totalLines="2">'); // prosté UTF-8 se nehlásí
    expect(step.prompt).toContain(CZ);
  });

  it("writes new files as UTF-8 with LF and honours defaultEncoding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-enc-"));
    const host = new NodeHost(root, { autoConfirm: true, log: () => undefined });
    await host.writeFile("new.txt", `${CZ}\n`);
    expect(detectEncoding(fs.readFileSync(path.join(root, "new.txt")))).toEqual({ encoding: "utf8", bom: false, eol: "lf" });

    const cpHost = new NodeHost(root, { autoConfirm: true, log: () => undefined, defaultEncoding: "windows-1250", defaultEol: "crlf" });
    await cpHost.writeFile("legacy.txt", `${CZ}\n`);
    const raw = fs.readFileSync(path.join(root, "legacy.txt"));
    expect(detectEncoding(raw)).toMatchObject({ encoding: "windows-1250", eol: "crlf" });
    expect(decodeBytes(raw, "windows-1250")).toBe(`${CZ}\r\n`);
  });

  it("appends in the file's encoding without repeating the BOM", async () => {
    const { root, host } = hostIn({ "log.txt": encodeText("start\r\n", { encoding: "utf8", bom: true, eol: "crlf" }) });
    await host.appendFile("log.txt", "další řádek\n");
    const raw = fs.readFileSync(path.join(root, "log.txt"));
    expect(raw.filter((b) => b === 0xef).length).toBe(1);
    expect(decodeBytes(raw, "utf8")).toBe("start\r\ndalší řádek\r\n");
  });
});
