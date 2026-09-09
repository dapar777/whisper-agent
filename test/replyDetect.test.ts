import { describe, expect, it } from "vitest";
import { buildCorrectionPrompt, buildInitialPrompt, buildResultsPrompt, DEFAULT_OPTIONS } from "../src/protocol/PromptBuilder";
import { isOwnPrompt, looksLikeReply } from "../src/protocol/replyDetect";

const ctx = { workspaceName: "demo", tree: "src/\n  a.ts\n" };

describe("replyDetect", () => {
  it("does not treat our own initial prompt as a reply, even with CRLF line endings", () => {
    const prompt = buildInitialPrompt("s1", "task", ctx, DEFAULT_OPTIONS);
    expect(looksLikeReply(prompt, prompt)).toBe(false);
    expect(looksLikeReply(prompt.replace(/\n/g, "\r\n"), prompt)).toBe(false);
    expect(looksLikeReply(prompt.replace(/\n/g, "\r\n"), "")).toBe(false);
    expect(isOwnPrompt(prompt)).toBe(true);
  });

  it("does not treat results or correction prompts as replies", () => {
    const results = buildResultsPrompt("s1", 2, [], {}, DEFAULT_OPTIONS);
    const correction = buildCorrectionPrompt("s1", 1, ["x"]);
    expect(looksLikeReply(results, "")).toBe(false);
    expect(looksLikeReply(correction.replace(/\n/g, "\r\n"), "")).toBe(false);
  });

  it("accepts a real reply with a numeric turn, also with typographic quotes", () => {
    expect(looksLikeReply('Sure.\n<whisper turn="3">\n<ls/>\n</whisper>', "")).toBe(true);
    expect(looksLikeReply("<whisper turn=“3”>\r\n<ls/>\r\n</whisper>", "")).toBe(true);
  });

  it("rejects text without a numeric turn or without a closing tag", () => {
    expect(looksLikeReply('<whisper turn="N">\n<ls/>\n</whisper>', "")).toBe(false);
    expect(looksLikeReply('<whisper turn="3">\n<ls/>', "")).toBe(false);
    expect(looksLikeReply("", "")).toBe(false);
  });
});
