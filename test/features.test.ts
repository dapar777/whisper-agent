import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnEngine } from "../src/agent/TurnEngine";
import { NodeHost } from "../src/host/NodeHost";
import { buildInitialPrompt, buildSuggestPrompt, DEFAULT_OPTIONS } from "../src/protocol/PromptBuilder";
import { parseReply } from "../src/protocol/ResponseParser";
import { createSession } from "../src/session/SessionData";
import { Transcript } from "../src/transcript/Transcript";

describe("plan, suggest, hooks, transcript", () => {
  let dir: string;
  let host: NodeHost;
  let engine: TurnEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-feat-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores the plan from <plan> and reports item counts", async () => {
    const session = createSession("big task", "stateful");
    session.planMode = true;
    const parsed = parseReply('<whisper turn="1">\n<plan>\n- [x] prozkoumat\n- [ ] upravit\n  - [ ] a.ts\n</plan>\n<read path="a.ts"/>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    expect(session.plan).toContain("- [ ] upravit");
    expect(fs.existsSync(path.join(dir, ".whisper", "plan.md"))).toBe(true);
    if (step.kind === "next") expect(step.prompt).toContain('<result of="plan" status="ok" items="3" done="1"/>');
    const ctx = await engine.gatherContext();
    expect(ctx.plan).toContain("prozkoumat");
  });

  it("puts PLAN rules into the preamble when plan mode is on", () => {
    const on = buildInitialPrompt("s", "t", { workspaceName: "w", tree: "" }, { ...DEFAULT_OPTIONS, planMode: true });
    expect(on).toContain("PLAN MODE is ON");
    const auto = buildInitialPrompt("s", "t", { workspaceName: "w", tree: "" }, { ...DEFAULT_OPTIONS, planAuto: true });
    expect(auto).toContain("For larger tasks");
    expect(auto).not.toContain("PLAN MODE is ON");
  });

  it("collects <suggest> actions as pending suggestions", async () => {
    const session = createSession("t", "stateful");
    const parsed = parseReply('<whisper turn="1">\n<suggest kind="allow" title="Testy bez potvrzení">^npm test\\b</suggest>\n<suggest kind="rule" scope="global" title="Testy nakonec">Run tests once at the end of a turn.</suggest>\n<suggest kind="bogus" title="x">y</suggest>\n<done>ok</done>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next"); // bogus kind failed → done is not accepted
    expect(session.suggestions?.map((s) => [s.kind, s.scope])).toEqual([["allow", "project"], ["rule", "global"]]);
    expect(session.suggestions?.[0].body).toBe("^npm test\\b");
  });

  it("lists attached screenshots in the results prompt", async () => {
    const { buildResultsPrompt } = await import("../src/protocol/PromptBuilder");
    const p = buildResultsPrompt(
      "s1",
      3,
      [{ tool: "screenshot", attrs: { window: "Spravce" }, status: "ok", output: "Screenshot saved", attachments: [".whisper/shots/shot-2-0-spravce.png"] }],
      {},
      DEFAULT_OPTIONS,
    );
    expect(p).toContain('<result of="screenshot" window="Spravce" status="ok" attached="shot-2-0-spravce.png">');
    expect(p).toContain("Images attached to this message: shot-2-0-spravce.png");
    const parsed = parseReply('<whisper turn="1">\n<run probe="8" capture="4" window="Spravce">python -m todo</run>\n<screenshot window="Spravce"/>\n</whisper>');
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions.map((a) => a.tool)).toEqual(["run", "screenshot"]);
    expect(parsed.actions[0].attrs.capture).toBe("4");
  });

  it("records direct chat exchanges sent via <dialog> and explains direct dialogue in the preamble", async () => {
    const session = createSession("t", "stateful");
    const parsed = parseReply('<whisper turn="1">\n<dialog from="model">Má být validace i na serveru?</dialog>\n<dialog from="user">Jen v UI.</dialog>\n<read path="a.ts"/>\n</whisper>');
    expect(parsed.errors).toEqual([]);
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    expect(session.history[0].dialog).toEqual([
      { from: "model", text: "Má být validace i na serveru?" },
      { from: "user", text: "Jen v UI." },
    ]);
    const on = buildInitialPrompt("s", "t", { workspaceName: "w", tree: "" }, { ...DEFAULT_OPTIONS, directDialog: true });
    expect(on).toContain("DIRECT DIALOGUE");
    const off = buildInitialPrompt("s", "t", { workspaceName: "w", tree: "" }, { ...DEFAULT_OPTIONS, directDialog: false });
    expect(off).not.toContain("DIRECT DIALOGUE");
  });

  it("adds learned rules and user instructions to the preamble", () => {
    const p = buildInitialPrompt("s", "t", { workspaceName: "w", tree: "", rules: ["Run tests once per turn."], globalInstructions: "Always answer in Czech." }, DEFAULT_OPTIONS);
    expect(p).toContain("## Additional rules");
    expect(p).toContain("1. Run tests once per turn.");
    expect(p).toContain("## User instructions (apply in every project)");
    expect(p).toContain("Always answer in Czech.");
  });

  it("runs hooks after matching files change and reports their result", async () => {
    fs.mkdirSync(path.join(dir, ".whisper"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".whisper", "hooks.json"), JSON.stringify({ afterChange: [{ match: "**/*.ts", run: "node -e \"console.log('hook ran')\"" }] }));
    const session = createSession("t", "stateful");
    const parsed = parseReply('<whisper turn="1">\n<write path="b.ts">\nexport const b = 2;\n</write>\n</whisper>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.prompt).toContain('<result of="hook" match="**/*.ts"');
      expect(step.prompt).toContain("hook ran");
    }
  });

  it("appends transcript events and summarizes them for the suggest prompt", async () => {
    const t = new Transcript(host);
    await t.append({ session: "s1", kind: "task", text: "Přidej validaci" });
    await t.append({ session: "s1", kind: "actions", turn: 1, text: "read a.ts, edit b.ts" });
    await t.append({ session: "s1", kind: "done", text: "hotovo" });
    const events = await t.readAll();
    expect(events).toHaveLength(3);
    const summary = Transcript.summarize(events);
    expect(summary).toContain("TASK: Přidej validaci");
    expect(summary).toContain("DONE: hotovo");
    const prompt = buildSuggestPrompt("s1", 1, summary, { workspaceName: "w", tree: "" }, DEFAULT_OPTIONS);
    expect(prompt).toContain("## Work history to analyse");
    expect(prompt).toContain("<suggest");
  });

  it("tells the suggester what already exists and what was rejected, and supports update=", async () => {
    await new Transcript(host).append({ session: "s1", kind: "suggestion", text: "allow: Testy bez potvrzení → rejected" });
    await new Transcript(host).append({ session: "s1", kind: "suggestion", text: "rule: Testy nakonec → approved" });
    const events = await new Transcript(host).readAll();
    const history = Transcript.suggestionHistory(events);
    expect(history).toEqual({ approved: ["rule: Testy nakonec"], rejected: ["allow: Testy bez potvrzení"] });
    const ctx = {
      workspaceName: "w",
      tree: "",
      rules: ["Run tests once."],
      skills: [{ name: "review", description: "Code review" }],
      existing: { hooks: ["**/*.ts → npm run lint"], allowPatterns: ["^git status\\b"], autoAllow: ["npm test"], planOpen: ["Přidat validaci"], skillBodies: [{ name: "review", body: "# review\nCheck everything." }] },
    };
    const prompt = buildSuggestPrompt("s1", 1, "history", ctx, DEFAULT_OPTIONS, history);
    expect(prompt).toContain("## Already configured");
    expect(prompt).toContain("hooks: **/*.ts → npm run lint");
    expect(prompt).toContain("REJECTED earlier (do not propose again): allow: Testy bez potvrzení");
    expect(prompt).toContain('improve it with update="review"');
    expect(prompt).toContain("Check everything.");
    const parsed = parseReply('<whisper turn="1">\n<suggest kind="skill" update="review" title="Lepší review">\n# review\nCheck tests too.\n</suggest>\n<done>ok</done>\n</whisper>');
    const session = createSession("t", "stateful");
    await engine.execute(session, parsed, 100);
    expect(session.suggestions?.[0].update).toBe("review");
  });
});
