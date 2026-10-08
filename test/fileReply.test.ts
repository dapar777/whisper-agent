import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileReplyWatcher } from "../src/clipboard/FileReplyWatcher";

const REPLY = '<whisper turn="2">\n<status>ok</status>\n</whisper>\n';

function waitFor<T>(setup: (resolve: (v: T) => void) => void, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    setup((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

describe("FileReplyWatcher", () => {
  it("ignores pre-existing files, waits until a new file stops growing, then hands over a reply", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-"));
    fs.writeFileSync(path.join(dir, "old.md"), REPLY.replace('turn="2"', 'turn="1"'), "utf8");
    const got = await waitFor<{ text: string; file: string }>((resolve) => {
      const w = new FileReplyWatcher({ dir, pattern: "*.{md,txt}", pollMs: 200, lastPrompt: "", onReply: (text, file) => resolve({ text, file }) });
      w.start();
      // soubor stažený po částech: nejdřív nevyhovující názvem (.crdownload), pak přejmenovaný a dopisovaný
      fs.writeFileSync(path.join(dir, "reply.md.crdownload"), "﻿" + REPLY.slice(0, 10), "utf8");
      setTimeout(() => fs.renameSync(path.join(dir, "reply.md.crdownload"), path.join(dir, "reply.md")), 250);
      setTimeout(() => fs.appendFileSync(path.join(dir, "reply.md"), REPLY.slice(10), "utf8"), 500);
    });
    expect(path.basename(got.file)).toBe("reply.md");
    expect(got.text).toBe(REPLY);
    expect(got.text.startsWith("<")).toBe(true); // BOM odstraněn
  });

  it("skips new files that are not replies and keeps watching", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-"));
    const logs: string[] = [];
    const got = await waitFor<string>((resolve) => {
      const w = new FileReplyWatcher({ dir, pattern: "*.txt", pollMs: 200, lastPrompt: "", log: (l) => logs.push(l), onReply: (text) => resolve(text) });
      w.start();
      fs.writeFileSync(path.join(dir, "notes.txt"), "just some notes", "utf8");
      setTimeout(() => fs.writeFileSync(path.join(dir, "answer.txt"), REPLY, "utf8"), 700);
    });
    expect(got).toBe(REPLY);
    expect(logs.some((l) => l.includes("notes.txt") && l.includes("ignoruji"))).toBe(true);
  });
});

describe("reply as a downloaded XML file", () => {
  it("accepts whisper-reply-N.xml with an <?xml?> header and CDATA bodies, and it parses into actions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-"));
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<whisper turn="3">\n<status><![CDATA[Jdu na to]]></status>\n' +
      '<write path="docs/a.md"><![CDATA[\n# A\n\n<b>x</b> & y\n]]></write>\n<done><![CDATA[Hotovo.]]></done>\n</whisper>\n';
    const got = await waitFor<{ text: string; file: string }>((resolve) => {
      const w = new FileReplyWatcher({ dir, pattern: "*.{xml,md,txt}", pollMs: 200, lastPrompt: "", onReply: (text, file) => resolve({ text, file }) });
      w.start();
      setTimeout(() => fs.writeFileSync(path.join(dir, "whisper-reply-3.xml"), "﻿" + xml, "utf8"), 100);
    });
    expect(path.basename(got.file)).toBe("whisper-reply-3.xml");
    const { parseReply } = await import("../src/protocol/ResponseParser");
    const p = parseReply(got.text, 3);
    expect(p.errors).toEqual([]);
    expect(p.turn).toBe(3);
    expect(p.actions.map((a) => a.body)).toEqual(["Jdu na to", "# A\n\n<b>x</b> & y", "Hotovo."]);
  });
});

describe("second and later replies", () => {
  it("picks up a file that was overwritten with new content under the same name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-"));
    const file = path.join(dir, "whisper-reply.xml");
    fs.writeFileSync(file, REPLY.replace('turn="2"', 'turn="1"'), "utf8"); // první odpověď, už zpracovaná
    const got = await waitFor<string>((resolve) => {
      const w = new FileReplyWatcher({ dir, pattern: "*.{xml,md,txt}", pollMs: 200, lastPrompt: "", onReply: (text) => resolve(text) });
      w.start();
      // druhá odpověď přepíše tentýž soubor (Uložit jako… se stejným jménem): musí se vzít
      setTimeout(() => fs.writeFileSync(file, REPLY, "utf8"), 300);
    });
    expect(got).toBe(REPLY);
  });

  it("watches several folders and survives a missing one", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-b-"));
    const logs: string[] = [];
    const got = await waitFor<{ text: string; file: string }>((resolve) => {
      const w = new FileReplyWatcher({ dir: a, dirs: [a, path.join(a, "does-not-exist"), b], pattern: "*.xml", pollMs: 200, lastPrompt: "", log: (l) => logs.push(l), onReply: (text, file) => resolve({ text, file }) });
      w.start();
      setTimeout(() => fs.writeFileSync(path.join(b, "whisper-reply-2.xml"), REPLY, "utf8"), 250);
    });
    expect(got.file).toBe(path.join(b, "whisper-reply-2.xml"));
    expect(logs[0]).toMatch(/Hlídám .*; .*does-not-exist; /);
  });

  it("retries a file that cannot be read yet instead of giving up on it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-inbox-"));
    const file = path.join(dir, "locked.xml");
    let failures = 3; // první tři čtení „zamčeného“ souboru selžou, jako když ho drží prohlížeč nebo antivir
    const readFile = (p: string) => {
      if (p === file && failures-- > 0) throw new Error("EBUSY: resource busy or locked");
      return fs.readFileSync(p, "utf8");
    };
    const got = await waitFor<string>((resolve) => {
      const w = new FileReplyWatcher({ dir, pattern: "*.xml", pollMs: 200, lastPrompt: "", readFile, onReply: (text) => resolve(text) });
      w.start();
      setTimeout(() => fs.writeFileSync(file, REPLY, "utf8"), 100);
    }, 6000);
    expect(got).toBe(REPLY);
    expect(failures).toBeLessThanOrEqual(0);
  });
});
