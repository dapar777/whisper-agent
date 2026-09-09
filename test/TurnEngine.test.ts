import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnEngine } from "../src/agent/TurnEngine";
import { NodeHost } from "../src/host/NodeHost";
import { DEFAULT_OPTIONS } from "../src/protocol/PromptBuilder";
import { createSession } from "../src/session/SessionData";

describe("TurnEngine", () => {
  let dir: string;
  let engine: TurnEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-engine-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\nworld\n");
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delivers results of actions sent together with <ask> in the answer prompt", async () => {
    const session = createSession("task", "stateful");
    const parsed = engine.parse('<whisper turn="1">\n<read path="a.txt"/>\n<ask options="A | B|C" multi="true">Which one?</ask>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("ask");
    if (step.kind === "ask") {
      expect(step.options).toEqual(["A", "B", "C"]);
      expect(step.multi).toBe(true);
    }
    expect(session.turn).toBe(2);
    const prompt = engine.answerPrompt(session, "the first", []);
    expect(prompt).toContain('<result of="read" path="a.txt" status="ok"');
    expect(prompt).toContain("1| hello");
    expect(prompt).toContain("<user>Answer to your question: the first</user>");
    expect(prompt).toContain('Reply with <whisper turn="2">');
  });

  it("continues instead of finishing when an action before <done> fails", async () => {
    const session = createSession("task", "stateful");
    const parsed = engine.parse('<whisper turn="1">\n<read path="missing.txt"/>\n<done>all good</done>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.prompt).toContain("You sent <done>, but 1 action(s)");
      expect(step.prompt).toContain('status="error"');
    }
  });

  it("finishes when <done> follows successful actions", async () => {
    const session = createSession("task", "stateful");
    const parsed = engine.parse('<whisper turn="1">\n<write path="b.txt">\nnew\n</write>\n<done>ok</done>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("done");
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("new\n");
  });

  it("interrupts a long-running command, skips the rest and explains it to the model", async () => {
    const session = createSession("task", "stateful");
    const parsed = engine.parse('<whisper turn="1">\n<run timeout="60">node -e "console.log(\'started\'); setTimeout(() => {}, 30000)"</run>\n<read path="a.txt"/>\n</whisper>');
    const abort = new AbortController();
    const started: string[] = [];
    const pending = engine.execute(session, parsed, 100, [], { signal: abort.signal, onStart: (a) => started.push(a.tool) });
    await new Promise((r) => setTimeout(r, 1500));
    abort.abort();
    const step = await pending;
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.prompt).toContain('exit="interrupted"');
      expect(step.prompt).toContain("INTERRUPTED by the user");
      expect(step.prompt).toContain('<result of="read" path="a.txt" status="skipped"');
      expect(step.prompt).toContain("The user INTERRUPTED this turn");
    }
    expect(started).toEqual(["run"]);
  }, 20000);

  it("issues a correction prompt when the reply has no usable actions", async () => {
    const session = createSession("task", "stateful");
    const step = await engine.execute(session, engine.parse("Sorry, I cannot do that."), 100);
    expect(step.kind).toBe("correction");
    expect(session.turn).toBe(1);
  });
});
