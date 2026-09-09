import { describe, expect, it } from "vitest";
import { applyHunks, parseHunks } from "../src/protocol/edit";

const body = `<<<<<<< SEARCH
  const canSubmit = name.length > 0;
=======
  const canSubmit = name.length > 0 && isValidEmail(email);
>>>>>>> REPLACE
<<<<<<< SEARCH
import React from "react";
=======
import React from "react";
import { isValidEmail } from "../utils/email";
>>>>>>> REPLACE`;

describe("parseHunks", () => {
  it("parses multiple hunks", () => {
    const h = parseHunks(body);
    expect(h).toHaveLength(2);
    expect(h[0].search).toBe("  const canSubmit = name.length > 0;");
    expect(h[1].replace).toContain("isValidEmail");
  });

  it("accepts CRLF and marker variants", () => {
    const h = parseHunks("<<<<<<<< SEARCH\r\na\r\n========\r\nb\r\n>>>>>>>> REPLACE\r\n");
    expect(h).toEqual([{ search: "a", replace: "b" }]);
  });
});

describe("applyHunks", () => {
  const file = `import React from "react";\n\nfunction Form() {\n  const canSubmit = name.length > 0;\n  return null;\n}\n`;

  it("applies exact matches in order", () => {
    const r = applyHunks(file, parseHunks(body));
    expect(r.failures).toEqual([]);
    expect(r.applied).toBe(2);
    expect(r.content).toContain("isValidEmail(email)");
    expect(r.content).toContain('import { isValidEmail } from "../utils/email";');
  });

  it("falls back to whitespace-tolerant matching and keeps indentation", () => {
    const r = applyHunks(file, [{ search: "const canSubmit = name.length > 0;", replace: "const canSubmit = true;" }]);
    expect(r.applied).toBe(1);
    expect(r.content).toContain("  const canSubmit = true;");
  });

  it("reports failures with the closest candidate", () => {
    const r = applyHunks(file, [{ search: "const canSubmit = name.length > 1;", replace: "x" }]);
    expect(r.applied).toBe(0);
    expect(r.failures[0].hunk).toBe(1);
    expect(r.failures[0].reason).toMatch(/not found/);
    expect(r.content).toBe(file);
  });

  it("preserves CRLF line endings", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    const r = applyHunks(crlf, [{ search: "return null;", replace: "return <div/>;" }]);
    expect(r.content).toContain("return <div/>;\r\n");
    expect(r.content.includes("\n\n")).toBe(false);
  });
});
