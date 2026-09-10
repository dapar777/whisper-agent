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
