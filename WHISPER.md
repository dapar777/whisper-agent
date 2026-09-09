# Instrukce pro Whisper Agent v tomto projektu

- Jazyk: TypeScript, VS Code extension. Bundluje se přes `npm run build` (esbuild) do `dist/`.
- Typová kontrola: `npx tsc --noEmit`. Unit testy: `npx vitest run` (jen čistá vrstva v `src/protocol`).
- Kód, který sahá na `vscode` API, nelze testovat Vitestem; drž logiku v `src/protocol` bez importu `vscode`.
- Komentáře a UI texty česky, texty pro model (preambule) anglicky.
- Neměň `package.json` `contributes` bez doplnění odpovídajícího `registerCommand` v `src/extension.ts`.
