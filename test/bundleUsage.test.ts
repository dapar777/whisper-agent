import { describe, expect, it } from "vitest";
import { buildInitialPrompt, buildRules, bundleRule, DEFAULT_OPTIONS, type BundleUsage } from "../src/protocol/PromptBuilder";

const ctx = { workspaceName: "demo", tree: "src/\n  a.ts\n" };
const rulesFor = (level?: BundleUsage) => buildRules({ ...DEFAULT_OPTIONS, bundleUsage: level });

describe("bundle usage levels", () => {
  it("off forbids bundles, allow says nothing extra", () => {
    expect(rulesFor("off")).toContain("Do NOT use <bundle>");
    expect(bundleRule("allow")).toBeUndefined();
    expect(rulesFor("allow")).not.toContain("<bundle>instead");
    expect(rulesFor("allow")).not.toContain("PREFER <bundle>");
  });

  it("each level pushes harder than the previous one", () => {
    expect(rulesFor("encourage")).toContain("MORE THAN ABOUT FIVE files");
    expect(rulesFor("prefer")).toContain("PREFER <bundle> over <read>");
    expect(rulesFor("always")).toContain("ALWAYS start a task by pulling the relevant code as ONE bundle");
    // ostřejší stupně nesmí obsahovat slabší formulaci zároveň
    expect(rulesFor("always")).not.toContain("MORE THAN ABOUT FIVE files");
  });

  it("defaults to encourage and keeps the rules numbered without gaps", () => {
    expect(rulesFor(undefined)).toContain("MORE THAN ABOUT FIVE files");
    for (const level of ["off", "allow", "encourage", "prefer", "always"] as BundleUsage[]) {
      const text = rulesFor(level);
      const numbers = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });

  it("the instruction really reaches the prompt the model receives", () => {
    const prompt = buildInitialPrompt("s1", "task", ctx, { ...DEFAULT_OPTIONS, bundleUsage: "always" });
    expect(prompt).toContain("ALWAYS start a task by pulling the relevant code as ONE bundle");
    const off = buildInitialPrompt("s1", "task", ctx, { ...DEFAULT_OPTIONS, bundleUsage: "off" });
    expect(off).toContain("Do NOT use <bundle>");
    expect(off).not.toContain("PREFER <bundle>");
  });
});
