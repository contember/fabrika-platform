# Demo runbook: Objednávky od odběratelů

Čtyřminutová ukázka na dvě věci:

1. **Role.** Účtárna zkusí smazat objednávku a platforma ji odmítne dřív, než se požadavek dostane k datům.
2. **Změna od agenta čeká na člověka.** Agent přidal „Export pro účtárnu“. Stránka schválení ukáže, že účtárna by tím nově četla údaje všech odběratelů, a nasazení počká, dokud to člověk neschválí.

Appka je v [`examples/orders`](../orders): pražírna kávy Zrnko, pět odběratelů, sedm objednávek a podklady k fakturaci. Všechna jména, firmy, IČO a e-maily jsou vymyšlené. Běží lokálně přes `fabrika app dev`: bez cloudu, bez Dockeru a bez databázového serveru (SQLite v paměti).

## Persony

| Persona | Role       | Co vidí a smí                                                                 |
| ------- | ---------- | ----------------------------------------------------------------------------- |
| Jana    | majitelka  | všechno, jako jediná maže objednávky                                          |
| Petr    | obchodník  | jen své odběratele (Kavárna U Modré lípy, Bistro Na Rohu) a jejich objednávky |
| Eva     | obchodnice | jen své odběratele (Hotel Podzámčí, Cukrárna Věneček) a jejich objednávky     |
| Lenka   | účtárna    | všechny objednávky a fakturaci, odběratele nevidí, mazat nesmí                |

Obchodník vidí odběratele proto, že ho k nim majitelka přiřadila (řádek v tabulce `customer_reps`). Kdo není přiřazený, pro něj odběratel neexistuje.

## Den předem

Dokud není změna mergnutá do `main`, je appka na větvi `agent/0591a894-ukazkova-appka-objednavky-pro-webinar-12`.

```bash
git clone https://github.com/contember/fabrika-platform && cd fabrika-platform   # nebo git pull v existujícím checkoutu
bun install                                   # jediný krok, který potřebuje síť
cd examples/orders && bun run dev             # http://127.0.0.1:3000/, ukončit Ctrl-C
```

Ve druhém terminálu z rootu repa pusť screenshoty pro slidy (potřebuje nainstalovaný Google Chrome a běžící `bun run dev` po čerstvém startu):

```bash
bun examples/orders-demo/screenshots.ts
```

Uloží PNG do `examples/orders-demo/screenshots/`. Skript nic nemaže (odmítnuté smazání objednávku nechá).

## V den webináře (start 16:35)

**16:15** (20 minut předem, start sám trvá pár sekund):

```bash
cd fabrika-platform/examples/orders
bun run dev
```

Terminál vypíše `http://127.0.0.1:3000/` a řádek `seeded personas: 4`.

**16:17** kontrola ve druhém terminálu:

```bash
cd fabrika-platform/examples/orders
bun tools/demo-check.ts
```

Musí vypsat šest řádků `OK`. Kontrola nic nemění.

**16:20** připrav si v prohlížeči tři záložky:

1. `http://127.0.0.1:3000/__fabrika/dev` (výběr persony)
2. `http://127.0.0.1:3000/__fabrika/dev/as?persona=Lenka&next=/` (rovnou jako účtárna)
3. soubor `examples/orders-demo/approval-preview.html` (stránka schválení, otevře se i bez serveru)

Zvětši písmo prohlížeče (Cmd +) na 125 %, ať je to na sdílené obrazovce čitelné.

## Scénář 1: účtárna nesmí mazat objednávky (asi 2 minuty)

1. Záložka 1, klikni **Jana**. Majitelka vidí sedm objednávek a v menu Objednávky, Odběratelé, Fakturace.
2. Lištou v rohu stránky přepni na **Petr**, otevři **Odběratelé**. Nadpis „Moji odběratelé“, jen dva odběratelé. V Objednávkách jen tři objednávky jeho odběratelů.
3. Přepni na **Lenka**. V menu chybí Odběratelé: účtárna je nevidí.
4. U objednávky **OBJ-2026-0412** (Kavárna U Modré lípy) klikni **Smazat** a v dialogu znovu **Smazat**.
5. Nahoře se objeví červený rámeček: „Objednávku OBJ-2026-0412 nejde smazat. Mazat objednávky smí jen majitel. Tvoje role to nemá povolené, takže platforma požadavek odmítla dřív, než se dostal k datům. Objednávka zůstala beze změny.“ Objednávka v seznamu zůstává.

Co říct: tlačítko Smazat je schválně vidět všem. Skrytí tlačítka by nebyla ochrana. Rozhoduje platforma: proxy přečte roli z přihlášení a požadavek odmítne (HTTP 403) dřív, než se spustí kód aplikace. Stejný požadavek od majitelky projde.

## Scénář 2: změna od agenta čeká na schválení (asi 2 minuty)

Agent (Claude Code) dostal úkol „přidej účtárně export podkladů k fakturaci do CSV“. Jeho změna je v [`billing-export.patch`](./billing-export.patch): nový endpoint `billing.export`, tlačítko „Export pro účtárnu (CSV)“, test a nové oprávnění `billing.export` pro roli účtárna. Aby export obsahoval IČO a e-maily, čte celé tabulky `customers`, `orders` a `billing`.

1. Záložka 3, `approval-preview.html`. Nahoře výsledek **widening** (změna rozšiřuje přístup).
2. Sekce **Who gains access**: nový endpoint pro přihlášené lidi s oprávněním `billing.export`.
3. Sekce **Data and runtime**: `Role uctarna gains billing.export` a `Table customers is read app-wide with billing.export`.
4. Pointa: účtárna dnes odběratele nevidí vůbec. Po téhle změně by přes export četla IČO a e-maily všech odběratelů. Nikdo to nemusel napsat do popisu změny: platforma to poznala z kódu a nasazení na produkci čeká, dokud to člověk s oprávněním `access.approve` neschválí nebo neodmítne.

Odkud stránka je: počítá ji stejný kód, který používá Control při nasazení (`readAccessSnapshot` a `classifyAccess`), a vykresluje ji stejná komponenta jako konzole v záložce Approvals. Není to ale živý běh v běžící konzoli. Živou konzoli s čekajícím nasazením umí lokální Docker stack (`bun run local:up`) zatím jen pro ukázkovou appku Notes (scénář `notes-agent-change`), ne pro Objednávky.

Stránku znovu vygeneruješ z rootu repa:

```bash
bun examples/orders-demo/approval-preview.ts
```

Vypíše všech osm řádků změny a přepíše `approval-preview.html`.

## Když něco selže

| Problém                                | Co udělat                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `port 3000 ... is in use`              | `bun run build:web && bunx fabrika app dev --port=3001` a v URL piš 3001. Kontrola: `bun tools/demo-check.ts http://127.0.0.1:3001` |
| Data jsou rozklikaná, chceš čistý stav | Ctrl-C a `bun run dev`. Data žijí jen v paměti, za pár sekund je zpátky čerstvý seed.                                               |
| Lišta s personami v rohu není vidět    | Přepínej přes URL: `http://127.0.0.1:3000/__fabrika/dev/as?persona=Lenka&next=/` (Jana, Petr, Eva, Lenka)                           |
| Prázdná stránka                        | Chybí build obrazovek: spusť `bun run dev` (dělá `build:web` i start), ne samotné `fabrika app dev`                                 |
| `bun install` na místě nejde (síť)     | Proto se instaluje den předem. Po instalaci síť není potřeba.                                                                       |
| Appka nejde spustit vůbec              | Ukaž screenshoty ze `screenshots/`. Scénář 2 (`approval-preview.html`) funguje i bez běžící appky.                                  |
| `demo-check` hlásí CHYBA               | Restart (Ctrl-C, `bun run dev`) a znovu kontrola. Pokud chyba zůstane, jeď ze screenshotů.                                          |

## Screenshoty pro slidy

Skript `screenshots.ts` je uloží pod těmito jmény:

| Soubor                               | Co ukazuje                                                          |
| ------------------------------------ | ------------------------------------------------------------------- |
| `01-persony.png`                     | výběr persony v dev režimu (Jana, Petr, Eva, Lenka)                 |
| `02-objednavky-majitelka.png`        | všech sedm objednávek očima majitelky                               |
| `03-odberatele-majitelka.png`        | všichni odběratelé i s přiřazeným obchodníkem                       |
| `04-odberatele-obchodnik.png`        | Petr vidí jen své dva odběratele                                    |
| `05-objednavky-obchodnik.png`        | Petr vidí jen objednávky svých odběratelů                           |
| `06-objednavky-uctarna.png`          | účtárna: objednávky ano, v menu chybí Odběratelé                    |
| `07-uctarna-potvrzuje-smazani.png`   | dialog „Smazat objednávku?“                                         |
| `08-uctarna-odmitnuto.png`           | červený rámeček s odmítnutím, objednávka zůstala                    |
| `09-fakturace-uctarna.png`           | podklady k fakturaci (vyfakturováno FV-2026-0187, jeden připravený) |
| `10-schvaleni-kdo-ziska-pristup.png` | stránka schválení změny od agenta, celá                             |

Na slide k scénáři 2 se hodí i výřez souboru `billing-export.patch` (řádek `uctarna: { grants: [..., 'billing.export'] }`).

## Jak je to ověřené

- Testy appky: `cd examples/orders && bun test --isolate` (vygenerované testy přístupu a izolace dat, testy rolí a obrazovek).
- Scénář 1 proti skutečnému serveru `fabrika app dev`: `bun tools/demo-check.ts`.
- Scénář 2: `bun examples/orders-demo/approval-preview.ts` aplikuje patch na kopii appky a nechá Control změnu klasifikovat. Patch sám je zelený: s ním projdou testy appky i `fabrika-check`.
