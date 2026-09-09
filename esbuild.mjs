import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const ext = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});
const harness = await esbuild.context({
  ...common,
  entryPoints: ["src/cli/harness.ts"],
  outfile: "dist/harness.js",
});

if (watch) {
  await Promise.all([ext.watch(), harness.watch()]);
} else {
  await Promise.all([ext.rebuild(), harness.rebuild()]);
  await Promise.all([ext.dispose(), harness.dispose()]);
}
