I have the full picture. Both `tasks.json` files are absent (user data not committed / not yet created), and the on-disk format is a bare JSON array of `{id, title, done, priority}`, with a legacy `{"tasks": [...]}` wrapper already accepted on load. The user chose: shared file, no concurrent run, change detection on disk is enough.

<whisper turn="2">
<think>
Facts I now have, which the document must reflect accurately:

1. On-disk format today is a BARE ARRAY. Both `save_tasks` (todo/storage.py:68) and `saveTasks` (ts-app/src/storage.ts:82) write `json.dumps(tasks.to_list())` / `JSON.stringify(tasks.toArray())` — no wrapper. Tests pin this exactly (tests/test_storage.py:44, ts-app/test/storage.test.ts:50).

2. BUT both loaders already accept a `{"tasks": [...]}` wrapper (todo/storage.py:39-40, ts-app/src/storage.ts:67-74), and both have a test for it. This is the crucial finding for the design: the envelope format needed for sync metadata can be READ by today's code already. That makes a staged migration possible — write the envelope only once both sides read it.

3. Two separate default files, not one: `todo/tasks.json` vs `ts-app/tasks.json` (todo/storage.py:13, ts-app/src/storage.ts:14), both overridable by `TODO_DATA_FILE`. So "shared file" is achievable today with zero code changes just by pointing both at one path — that belongs in the document as step 0.

4. `next_id` / `nextId` is NOT persisted. It is recomputed on load from max(id)+1 (todo/model.py:100-102, ts-app/src/model.ts:152-153). This is a real sync hazard worth a Rizika entry: after `clear_done` removes the highest id, a reload lowers next_id and the other app can reissue an id that a stale copy still holds. Worth documenting honestly.

5. Both write atomically (mkstemp + os.replace / writeFileSync + renameSync), but the tmp file naming differs: Python uses `tempfile.mkstemp(suffix=".tmp")` in the target dir, TS uses a dotted `.tasks.json.<pid>-<rand>.tmp`. A watcher must ignore tmp files — Python's are NOT dot-prefixed, so a naive watcher fires on them. Concrete, verifiable detail for Rizika.

6. Trailing newline + indent=2 in both; Python `ensure_ascii=False`, TS JSON.stringify is non-ASCII-preserving too. Byte-identical output between versions is plausible, which matters for "did the file really change" checks.

7. Electron main loads once in `loadInitialTasks()` at `whenReady` and never re-reads (main.ts:142-145); every mutation calls `persist()`. tkinter side per grep uses the same pattern via todo/gui.py. So "detect change on disk" requires a new re-read path in both — that is the core implementation work.

Since the answer is "no concurrent run, detection on disk is enough", I will NOT design a locking/CRDT merge. I will design: shared file + envelope with metadata + mtime/hash based staleness detection + reload prompt. Conflicts get a simple last-writer-wins with a backup copy, and I will say plainly that that is a deliberate limitation of the chosen scenario.

The document also must include an example <whisper> block showing how the agent would write the file — that is a docs-about-the-agent flourish the user asked for explicitly; I'll show a realistic block using the protocol actions.

This is a single new file, no code changes, so no <plan> is needed (rule 10: small task). I write the file and verify it exists and the tests still pass untouched — actually no code changed so tests are irrelevant; instead I'll verify the file was written by listing it and reading back the heading count. A cheap, honest verification: <ls> on docs plus a grep for the six required section headings. That directly verifies the deliverable's structure rather than assuming it.
</think>

<status>Mám oba porty načtené. Píšu docs/navrh-sync.md podle varianty "sdílený soubor bez souběžného běhu".</status>

<write path="docs/navrh-sync.md">
# Navrh: synchronizace ukolu mezi Python a TypeScript verzi

Status: navrh k diskusi. Nic v kodu zatim nemeni.

Scenar dohodnuty se zadavatelem: **obe verze sdileji jeden datovy soubor, ale
nebezi soucasne**. Staci tedy, aby si kazda verze vsimla, ze soubor mezitim
zmenila ta druha. Zamky ani slucovani soubeznych zapisu tento navrh neresi.

## Cile

1. Ukoly pridane v Python verzi jsou videt v TypeScript verzi a naopak, bez
   rucniho kopirovani souboru.
2. Zadna zmena formatu, ktera by rozbila stavajici data. Soubor zapsany novou
   verzi musi jit nacist i starou verzi aplikace.
3. Zadna nova zavislost. Obe verze zustavaji na stdlib (Python) a `node:*` +
   Electron (TS), jak vyzaduje WHISPER.md.
4. Zachovat paritu obou portu: stejne nazvy konstant, stejne chybove hlasky,
   stejne chovani pri chybe.
5. Detekovat, ze datovy soubor na disku zmenil nekdo jiny, a nabidnout
   znovunacteni driv, nez uzivatel prepise cizi zmeny.

Mimo rozsah: soubezny beh obou aplikaci nad jednim souborem, sitova
synchronizace, historie zmen, slucovani konfliktnich editaci stejneho ukolu.

## Soucasny stav

### Dva oddelene datove soubory

Kazda verze ma vlastni vychozi cestu, obe jdou prebit promennou
`TODO_DATA_FILE`:

`todo/storage.py:13`

```python
#: JSON soubor s ukoly, ulozeny primo v adresari aplikace (balicku todo).
DEFAULT_DATA_FILE = Path(__file__).resolve().parent / "tasks.json"
```

`ts-app/src/storage.ts:14`

```ts
export const DEFAULT_DATA_FILE = path.resolve(__dirname, "..", "..", "tasks.json");
```

Tedy `todo/tasks.json` proti `ts-app/tasks.json`. Aplikace se dnes o sobe
navzajem nevi, i kdyz ukladaji uplne stejny tvar dat.

### Zapisovany tvar je holé pole

Obe verze zapisuji pole objektu bez jakekoli obalky:

`todo/storage.py:68`

```python
payload = json.dumps(tasks.to_list(), ensure_ascii=False, indent=2)
```

`ts-app/src/storage.ts:82`

```ts
const payload = JSON.stringify(tasks.toArray(), null, 2) + "\n";
```

Tvar jednoho zaznamu je v obou portech shodny (`todo/model.py:63`,
`ts-app/src/model.ts:111`): `{"id", "title", "done", "priority"}`. Oba testy
tento tvar pribijeji na hrebik, takze jde o skutecny kontrakt, ne nahodu:

`tests/test_storage.py:42`

```python
self.assertEqual(
    data,
    [{"id": 1, "title": "napsat zpravu", "done": False, "priority": "high"}],
)
```

### Klicove zjisteni: obalka `{"tasks": [...]}` uz se cte

Oba nacitaci moduly uz dnes umi krome holeho pole i objekt s klicem `tasks`
a rozbali ho:

`todo/storage.py:39`

```python
if isinstance(data, dict) and "tasks" in data:
    data = data["tasks"]
```

`ts-app/src/storage.ts:67`

```ts
if (
  typeof data === "object" &&
  data !== null &&
  !Array.isArray(data) &&
  "tasks" in (data as Record<string, unknown>)
) {
  data = (data as Record<string, unknown>)["tasks"];
}
```

Obe verze na to maji test (`tests/test_storage.py:83`,
`ts-app/test/storage.test.ts:92`). **Znamena to, ze obalku s metadaty muzeme
zavest, aniz bychom rozbili nacitani — cist ji obe verze umi uz ted, jen ji
zadna nezapisuje.** Neznama pole navic v obalce se proste ignoruji.

### Zapis je atomicky, ale docasne soubory se jmenuji jinak

Python pouziva `tempfile.mkstemp(dir=..., suffix=".tmp")` a `os.replace`
(`todo/storage.py:69-73`), TS pouziva vlastni jmeno a `fs.renameSync`
(`ts-app/src/storage.ts:83-87`):

```ts
const tmpName = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
```

TS docasny soubor zacina teckou, Python nikoli (dostane nahodne jmeno typu
`tmpab12cd.tmp`). Pro hlidani zmen na disku je to podstatny detail.

### Stav se nacte jednou pri startu a uz nikdy

Electron main nacte ukoly pri `whenReady` a dal jen zapisuje
(`ts-app/src/main/main.ts:28-47, 142-145`):

```ts
function persist(): void {
  try {
    saveTasks(tasks, dataFile);
  } catch (exc) {
    dialog.showErrorBox("Ulozeni selhalo", (exc as Error).message);
  }
}
```

Python GUI (`todo/gui.py`) je postavene stejne. Zadna z verzi soubor po startu
znovu necte — to je hlavni prace, kterou tenhle navrh prinasi.

### `next_id` se neuklada

Ani jedna verze nepersistuje citac id. Dopocita se pri nacteni z nejvyssiho
existujiciho id (`todo/model.py:99-102`, `ts-app/src/model.ts:152-153`):

```python
def __post_init__(self) -> None:
    highest = max((t.id for t in self.tasks), default=0)
    if self.next_id <= highest:
        self.next_id = highest + 1
```

Pri jedne aplikaci to staci. Pri sdileni souboru to je zdroj problemu — viz
Rizika.

## Navrh formatu

Prejit z holeho pole na obalku s metadaty. Pole `tasks` zustava presne takove,
jake je dnes, takze stara verze aplikace soubor precte a jen ignoruje zbytek.

```json
{
  "format": 2,
  "updatedAt": "2026-09-14T10:23:41.512Z",
  "updatedBy": "ts",
  "nextId": 7,
  "tasks": [
    { "id": 1, "title": "koupit rohliky", "done": false, "priority": "high" },
    { "id": 4, "title": "odeslat fakturu", "done": true, "priority": "normal" },
    { "id": 6, "title": "zalohovat data", "done": false, "priority": "low" }
  ]
}
```

Vyznam poli:

| Pole | Typ | K cemu |
|---|---|---|
| `format` | int | Verze formatu. `2` = tato obalka. Chybejici = stary holy seznam. |
| `updatedAt` | string | Cas posledniho zapisu, ISO 8601 v UTC. Jen informativni, pro uzivatele. |
| `updatedBy` | `"py"` \| `"ts"` | Ktera verze zapsala naposled. Pro hlasku "Data zmenila TS verze". |
| `nextId` | int | Persistovany citac id. Pri nacteni se vezme `max(nextId, nejvyssi_id + 1)`. |
| `tasks` | array | Beze zmeny proti dnesku. |

Pravidla kompatibility:

- **Cteni**: holy seznam (`format` chybi) i obalka se nactou stejne. Uz to tak
  funguje; jen pribude vycteni `nextId`, kdyz je pritomen.
- **Zapis**: nova verze zapisuje vzdy obalku `format: 2`.
- **Neznama pole** se pri cteni ignoruji, aby slo format dal rozsirit.
- **Vyssi `format`, nez verze zna** (napr. `3`): nacist ukoly, ale prejit do
  rezimu jen pro cteni a rict to uzivateli. Radsi nez tise zahodit metadata,
  kterym nerozumime.

Detekce zmeny na disku (staci pro zvoleny scenar bez soubezneho behu):

1. Po kazdem `load` i `save` si aplikace zapamatuje `mtime` a velikost souboru.
2. Pred kazdym zapisem se oba udaje overi znovu. Kdyz sedi, zapisuje se rovnou.
3. Kdyz nesedi, soubor mezitim zmenil nekdo jiny. Aplikace se zepta:
   *Data zmenila druha verze. Nacist znovu (prijdes o neulozene zmeny), nebo
   prepsat?* Pri "prepsat" se puvodni soubor nejdriv zkopiruje do
   `tasks.conflict-<timestamp>.json`.
4. Pri navratu fokusu do okna se stejna kontrola provede a pri zmene se nabidne
   znovunacteni. Tim se pokryje bezny pripad "prepnul jsem z jedne appky do
   druhe".

Kdyz `mtime` nestaci (nizke rozliseni casu u rychlych zapisu za sebou),
porovna se navic SHA-256 obsahu. Pocitat hash az jako druhy krok, ne pri kazde
kontrole.

### Jak by vypadal zapis agentem

Kdyby tenhle navrh implementoval Whisper agent, blok pro prvni krok (sdilena
cesta + obalka na strane Pythonu) by vypadal takhle:

<whisper turn="4">
<status>Pridavam obalku formatu 2 do Python storage a dopisuji test.</status>

<edit path="todo/storage.py">
&lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH
    payload = json.dumps(tasks.to_list(), ensure_ascii=False, indent=2)
=======
    envelope = {
        "format": DATA_FORMAT,
        "updatedAt": _utc_now(),
        "updatedBy": "py",
        "nextId": tasks.next_id,
        "tasks": tasks.to_list(),
    }
    payload = json.dumps(envelope, ensure_ascii=False, indent=2)
&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE
</edit>

<run timeout="120">python -m unittest discover -s tests</run>
<diagnostics/>
</whisper>

Podstatne je, ze zmena formatu a jeji test jdou v jednom kole a hned se overi
testy obou verzi — parita se nesmi rozejit ani docasne.

## Kroky implementace

Kazdy krok je samostatne funkcni a testovatelny. Po kazdem musi projit
`python -m unittest discover -s tests` i `npm test` v `ts-app/`.

- **0. Sdilena cesta (bez zmeny kodu).** Overit, ze scenar vubec funguje: obe
  verze spustit s `TODO_DATA_FILE` na jednu spolecnou cestu a rucne vyzkouset,
  ze si data predaji. Tohle jde udelat hned dnes a je to nutne pred psanim
  jakehokoli kodu.
- **1. Cteni obalky vcetne `nextId`.** Do obou `load` doplnit vycteni
  `format` a `nextId`. Zapis zatim nemenit. Testy: obalka s `nextId`, obalka
  bez nej, holy seznam, neznamy vyssi `format`.
- **2. Zapis obalky.** Prepnout oba `save` na `format: 2`. Upravit oba testy
  na ocekavany tvar (`tests/test_storage.py:37`,
  `ts-app/test/storage.test.ts:45`) a pridat round-trip pres obe verze.
- **3. Konstanty do modelu.** `DATA_FORMAT` a nazvy klicu pridat do
  `todo/model.py` i `ts-app/src/model.ts`, at zustava parita konstant podle
  konvenci projektu.
- **4. Detekce zmeny na disku.** Do obou storage modulu funkce, ktera vrati
  otisk souboru (`mtime` + velikost), a kontrola pred zapisem.
- **5. Napojeni do UI.** V `todo/gui.py` a `ts-app/src/main/main.ts` pridat
  akci *Nacist znovu* a kontrolu pri navratu fokusu do okna. V Electronu pres
  `browserWindow.on("focus", ...)`, v tkinteru pres `<FocusIn>`.
- **6. Spolecna vychozi cesta.** Teprve ted zmenit `DEFAULT_DATA_FILE` v obou
  verzich na jedno misto (navrh: `tasks.json` v koreni repa). Pozor: obe sady
  testu na dnesni umisteni primo testuji (`tests/test_storage.py:19`,
  `ts-app/test/storage.test.ts:24`), takze se musi upravit spolu s tim.
  Zaroven je treba vyresit migraci existujicich dat — viz Otevrene otazky.
- **7. Dokumentace.** `WHISPER.md` (sekce Struktura a Pozor), `ts-app/README.md`
  a popis noveho formatu.

## Rizika

- **Kolize id po `clear_done`.** `next_id` se dnes dopocitava z nejvyssiho id.
  Kdyz `clear_done()` (`todo/model.py:162`) smaze ukol s nejvyssim id, po
  dalsim nacteni citac klesne a druha verze muze priradit id, ktere uz nekde
  existuje. Persistovany `nextId` z kroku 1 to resi, ale jen pro data zapsana
  novou verzi. Pri nacteni stareho souboru zustava stare chovani. Zmirneni:
  brat vzdy `max(nextId_ze_souboru, nejvyssi_id + 1)`.
- **Ztrata dat pri "prepsat".** Zvoleny scenar nema slucovani. Kdyz uzivatel
  pres varovani zapise, cizi zmeny zmizi. Proto povinna zaloha do
  `tasks.conflict-<timestamp>.json` jeste pred prepsanim.
- **Presne ten soubezny beh, ktery neresime.** Kdyz uzivatel presto spusti obe
  aplikace najednou, kontrola `mtime` snizi pravdepodobnost skody, ale
  neodstrani ji: mezi kontrolou a zapisem je okno. Je treba to napsat do
  dokumentace jako znamé omezeni, ne to vydavat za vyresene.
- **Docasne soubory a hlidani zmen.** Python tvori `tmp*.tmp` primo vedle
  datoveho souboru (bez tecky na zacatku). Jakykoli budouci watcher adresare
  musi `.tmp` ignorovat, jinak bude reagovat na vlastni zapis.
- **Rozjeti parity.** Zmena formatu se dotyka ctyr souboru ve dvou jazycich.
  Kdyz se udela jen v jedne verzi, druha ji tise ignoruje (neznama pole se
  preskakuji) a chyba se projevi az ztratou `nextId`. Proto kazdy krok menit v
  obou verzich zaroven vcetne testu.
- **Testy pribijeji dnesni tvar.** `test_ulozeny_json_ma_cekany_tvar` a jeho TS
  protejsek ocekavaji holy seznam. Krok 2 je nutne rozbije; je to zamerna
  zmena kontraktu, ne regrese, ale musi se provest vedome.
- **Zmena `DEFAULT_DATA_FILE` osirotí existujici data.** Uzivatel muze mit
  ukoly v obou dnesnich souborech. Bez migrace o ne pri kroku 6 prijde.

## Otevrene otazky

1. **Kde ma sdileny soubor lezet?** `tasks.json` v koreni repa je nejjednodussi,
   ale datovy soubor v adresari s kodem je nezvyk. Alternativa
   `%APPDATA%\todo\tasks.json` je spravnejsi, zato hur se hleda a lip se na ni
   zapomina pri testech. (Poznamka: ani `todo/tasks.json`, ani
   `ts-app/tasks.json` v repu aktualne neexistuji — obe cesty hlasi "file not
   found", takze zadna realna data zatim nejsou v ceste.)
2. **Migrace stavajicich dat.** Kdyz pri kroku 6 existuji oba stare soubory
   s ruznym obsahem, co s nimi? Vzit novejsi podle `mtime`, spojit oba, nebo se
   zeptat uzivatele? Spojeni narazi na kolize id.
3. **Ma se hlidani zmen delat i pri bezicim okne?** Navrh pocita s kontrolou
   pri zapisu a pri navratu fokusu. Prubezny watcher (`fs.watch`,
   `after()` polling) by byl prijemnejsi, ale je to prace navic pro scenar,
   ktery vyslovne nepocita se soubeznym behem.
4. **Ma `format: 2` platit i pro CSV export?** CSV je dnes jednosmerny vystup
   a synchronizace se ho netyka. Navrhuji nechat beze zmeny.
5. **Co se `nextId` pri necem mezi verzemi nekompatibilnim?** Kdyz stara verze
   zapise holy seznam pres soubor s obalkou, `nextId` a metadata zmizi. Ma nova
   verze takovy "downgrade" poznat a upozornit, nebo ho tise prijmout?
6. **Prahovy pocet ukolu.** Pri kazdem zapisu se serializuje cely seznam. Pro
   desitky ukolu je to jedno; ma smysl resit az v radu tisicu, a pak uz jinym
   formatem nez jednim JSON souborem.
</write>

<ls path="docs"/>

<grep pattern="^## " glob="docs/navrh-sync.md"/>

<done>
Napsal jsem navrh do `docs/navrh-sync.md`. V kodu jsem nezmenil nic.

Co dokument obsahuje (vsech sest pozadovanych sekci): Cile, Soucasny stav,
Navrh formatu, Kroky implementace, Rizika, Otevrene otazky. Sekce Soucasny stav
cituje skutecny kod z obou verzi s cislem radku (`todo/storage.py`,
`todo/model.py`, `ts-app/src/storage.ts`, `ts-app/src/model.ts`,
`ts-app/src/main/main.ts`) a oba testy storage. Navrh formatu ma ukazku JSON
i ukazkovy blok `<whisper>` pro prvni implementacni krok.

Navrh vychazi z varianty, kterou jsi zvolil: sdileny soubor, bez soubezneho
behu, staci detekce zmeny na disku (`mtime` + velikost, hash az jako druhy
krok). Zamky ani slucovani konfliktu tedy neresi a je to v dokumentu napsane
jako vedome omezeni.

Overeno z kodu, ne odhadnuto:
- Oba loadery uz dnes umi obalku `{"tasks": [...]}` (`todo/storage.py:39`,
  `ts-app/src/storage.ts:67`) a maji na to test. Navrzena obalka s metadaty je
  proto zpetne kompatibilni uz ted — to je hlavni duvod, proc navrh vypada
  takhle.
- `next_id` / `nextId` se nepersistuje, dopocitava se z `max(id)+1`
  (`todo/model.py:100`, `ts-app/src/model.ts:152`). Odtud riziko kolize id po
  `clear_done`.
- Ani `todo/tasks.json`, ani `ts-app/tasks.json` v repu neexistuji (oba `read`
  vratily "File not found"), takze zadna realna data nejsou v ceste pripadne
  migraci.

Neoveroval jsem: nespoustel jsem zadne testy ani build, protoze zadny kod se
nemenil. Dokument je navrh, ne implementace — cisla radku v citacich plati ke
stavu, ktery jsem prave nacetl, a pri pozdejsich zmenach kodu je bude potreba
osvezit.

K rozhodnuti zbyva sest otevrenych otazek na konci dokumentu; nejdulezitejsi
jsou prvni dve (kde ma sdileny soubor lezet a jak migrovat stavajici data),
protoze na nich visi krok 6.
</done>
</whisper>