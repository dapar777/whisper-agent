/**
 * Headless harness: stejné jádro jako extension, ale „schránka“ je soubor.
 *
 *   harness start <root> "<task>" [--stateless]   → .whisper/outbox.md (prompt)
 *   harness reply <root> [inbox]                   → vykoná odpověď z .whisper/inbox.md, zapíše další outbox
 *   harness answer <root> "<odpověď na ask>"
 *   harness status <root>
 */
import * as fs from "fs/promises";
import * as path from "path";
import { NodeHost } from "../host/NodeHost";
import { TurnEngine } from "../agent/TurnEngine";
import { createSession, SessionData } from "../session/SessionData";
import { describeActions, describeResults, Transcript } from "../transcript/Transcript";
import { loadSkills } from "../skills/Skills";
import { BUILTIN_COMMANDS, composeTask, parseInput } from "../protocol/slash";
import { BundleUsage } from "../protocol/PromptBuilder";

const OUTBOX = ".whisper/outbox.md";
const INBOX = ".whisper/inbox.md";
const STATE = ".whisper/session.json";
const LOG = ".whisper/harness.log";

async function main(): Promise<void> {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (!cmd || !root) {
    console.log("usage: harness start <root> <task> [--stateless] | reply <root> [inbox] | answer <root> <text> | status <root>");
    process.exit(2);
  }
  const rootAbs = path.resolve(root);
  const logLines: string[] = [];
  const host = new NodeHost(rootAbs, {
    autoConfirm: true,
    log: (l) => {
      logLines.push(l);
      console.log("  " + l);
    },
  });
  const transcript = new Transcript(host);
  const engine = new TurnEngine(host, {
    mode: rest.includes("--stateless") ? "stateless" : "stateful",
    maxChars: 60000,
    resultMaxChars: 12000,
    language: "cs",
    treeMaxEntries: 200,
    // stupeň pobízení k <bundle>: --bundle=prefer apod. (výchozí jako v extensionu)
    bundleUsage: (rest.find((r) => r.startsWith("--bundle="))?.split("=")[1] as BundleUsage) ?? "encourage",
  });

  const load = async (): Promise<SessionData> => JSON.parse(await host.readFile(STATE)) as SessionData;
  const save = async (s: SessionData): Promise<void> => host.writeFile(STATE, JSON.stringify(s, null, 2));
  const emit = async (s: SessionData, prompt: string): Promise<void> => {
    s.pendingPrompt = prompt;
    s.state = "waitingForReply";
    await save(s);
    await host.writeFile(OUTBOX, prompt);
    console.log(`→ OUTBOX ${OUTBOX} (${prompt.length} chars) for turn ${s.turn}`);
  };
  const appendLog = async (head: string): Promise<void> => {
    const stamp = new Date().toISOString();
    await fs.mkdir(path.join(rootAbs, ".whisper"), { recursive: true });
    await fs.appendFile(path.join(rootAbs, LOG), `\n[${stamp}] ${head}\n${logLines.map((l) => "  " + l).join("\n")}\n`, "utf8");
  };

  switch (cmd) {
    case "start": {
      // /skill na začátku zadání se rozbalí jako v extensionu (vestavěné skilly leží v <repo>/skills)
      const skills = loadSkills(rootAbs, path.join(__dirname, "..", "skills"));
      const parsed = parseInput(rest.filter((r) => !r.startsWith("--")).join(" "), [...BUILTIN_COMMANDS, ...skills]);
      for (const u of parsed.unknown) console.log(`! unknown command /${u}`);
      const task = composeTask(parsed);
      const s = createSession(task, rest.includes("--stateless") ? "stateless" : "stateful");
      s.planMode = rest.includes("--plan") || parsed.commands.includes("plan");
      let previous: string | undefined;
      try {
        previous = (await load()).id;
      } catch {
        /* první sezení */
      }
      await engine.archivePlan(previous);
      const prompt = await engine.initialPrompt(s, await engine.gatherContext(undefined, skills.map((k) => ({ name: k.name, description: k.description }))));
      await emit(s, prompt);
      await transcript.append({ session: s.id, kind: "task", text: task, data: { planMode: s.planMode } });
      await appendLog(`START ${s.id}: ${task}`);
      return;
    }
    case "suggest": {
      // návrhy z celého transkriptu (jako /suggest v extensionu)
      const events = await transcript.readAll();
      const s = createSession("/suggest", "stateful");
      const ctx = await engine.gatherContext();
      const prompt = engine.suggestPrompt(s, Transcript.summarize(events), ctx, Transcript.suggestionHistory(events));
      await emit(s, prompt);
      return;
    }
    case "reply": {
      const s = await load();
      const inbox = rest[0] ?? INBOX;
      const text = await fs.readFile(path.resolve(rootAbs, inbox), "utf8");
      // pro stateless režim potřebuje engine preambuli
      if (s.mode === "stateless") await engine.initialPrompt(s, await engine.gatherContext());
      const parsed = engine.parse(text);
      if (parsed.turn !== null && parsed.turn !== s.turn) console.log(`! turn mismatch: reply says ${parsed.turn}, expected ${s.turn} (continuing)`);
      if (parsed.errors.length) console.log(`! parse errors: ${parsed.errors.join(" | ")}`);
      console.log(`← reply turn ${s.turn}: ${parsed.actions.length} actions [${parsed.actions.map((a) => a.tool).join(", ")}]`);
      const turn = s.turn;
      await transcript.append({ session: s.id, kind: "actions", turn, text: describeActions(parsed.actions) });
      const step = await engine.execute(s, parsed, s.pendingPrompt.length);
      if (step.kind !== "correction") {
        const rec = step.record;
        await transcript.append({ session: s.id, kind: "results", turn, text: describeResults(rec.results) });
        for (const d of rec.dialog ?? []) await transcript.append({ session: s.id, kind: "dialog", turn, text: `${d.from}: ${d.text}` });
        if (s.plan && rec.actions.some((a) => a.tool === "plan")) await transcript.append({ session: s.id, kind: "plan", turn, text: s.plan });
        for (const sug of (s.suggestions ?? []).filter((x) => x.turn === turn)) {
          console.log(`💡 suggestion [${sug.scope}/${sug.kind}]${sug.update ? ` update=${sug.update}` : ""}: ${sug.title}`);
          await transcript.append({ session: s.id, kind: "suggestion", turn, text: `${sug.kind}: ${sug.title}` });
        }
        if (step.kind === "done") await transcript.append({ session: s.id, kind: "done", text: step.summary });
        if (step.kind === "ask") await transcript.append({ session: s.id, kind: "ask", text: step.question });
      }
      switch (step.kind) {
        case "correction":
          console.log("✖ CORRECTION prompt issued");
          await emit(s, step.prompt);
          break;
        case "next":
          await emit(s, step.prompt);
          if (step.attachments.length) console.log(`📎 attachments for this prompt: ${step.attachments.join(", ")}`);
          break;
        case "done":
          s.state = "done";
          s.finalSummary = step.summary;
          await save(s);
          console.log(`✔ DONE after ${s.history.length} turns:\n${step.summary}`);
          break;
        case "ask":
          s.state = "awaitingUser";
          s.pendingQuestion = step.question;
          await save(s);
          console.log(`❓ ASK: ${step.question}\n   (answer with: harness answer <root> "<text>")`);
          break;
      }
      await appendLog(`REPLY → ${step.kind}`);
      return;
    }
    case "answer": {
      const s = await load();
      if (s.mode === "stateless") await engine.initialPrompt(s, await engine.gatherContext());
      const prompt = engine.answerPrompt(s, rest.join(" "), []);
      await transcript.append({ session: s.id, kind: "answer", text: rest.join(" ") });
      s.pendingQuestion = undefined;
      await emit(s, prompt);
      return;
    }
    case "rerun": {
      // znovu vykoná jednu akci posledního kola (index v bloku) a přestaví prompt
      const s = await load();
      if (s.mode === "stateless") await engine.initialPrompt(s, await engine.gatherContext());
      const prompt = await engine.rerunAction(s, Number(rest[0]));
      if (!prompt) {
        console.log("no such action in the last turn");
        return;
      }
      await emit(s, prompt);
      await appendLog(`RERUN action ${rest[0]}`);
      return;
    }
    case "reprompt": {
      // znovu vygeneruje prompt z výsledků posledního kola (po opravě agenta)
      const s = await load();
      if (s.mode === "stateless") await engine.initialPrompt(s, await engine.gatherContext());
      const prompt = engine.rebuildLastPrompt(s);
      if (!prompt) {
        console.log("no history to rebuild from");
        return;
      }
      await emit(s, prompt);
      return;
    }
    case "status": {
      const s = await load();
      console.log(`session ${s.id} mode=${s.mode} state=${s.state} turn=${s.turn} history=${s.history.length}`);
      for (const h of s.history) {
        const errs = h.results.filter((r) => r.status !== "ok").length;
        console.log(`  turn ${h.turn}: ${h.actions.map((a) => a.tool).join(",")} (${errs} non-ok) ${h.status ?? ""}`);
      }
      return;
    }
    default:
      console.log(`unknown command ${cmd}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
