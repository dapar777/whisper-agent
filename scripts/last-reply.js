// Vytáhne poslední odpověď asistenta z JSONL transkriptu subagenta a zapíše ji do souboru.
// použití: node scripts/last-reply.js <transcript.jsonl> <out.md>
const fs = require("fs");
const [src, out] = process.argv.slice(2);
const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean);
let last = null;
for (const l of lines) {
  try {
    const j = JSON.parse(l);
    if (j.type === "assistant" && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text.trim()) last = text;
    }
  } catch {}
}
if (!last) { console.error("no assistant text found"); process.exit(1); }
fs.writeFileSync(out, last, "utf8");
console.log(`wrote ${last.length} chars to ${out}`);
