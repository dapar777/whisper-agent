# Whisper Agent

Kódovací agent pro VS Code, který pracuje jako Claude Code, ale s modelem
komunikuje **přes schránku**. Nepotřebuje API klíč: prompt zkopíruje do
schránky, vy ho vložíte do libovolného chatu (claude.ai, ChatGPT, Gemini,
lokální UI…), zkopírujete odpověď a agent ji sám převezme a vykoná.

## Instalace

1. Stáhněte z GitHubu soubor `whisper-agent-0.1.0.vsix` a `instalovat.bat` do jedné složky
   (nebo naklonujte celé repo).
2. Poklepejte na `instalovat.bat`. Skript sám najde VS Code, nainstaluje balíček (přepíše
   starší verzi) a ověří, že je rozšíření vidět. Když něco chybí, napíše co a kde to vzít.
3. Restartujte VS Code (nebo `Developer: Reload Window`).

Ručně: `code --install-extension whisper-agent-0.1.0.vsix --force`, nebo ve VS Code
Extensions › „…“ › *Install from VSIX…*.

## Jak to funguje

1. V panelu Whisper (pravý postranní panel) napište úkol do pole dole a odešlete Enterem,
   nebo použijte `Ctrl+Alt+W`. Lomítko `/` nabídne příkazy a skilly s doplňováním
   (`/plan`, `/suggest`, `/auto`, `/resend`, `/undo`, `/stop`, `/název-skillu`).
2. Prompt je ve schránce. Vložte ho do chatu s modelem.
3. Zkopírujte odpověď modelu (tlačítko *copy* u zprávy nebo `Ctrl+A`, `Ctrl+C`).
   Whisper hlídá schránku a odpověď převezme, jakmile v ní uvidí blok
   `<whisper>…</whisper>`. Záložně `Ctrl+Alt+V` nebo textové pole v sidebaru.
4. Whisper provede akce (čtení, hledání, úpravy, příkazy, diagnostika) a rovnou
   zkopíruje další prompt s výsledky. Opakujte, dokud model nepošle `<done>`.

Změny v souborech se aplikují hned (aby šly spustit testy), ale zůstávají
**ke schválení** jako v Copilotu: v editoru jsou zvýrazněné a nad každou je
CodeLens *Přijmout / Zamítnout*. Příkaz **Whisper: Projít změny** je otevírá
jednu po druhé. Zamítnutí se modelu nahlásí v dalším kole.

## Panel

Průběh se odvíjí nahoře jako chat (zadání, akce, výsledky, otázky, plán, návrhy),
vstup je dole. Stav je vidět v barevném banneru: čekám na odpověď (žlutý, pulzuje),
provádím akce, model se ptá, hotovo. Během čekání můžete psát poznámky; přiloží se
k dalšímu promptu.

**Schvalování příkazů** se dělá v panelu, ne v dialozích: karta s tlačítky *Povolit*,
*Zamítnout* a *Povolit vždy (regex)*, které uloží regulární výraz do
`whisper.run.allowPatterns`. Přepínač *auto / ptát se* v horní liště (nebo `/auto`)
přepne `whisper.run.approval`; denylist platí vždy.

**Režim PLAN**: `/plan zadání` vynutí, aby model nejdřív poslal hierarchický
checklist (`.whisper/plan.md`) a průběžně ho udržoval (odškrtává, přidává objevené
úkoly, dělí na podúkoly). Bez `/plan` si model plán založí sám u větších úkolů
(`whisper.plan.auto`).

**Návrhy**: `/suggest` (nebo 💡) projde celý záznam práce v `.whisper/transcript.jsonl`
a model navrhne zlepšení na dvou úrovních. Pro **projekt**: skilly (`.whisper/skills/`),
řádky do `WHISPER.md`, hooky (`.whisper/hooks.json`, spouští se po změně souborů,
např. lint), regexová povolení příkazů a navazující úkoly do plánu. Pro **agenta
globálně** (štítek „globální“, ukládá se do `~/.whisper` a uživatelských nastavení):
pravidla chování do preambule (`~/.whisper/rules.md`), instrukce pro všechny projekty
(`~/.whisper/WHISPER.md`), globální skilly a hooky, změny nastavení `whisper.*`
a podněty pro vývojáře agenta (`~/.whisper/agent-feedback.md`). Každý návrh přijmete
nebo zamítnete kartou. S `whisper.suggest.continuous` model navrhuje průběžně při práci.
Projektová pravidla lze psát i ručně do `.whisper/rules.md` (jedno na řádek).

**Přímý dialog** (`whisper.ask.direct`, výchozí zapnuto): model se smí ptát přímo v chatu
a vy tam odpovíte nebo cokoli dopíšete; v dalším bloku to zapíše akcemi `<dialog>`, takže
výměna je v průběhu i v transkriptu. Odpověď bez bloku akcí se bere jako otázka v chatu,
ne jako chyba. `<ask options="A|B">` nabízí odpovědi jako tlačítka (i vícenásobný výběr).

**Svazek souborů** (`<bundle>`): místo mnoha `<read>` si model může říct o víc souborů, adresáře,
globy nebo celou codebase (`<bundle all="true"/>`) jako jeden strukturovaný textový soubor
(číslované řádky, sekce na soubor, obsah na začátku; binární a obří soubory se vynechají,
`.gitignore` se respektuje). Svazek se uloží do `.whisper/out/bundle-<kolo>-<n>.txt` a do
schránky se dá podle `whisper.bundle.delivery`: `history` (výchozí) = **nejdřív jako text** a pak
teprve prompt, `Ctrl+V` vloží prompt a svazek vezmete z historie schránky (`Win+V`); `file` = do
schránky jdou soubory `prompt-N.txt` + `bundle-N.txt` a jedno `Ctrl+V` v chatu připojí obě přílohy.
Svazek je vždy soubor `*.txt` (jiné formáty chaty často odmítají). Prompt modelu říká, že svazek je
přiložen, a co dělat, když ho nevidí.

**Odpověď v souboru** (`whisper.reply.watchDir`): kromě schránky lze odpověď modelu doručit
jako **nový soubor** ve sledované složce, třeba ve složce stahování prohlížeče. Sledují se jen
soubory vzniklé po odeslání promptu, název musí vyhovovat `whisper.reply.filePattern`
(výchozí `*.{md,txt}`), soubor se přečte, až se přestane měnit (stahování po částech), a ověří
stejně jako text ze schránky. Soubory bez bloku `<whisper turn=…>` se ignorují (vidět v logu).

**Screenshoty**: `<run probe="7" capture="4" window="Titulek">` spustí GUI a po 4 s ho vyfotí,
`<screenshot/>` vyfotí obrazovku. Obrázky se přiloží k dalšímu promptu jako soubory ve schránce
(jedním Ctrl+V se v chatu připojí text i obrázky). Jen Windows.

**Stav v hlavním panelu Windows** (ikona VS Code): šipka + žlutý pruh = prompt ve schránce,
ještě nevložen; … + běžící pruh = vložen, čeká se na model; ! = čeká se na vás (schválení,
otázka); ✓ hotovo. Vložení se pozná díky vlastnictví schránky s odloženým vykreslením.

**Přerušení**: v banneru „Provádím akce“ je vidět běžící akce s časem a tlačítko Přerušit, které
ukončí příkaz, přeskočí zbytek a modelu pošle, co proběhlo a kde to stálo.

**Vestavěné skilly** (součást instalace, složka `skills/` v rozšíření):

| Příkaz | Co udělá |
|---|---|
| `/init` | prozkoumá projekt a založí nebo doplní `WHISPER.md` (příkazy, struktura, konvence, úskalí); ověří testovací příkaz |
| `/commit [rozsah]` | projde `git diff`, rozdělí nesouvisející změny, napíše zprávu ve stylu repa, commitne (bez push) |
| `/review [soubory]` | code review necommitnutých změn nebo zadaných souborů; nic nemění |
| `/test [oblast]` | spustí testy, opraví příčiny selhání (ne testy), doplní chybějící testy |
| `/fix <chyba>` | reprodukuje chybu, najde příčinu, opraví ji, přidá regresní test |
| `/explain [co]` | vysvětlí kód nebo architekturu; nic nemění |
| `/docs [oblast]` | srovná dokumentaci s kódem, ověří příkazy v ní |
| `/deps` | zastaralé/zranitelné závislosti, bezpečná aktualizace s testy |

Za příkaz lze dopsat upřesnění (`/fix TypeError v storage.ts při prázdném souboru`). Vlastní skill
stejného jména vestavěný přepíše.

**Vlastní skilly** jsou markdown soubory v `.whisper/skills/` (projekt) nebo `~/.whisper/skills/`
(uživatel), buď `název.md`, nebo `název/SKILL.md` s volitelným frontmatterem
`name` a `description`. Vyvolají se přes `/název zadání`; jejich text se přiloží
k zadání jako instrukce. Whisper je nezávislý na jiných nástrojích a jejich adresářích.

**Ovládací příkazy**: `/plan`, `/suggest`, `/auto`, `/resend`, `/undo`, `/stop`, `/new` (vyčistí panel),
`/status` (stav sezení, plán, schvalování), `/skills` (seznam skillů), `/help`.

Při novém úkolu se plán z předchozího sezení odloží: hotový se smaže, rozpracovaný se archivuje do
`.whisper/plan-<sezení>.md`.

## Příkazy

| Příkaz | Klávesa |
|---|---|
| Whisper: Nový úkol | `Ctrl+Alt+W` |
| Whisper: Vložit odpověď ze schránky | `Ctrl+Alt+V` |
| Whisper: Zkopírovat aktuální prompt znovu | |
| Whisper: Zobrazit aktuální prompt | |
| Whisper: Znovu poslat kontext (nový chat) | |
| Whisper: Undo posledního kola | |
| Whisper: Zrušit úkol | |
| Whisper: Projít změny (další změna) | |
| Whisper: Přijmout / Zamítnout všechny změny | |

## Nastavení

- `whisper.mode` – `stateful` (chat drží historii, posílají se jen výsledky) nebo
  `stateless` (každý prompt je soběstačný).
- `whisper.clipboard.watch` – automatické převzetí odpovědi ze schránky.
- `whisper.reply.watchDir`, `whisper.reply.filePattern` – složka a glob pro odpověď doručenou
  jako nový soubor (viz výše); prázdná složka = jen schránka.
- `whisper.clipboard.fileAboveChars` – jen Windows: prompt delší než N znaků jde do
  schránky jako soubor `.txt` (vloží se jako příloha). Výchozí 0 = vždy text; na
  claude.ai se dlouhý text stejně sám změní v přílohu, takže to obvykle není třeba.
- `whisper.prompt.maxChars`, `whisper.prompt.resultMaxChars` – limity délky. Dlouhý výstup
  příkazu, který skončil s kódem 0, se posílá jen jako závěr (poslední ~4000 znaků), celý
  výstup je v `.whisper/out/`. Neúspěšné příkazy se posílají celé (začátek + konec).
- Limit `timeout` u `<run>` se počítá jen z doby, kdy počítač běžel; uspání (standby) se do
  něj nezapočítá a modelu se ohlásí zvlášť.
- `whisper.run.autoAllow` / `whisper.run.deny` – příkazy bez potvrzení / zakázané.
- `whisper.review.requireApproval` – ukázat diff a čekat na schválení *před* zápisem.
- `whisper.checkpoint.git` – git checkpoint před každým kolem (Undo kola).
- `whisper.protectedPaths` – soubory, do kterých agent nesmí sahat.

Instrukce pro projekt (příkazy pro build a testy, konvence) dejte do souboru
`WHISPER.md` v kořeni workspace; vkládají se do preambule.

## Vývoj

```
npm install
npm run build      # bundle do dist/ (extension + headless harness)
npm test           # unit testy protokolové vrstvy
npm run package    # vytvoří .vsix
```

Ladění: F5 ve VS Code (konfigurace *Run Extension*).

### Headless harness

Stejné jádro (protokol, nástroje, smyčka kola) běží i bez VS Code, „schránka“ je
soubor. Hodí se pro testování agenta s libovolným chatem nebo skriptem:

```
node dist/harness.js start <root> "<úkol>"      # prompt → <root>/.whisper/outbox.md
node dist/harness.js reply <root> [inbox.md]     # vykoná odpověď z .whisper/inbox.md, další prompt do outboxu
node dist/harness.js answer <root> "<odpověď>"   # odpověď na <ask>
node dist/harness.js status <root>
```

V headless režimu se potvrzovací dotazy (příkazy mimo allowlist, mazání) schvalují
automaticky a logují; denylist platí dál.
