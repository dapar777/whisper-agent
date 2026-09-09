# Whisper Agent – návrh kódovacího agenta pro VS Code se schránkovým přenosem

Agent pracuje jako Claude Code (čte a upravuje soubory, spouští příkazy, iteruje
nad chybami), ale s modelem nekomunikuje přes API. Každý dotaz na model
zkopíruje do schránky a upozorní uživatele; ten prompt vloží do libovolného
chatu (claude.ai, ChatGPT, Gemini, lokální UI…), zkopíruje odpověď a agent
ji zpracuje. Funguje tedy s jakýmkoli modelem bez API klíče a bez nákladů
navíc mimo předplatné chatu.

---

## 1. Základní princip

Klasický agent běží ve smyčce `prompt → model → tool call → výsledek → model…`.
Zde je „model“ nahrazen člověkem, který přenáší text. To má dva důsledky,
kolem kterých je celý návrh postavený:

1. **Model nemůže volat nástroje.** Musí je *popsat textem* ve strojově
   čitelném formátu a extension je vykoná. Potřebujeme robustní protokol
   akcí, který se dá spolehlivě parsovat i po průchodu chatovým UI
   (markdown, zalamování, tlačítko „copy“ na bloku kódu).
2. **Každé kolo stojí lidskou práci** (cca 10–20 s). Zatímco Claude Code
   klidně udělá 40 volání nástrojů, tady je cílem **2–5 kol na úkol**.
   Model se proto instruuje, aby v jednom kole požadoval všechno najednou
   (dávkování), a extension proaktivně přikládá kontext, který by si model
   jinak vyžádal (strom projektu, otevřený soubor, diagnostiku).

---

## 2. Pracovní tok z pohledu uživatele

```
┌──────────────┐  1. zadá úkol   ┌──────────────┐  2. prompt → schránka  ┌──────────────┐
│  VS Code     │ ──────────────► │ Whisper Agent│ ─────────────────────► │  Chat s LLM  │
│  (sidebar)   │                 │ (extension)  │      + notifikace       │  (prohlížeč) │
│              │ ◄────────────── │              │ ◄───────────────────── │              │
└──────────────┘ 5. výsledky,    └──────────────┘ 3. uživatel zkopíruje  └──────────────┘
                    diff, log       4. parsování,     odpověď (Ctrl+C);
                                       provedení      extension si jí
                                       akcí           všimne ve schránce
```

Krok po kroku:

1. Uživatel v sidebaru napíše úkol („přidej validaci e-mailu do
   registračního formuláře“) a stiskne Start.
2. Extension sestaví prompt, uloží ho do schránky, ukáže notifikaci
   *„Prompt zkopírován (4,2 kB). Vlož ho do chatu a zkopíruj odpověď.“*
   Stavový řádek přejde do stavu ⏳ *Čekám na odpověď*.
3. Uživatel vloží prompt do chatu (Ctrl+V), počká na odpověď, zkopíruje ji
   (tlačítko „copy“ u zprávy nebo Ctrl+A/Ctrl+C).
4. Extension **hlídá schránku** (polling každých 500 ms). Jakmile se obsah
   změní a obsahuje protokolovou značku (`</whisper>`), odpověď automaticky
   převezme. Záložní cesta: příkaz *Whisper: Vložit odpověď* (Ctrl+Alt+V)
   nebo vložení do textového pole v sidebaru.
5. Extension odpověď rozparsuje, provede akce (čtení, zápis, příkaz…),
   výsledky zobrazí v logu a **rovnou sestaví další prompt** → zpět ke kroku 2.
   Smyčka končí akcí `done` nebo `ask` (model potřebuje rozhodnutí uživatele).

Notifikace by měly být nerušivé, ale nepřehlédnutelné: notifikace VS Code
s tlačítky *Zkopírovat znovu* / *Zrušit*, změna ikony ve stavovém řádku,
volitelně zvuk.

---

## 3. Protokol komunikace s modelem

### 3.1 Volba formátu

| Formát | Pro | Proti |
|---|---|---|
| JSON | snadné parsování | obsah souborů se musí escapovat, modely v tom dělají chyby, chatová UI kód „opravují“ |
| Markdown bloky s hlavičkou | přirozené pro modely | konflikt s trojitými backticky uvnitř obsahu souborů |
| **XML‑like značky s raw obsahem** | žádné escapování, obsah souboru je doslova mezi tagy, tolerantní parsování | model musí dodržet uzavírací tagy |

Zvoleny **XML‑like značky**. Uvnitř `<write>`/`<edit>` je obsah brán doslova
(jako CDATA), takže do něj lze psát cokoli včetně backticků a JSONu.
Jediné, co nesmí obsahovat, je řetězec uzavíracího tagu – pro ten případ
protokol umožňuje volitelný delimiter (`<write path="x" end="EOF_7f3a">`).

### 3.2 Tvar odpovědi modelu

Model odpoví libovolným textem (může uvažovat nahlas), ale **musí** obsahovat
právě jeden blok `<whisper turn="N">…</whisper>`. Parser ignoruje vše mimo něj.

```xml
<whisper turn="3">
<think>Potřebuji vidět, jak se validace řeší jinde ve formulářích.</think>

<read path="src/forms/LoginForm.tsx" lines="1-80"/>
<grep pattern="validateEmail|isEmail" glob="src/**/*.ts*"/>

<edit path="src/forms/RegisterForm.tsx">
<<<<<<< SEARCH
  const canSubmit = name.length > 0;
=======
  const canSubmit = name.length > 0 && isValidEmail(email);
>>>>>>> REPLACE
</edit>

<write path="src/utils/email.ts">
export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
</write>

<run cwd="." timeout="120">npm test -- RegisterForm</run>

<status>Přidal jsem validaci; po testech doplním chybovou hlášku do UI.</status>
</whisper>
```

### 3.3 Akce (nástroje)

| Akce | Parametry | Popis |
|---|---|---|
| `read` | `path`, `lines="A-B"` (volit.) | vrátí obsah souboru s čísly řádků |
| `ls` | `path`, `depth` | výpis adresáře |
| `glob` | `pattern` | seznam souborů podle vzoru |
| `grep` | `pattern`, `glob`, `context` | fulltext (ripgrep z VS Code) |
| `write` | `path` | vytvoří/přepíše celý soubor |
| `edit` | `path` | jeden nebo více SEARCH/REPLACE bloků |
| `delete` | `path` | smaže soubor (vyžaduje potvrzení) |
| `run` | `cwd`, `timeout` | spustí příkaz v terminálu, vrátí stdout+stderr+exit code |
| `diagnostics` | `path` (volit.) | chyby a varování z language serverů VS Code |
| `ask` | – | otázka na uživatele; smyčka se přeruší, odpověď jde do dalšího promptu |
| `status` | – | krátká zpráva pro uživatele (zobrazí se v logu) |
| `done` | – | závěrečné shrnutí, konec úkolu |

Zásady:

- **Dávkování:** v jednom bloku libovolný počet akcí; vykonají se v pořadí.
  `read`/`grep`/`ls` se běžně dávkují po 5–15 kusech.
- **`edit` před `write`:** pro existující soubory se preferuje SEARCH/REPLACE
  (menší objem textu, menší riziko, že model „zapomene“ část souboru).
  Aplikace: přesná shoda → shoda s normalizovaným bílým znakem → chyba
  s výpisem nejbližšího kandidáta zpět modelu.
- **`run` je řízený:** allowlist neškodných příkazů (`npm test`, `tsc`,
  `git status`, …) se spouští automaticky, ostatní vyžadují klik *Povolit*.
  Nikdy se nespouští s `sudo`, `rm -rf`, `git push --force` bez potvrzení.

### 3.4 Tvar promptu od extensionu

Dva režimy podle toho, zda chat drží historii:

**A) Stavový chat (výchozí).** Uživatel používá jednu konverzaci pro celý
úkol, model si historii pamatuje. Extension proto posílá:

- v 1. kole **preambuli** (specifikace protokolu, pravidla, `WHISPER.md`
  s instrukcemi projektu, zkrácený strom projektu, otevřený soubor +
  výběr, aktuální diagnostika) + zadání úkolu;
- v dalších kolech **jen výsledky** předchozích akcí:

```xml
<whisper-results turn="3" session="a8f2">
<result of="read" path="src/forms/LoginForm.tsx" lines="1-80">
1| import ...
…
</result>
<result of="grep" pattern="validateEmail|isEmail">
src/utils/validators.ts:12: export const isEmail = …
</result>
<result of="edit" path="src/forms/RegisterForm.tsx" status="ok" hunks="1/1"/>
<result of="write" path="src/utils/email.ts" status="created" bytes="132"/>
<result of="run" exit="1" duration="8.2s">
FAIL src/forms/RegisterForm.test.tsx
  ● shows error for invalid email
  … (zkráceno, 42 řádků vynecháno; celý výstup: <read path=".whisper/out/run-3.txt"/>)
</result>
<diagnostics changed="true">
src/forms/RegisterForm.tsx:14:8 error TS2304: Cannot find name 'isValidEmail'.
</diagnostics>
Pokračuj. Odpověz blokem <whisper turn="4">.
</whisper-results>
```

**B) Bezstavový režim** (volba v nastavení). Každý prompt je soběstačný:
preambule + komprimovaná historie (seznam dosavadních akcí a jejich
výsledků, staré výstupy zkráceny) + nové výsledky. Větší prompt, ale
funguje i při novém chatu nebo s modely bez historie.

Ochrana proti chybnému vložení: prompt obsahuje `turn` a `session`; model je
musí zopakovat. Když přijde odpověď se špatným číslem kola, extension ji
odmítne („vypadá to jako odpověď na kolo 2, čekám kolo 4“).

**Obnova preambule.** Když chat přeteče kontext nebo uživatel založí nový,
příkaz *Whisper: Znovu poslat kontext* vygeneruje preambuli + shrnutí
dosavadního stavu (co se změnilo, co zbývá) a smyčka pokračuje.

### 3.5 Preambule (jádro)

Zkrácený obsah toho, co model dostane v 1. kole:

- Role: „Jsi kódovací agent v projektu X. Nástroje voláš výhradně
  značkami v bloku `<whisper>`; nic jiného se nevykoná.“
- Specifikace všech akcí s příklady (výše).
- **Ekonomika kol:** „Každá tvá odpověď stojí uživatele ruční kopírování.
  Než začneš měnit kód, vyžádej si v *jednom* kole všechny soubory, které
  pravděpodobně budeš potřebovat. Neptej se po jednom souboru.“
- Pravidla úprav: preferuj `edit`, neopakuj nezměněné části, po změně spusť
  testy/kompilaci, oprav chyby z `diagnostics`.
- Kdy použít `ask` (nejednoznačné zadání, destruktivní změna) a `done`.
- Obsah `WHISPER.md` (obdoba `CLAUDE.md`: konvence, příkazy pro build/test).
- Strom projektu (do ~200 položek, respektuje `.gitignore`), otevřené soubory,
  výběr v editoru, aktuální diagnostika.

---

## 4. Architektura extensionu

```
src/
├── extension.ts          aktivace, registrace příkazů a view
├── session/
│   ├── Session.ts        stav úkolu: turn, historie akcí/výsledků, režim A/B
│   └── SessionStore.ts   persistence do .whisper/session.json (resume po restartu)
├── protocol/
│   ├── PromptBuilder.ts  preambule, výsledky, komprese historie, limit délky
│   ├── ResponseParser.ts tolerantní parser <whisper> bloku → seznam akcí
│   └── schema.ts         typy akcí a výsledků
├── tools/
│   ├── ToolRunner.ts     vykonání akcí v pořadí, sběr výsledků, zkracování výstupů
│   ├── fs.ts             read / write / ls / glob / delete (přes vscode.workspace.fs)
│   ├── edit.ts           SEARCH/REPLACE s fallbacky, zobrazení diffu
│   ├── grep.ts           ripgrep (vscode.workspace.findTextInFiles)
│   ├── run.ts            child_process + allowlist + potvrzování
│   └── diagnostics.ts    vscode.languages.getDiagnostics
├── clipboard/
│   ├── ClipboardBridge.ts copy promptu, polling schránky, detekce odpovědi
│   └── Notifier.ts       notifikace, stavový řádek, zvuk
├── ui/
│   ├── SidebarView.ts    webview: zadání úkolu, log kol, tlačítka, textarea pro odpověď
│   └── DiffPreview.ts    náhled změn před aplikací (volitelné potvrzení)
└── safety/
    ├── Checkpoint.ts     git stash/commit před každým kolem → Undo kola
    └── Policy.ts         allowlist příkazů, chráněné cesty (.env, .git, node_modules)
```

Žádné externí runtime závislosti; jen VS Code API a Node. Balení přes
`esbuild`, testy přes `@vscode/test-electron` + unit testy parseru
a editoru (Vitest).

### 4.1 Stavový automat sezení

```
Idle ──Start──► Composing ──copy──► WaitingForReply ──reply──► Executing
                    ▲                     │  (timeout/abort)        │
                    │                     ▼                         │
                    │                  Aborted                      │
                    └──── další kolo ◄───────────── (akce ≠ done/ask)┘
                                                            │
                                            done/ask ───────┴──► Idle / AwaitingUser
```

### 4.2 Hlídání schránky

- Při přechodu do `WaitingForReply` si extension zapamatuje hash toho, co
  do schránky uložila.
- Polling `vscode.env.clipboard.readText()` každých 500 ms (jen v tomto
  stavu, jinak nic).
- Odpověď se přijme, když se obsah liší od promptu **a** obsahuje
  `<whisper` i `</whisper>`. Tím se ignoruje běžné kopírování mezitím.
- Nastavení `whisper.clipboard.watch: false` pro uživatele, kterým polling
  vadí; pak jen ruční příkaz / textarea.
- Po převzetí odpovědi extension schránku nemaže (uživatel by mohl chtít
  text jinde), ale ihned ji přepíše dalším promptem – s krátkou notifikací.

### 4.3 Limity velikosti

Chatová UI mívají limit vstupu (řádově desítky tisíc znaků) a dlouhé
prompty jsou pro uživatele nepohodlné. Proto:

- `whisper.prompt.maxChars` (výchozí 24 000). PromptBuilder zkracuje:
  výstupy `run` na hlavu+patu, `read` velkých souborů odmítne bez `lines`,
  starou historii v režimu B komprimuje na jednořádkové záznamy.
- Celé výstupy se ukládají do `.whisper/out/` a model si je může vyžádat
  po částech.
- Když se prompt i tak nevejde, extension ho rozdělí na části „1/2, 2/2“
  s instrukcí modelu počkat na poslední.
- Alternativně *Uložit prompt jako soubor* pro chaty s nahráváním příloh.

### 4.4 Review změn po vzoru Copilotu

Změny se zapisují na disk **okamžitě** (aby model mohl ve stejném kole spustit
testy), ale zůstávají *čekající*, dokud je uživatel neschválí:

- `ReviewManager` drží pro každý dotčený soubor **baseline** (obsah před
  změnou). Čekající hunky = řádkový diff (baseline, živý soubor). Není třeba
  nic sledovat při editaci – diff se přepočítává na požádání.
- **Přijmout hunk** = baseline se posune (hunk se do ní vpíše). **Zamítnout
  hunk** = živý soubor se v rozsahu hunku vrátí na baseline. Když baseline ==
  soubor, změna zmizí ze seznamu.
- V editoru: zelené pozadí přidaných řádků, červená linka + poznámka tam, kde
  řádky zmizely; nad každým hunkem CodeLens *Přijmout / Zamítnout*, nad
  souborem *Přijmout vše / Zamítnout vše / Diff* (diff otevře původní obsah
  z virtuálního dokumentu `whisper-orig:`).
- Příkaz *Projít změny* otevírá hunky **jeden po druhém**; po Přijmout/Zamítnout
  skočí na další. Sidebar ukazuje seznam souborů s počty hunků.
- Smazané soubory se schvalují dialogem (Zamítnout = obnovit).
- Každé zamítnutí se uloží jako poznámka a v dalším kole se pošle modelu
  (`<user>The user rejected a change in … Do not re-apply it.</user>`).
- Volitelně `whisper.review.requireApproval`: diff se ukáže *před* zápisem a
  bez schválení se nic nezapíše (model dostane `status="denied"`).

### 4.5 Bezpečnost a vratnost

- Před každým `Executing` git checkpoint (pokud je repo): `git stash create`
  nebo commit na dočasnou ref; příkaz *Undo posledního kola*.
- Zápisy mimo workspace se odmítnou; chráněné cesty konfigurovatelné.
- Volitelný režim *Review*: každý `write`/`edit` se ukáže jako diff a čeká
  na *Aplikovat* (obdoba plánovacího módu).
- `run` viz 3.3; výstup příkazu se před vložením do promptu čistí od
  zjevných tajemství (`.env` hodnoty, tokeny podle regexů).

---

## 5. Uživatelské rozhraní

**Sidebar (Activity Bar ikona 🗣️ Whisper)**

```
┌ Whisper Agent ───────────────────────────────┐
│ Úkol: [ Přidej validaci e-mailu…        ] ▶  │
│ Režim: (•) stavový chat  ( ) bezstavový      │
├──────────────────────────────────────────────┤
│ Kolo 1  ✔ preambule + zadání     4,2 kB       │
│ Kolo 2  ✔ read ×4, grep ×1                    │
│ Kolo 3  ⏳ čekám na odpověď      [Kopírovat znovu] │
│                                              │
│ ┌ Vložit odpověď ručně ─────────────────────┐│
│ │                                           ││
│ └───────────────────────────────[ Odeslat ]─┘│
├──────────────────────────────────────────────┤
│ [Znovu poslat kontext] [Undo kola] [Zrušit]  │
└──────────────────────────────────────────────┘
```

**Stavový řádek:** `Whisper: idle` / `⏳ kolo 3 – vlož prompt do chatu` /
`⚙ provádím 6 akcí` / `❓ model se ptá`. Klik otevře sidebar.

**Příkazy (Command Palette + klávesy):**

| Příkaz | Klávesa |
|---|---|
| Whisper: Nový úkol | Ctrl+Alt+W |
| Whisper: Vložit odpověď ze schránky | Ctrl+Alt+V |
| Whisper: Zkopírovat aktuální prompt znovu | – |
| Whisper: Znovu poslat kontext (nový chat) | – |
| Whisper: Undo posledního kola | – |
| Whisper: Zrušit úkol | – |

---

## 6. Nastavení (`settings.json`)

```jsonc
{
  "whisper.mode": "stateful",            // stateful | stateless
  "whisper.clipboard.watch": true,
  "whisper.clipboard.pollMs": 500,
  "whisper.prompt.maxChars": 24000,
  "whisper.prompt.treeMaxEntries": 200,
  "whisper.run.autoAllow": ["npm test", "npm run build", "tsc", "git status", "git diff"],
  "whisper.run.deny": ["rm -rf", "git push --force", "sudo"],
  "whisper.review.requireApproval": false, // diff před aplikací
  "whisper.checkpoint.git": true,
  "whisper.protectedPaths": [".env*", ".git/**", "node_modules/**"],
  "whisper.notify.sound": true
}
```

Projektové instrukce v `WHISPER.md` v kořeni workspace (build/test příkazy,
konvence, co nesahat) – vkládají se do preambule.

---

## 7. Plán vývoje

| Fáze | Obsah | Výsledek |
|---|---|---|
| **0 – kostra** | scaffold extensionu, sidebar, stavový řádek, příkazy | prázdné UI, které se aktivuje |
| **1 – protokol** | `ResponseParser` + `PromptBuilder` + unit testy na zlomyslné vstupy (chybějící tagy, backticky, zkopírovaná celá zpráva vč. prózy) | parser přežije reálné výstupy modelů |
| **2 – nástroje** | `read/ls/glob/grep/write/edit/diagnostics`, zkracování výstupů | agent zvládne read‑only průzkum a jednoduché úpravy |
| **3 – schránka** | copy, polling, notifikace, kontrola `turn` | plnohodnotná smyčka bez ručního vkládání |
| **4 – run + bezpečnost** | `run` s allowlistem, git checkpoint, Undo, chráněné cesty | agent smí spouštět testy a opravovat chyby |
| **5 – komfort** | bezstavový režim, komprese historie, „znovu poslat kontext“, review mód, `ask` | dlouhé úkoly, více chatů |
| **6 – ladění promptu** | testovací sada úkolů, měření počtu kol, úpravy preambule pro různé modely | průměr ≤ 4 kola na běžný úkol |

Fáze 1–3 jsou minimální použitelný produkt.

---

## 8. Známá rizika a jak s nimi

| Riziko | Řešení |
|---|---|
| Model nedodrží protokol (chybí tag, text mimo blok) | tolerantní parser; při nerozpoznání extension vygeneruje krátký „opravný“ prompt s konkrétní chybou |
| Chatové UI upraví text (typografické uvozovky, zalomení) | normalizace uvozovek v atributech; obsah `write`/`edit` se bere doslova; SEARCH fallback na normalizované bílé znaky |
| Uživatel vloží starou/cizí odpověď | kontrola `turn` + `session` |
| Příliš mnoho kol | instrukce k dávkování, proaktivní kontext v preambuli, metrika v logu |
| Přetečení kontextu chatu | režim B nebo *Znovu poslat kontext* se shrnutím |
| Únik tajemství do chatu | chráněné cesty, filtr výstupů, upozornění při přiložení `.env`‑like souborů |
| Model spustí nebezpečný příkaz | allowlist/denylist, potvrzování, žádné automatické `sudo` |

---

## 9. Možná rozšíření

- **Userscript pro prohlížeč** (Tampermonkey), který automaticky vloží obsah
  schránky do chatu a po dokončení odpovědi ji zkopíruje – smyčka pak běží
  bez ručních kroků, stále bez API.
- **Souborový most** místo schránky: prompt do `.whisper/outbox.md`,
  odpověď do `.whisper/inbox.md` (pro chaty s nahráváním souborů nebo
  synchronizaci přes cloud disk na jiné zařízení).
- **Více modelů**: profily preambule (Claude, GPT, Gemini) s drobnými
  rozdíly ve formulaci instrukcí.
- **Subúkoly**: model může vytvořit `<task>` pro paralelní chat; extension
  drží víc sezení.
