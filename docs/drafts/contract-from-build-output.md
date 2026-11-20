# Design draft: Control reads the contract from the build output

**TLDR.**

- Today Control derives an application's access surface itself, by reading the contract source statically. That forces
  a literal contract language with budgets, and ADR-0005 forbids even constant folding. This draft lets the
  application's own toolchain compile the contract and Control read the compiled artifact.
- Recommended form (A): the commit carries the compiled artifact as a generated file. Control parses it as data at the
  pinned commit, the platform build checks it against the source before any authored command, and the boot digest
  check stays. ADR-0050's order does not change. The literal form (B), where the live build reports the artifact,
  needs a mid-build callback on Zerops that no verified platform fact supports, so it is not recommended.
- What the platform newly trusts: that the application's toolchain compiled the committed source faithfully, a check
  that today runs in Control's own code. A deliberate cheat must also defeat the boot check inside the application
  process, which ADR-0012 §8 already leaves uncontained. A careless agent's natural fix of a stale artifact is to
  regenerate it, which is the faithful fix.
- Cost of A: about 14–20 h of agent time, plus 3–5 h for MCP authoring, plus review rounds. It needs the ADR-0005,
  ADR-0012, ADR-0050 and ADR-0062 changes below.

## Problem

ADR-0005 has Control read `fabrika.contract.ts`, the modules it imports and `src/db/tables.ts` at the pinned commit
with a static reader that executes nothing. The reader accepts literals, the known `c.*` and `z.*` calls and `const`
imports of such values, and it refuses partial evaluation outright ("each evaluated form is a place where the reader
and the runtime can disagree"). It runs in a Cloudflare Worker, so it is bounded (`CONTRACT_LIMITS`): 4 MiB of source,
512 KiB per module, 400,000 syntax nodes, 60,000 schema nodes.

Cost on a large consumer application (Cloudflare):

| Cost                                                                                         | Value                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/db/tables.ts` generated from policy modules, because the reader takes no spread or call | 20,983 lines generated from 9,298 (measured)      |
| Generator and model checks the consumer keeps for that                                       | about 540 + 1,100 lines (reported)                |
| Reader refusals at one point (spreads, re-exports, other group shapes)                       | 267, cleared by rewriting the contract (reported) |
| Every group and job listed again in the contract                                             | 161 imports in `fabrika.contract.ts` (reported)   |
| A deploy blocked by the budgets                                                              | yes, until the platform raised them (reported)    |
| Platform pull requests for the budgets                                                       | 5, +3,644 / −1,074 lines (from the analysis)      |
| Contract read inside the checker in the build                                                | about 3.3 s of 41 s (from the analysis)           |

On the platform side Control bundles one reader per framework minor of the support window (ADR-0062: 617 KiB gzip of
the Cloudflare Control bundle with the 0.4 and 0.5 readers). A differential test keeps the reader and the runtime
agreeing, and the startup digest check catches what the test misses.

## What ADR-0005 rejects, and why

ADR-0005 rejects exactly this proposal, twice:

- In its Context: "A manifest that the application's build writes cannot serve that purpose: the build is code an
  agent can edit, so its output is the application's self-report."
- In its Alternatives: "Take the access surface from the manifest or an upload. Rejected: the build that writes it is
  code the agent can edit, so the platform would enforce the application's self-report." ADR-0050 and ADR-0062 repeat
  it ("An uploaded artifact is an application's claim, not a reading").

So this is not a reordering. It moves a security boundary, and this draft keeps it only where the rest of the system
already draws it. The next sections say what moves and what holds it in place.

## Design A: the commit carries the compiled artifact

1. **The toolchain emits it.** `fabrika contract emit`, which `fabrika app build` also runs, evaluates
   `src/app.ts` in a child process with no credential in its environment and writes the canonical artifact as a
   committed file. The child exists today (`build-contract-child.ts`, which the Cloudflare build already runs). The file
   is canonical JSON, pretty-printed, with its `format` and the framework release. Pretty-printing makes the pull
   request show the access change in the same form the approver sees. Its path is to settle: it must not fall under MCP
   authoring's protected `fabrika.*` paths.
2. **Control parses it as data.** At the pinned commit Control reads `bun.lock` as today. For a framework release at
   or after the first one that emits the artifact, it reads the artifact file instead of running the reader. It parses
   it with that format's strict parser (`parseContractArtifact`), caps its size, canonicalizes and digests it, and
   upcasts it (`formats.ts`). A missing or unparseable file fails the run before any provider call, with one line:
   "commit the contract artifact: run `fabrika contract emit`". Migrations are read and classified as today. The
   snapshot, the classification, the park and the publication do not change.
3. **The platform build checks it, first.** The platform's own step evaluates the contract of the commit's tree in
   the same credential-free child and compares its digest with the committed artifact's. A mismatch fails the build:
   "the committed contract artifact does not match the source; run `fabrika contract emit`". It runs before any
   authored build command, on a fresh `bun install --frozen-lockfile --ignore-scripts` into an empty `node_modules`.
   On Zerops that is a change of order: today the rendered build runs the authored commands first and the generated
   ones after them (`provider-zerops/src/execution.ts`, `buildCommands: [...authored.commands, ...generated]`), and
   it caches `node_modules` between builds, so a cached tree an earlier authored command touched must not be reused
   for the check. In the Cloudflare runner it is the build's existing compile step (`contract.generated.ts`), now
   compared with the approved artifact.
4. **Boot is unchanged.** The application compares its contract's digest with `FABRIKA_CONTRACT_DIGEST`, the approved
   one, and refuses to start on a mismatch. On Bun it compiles its own source; on Cloudflare it decodes the bundled
   artifact.
5. **Locally** the checker's `literal` and `contract` rules give way, for releases that emit the artifact, to one rule
   that reports a stale artifact, as `db codegen --verify` does for the schema types.
6. **MCP authoring** has no local toolchain (ADR-0049). The dev sandbox already runs the application: `run_checks`
   reports a stale artifact, and a new step emits it in the sandbox and commits it to the workspace branch through
   Control. That is the 3–5 h added to the cost.

What it removes, for the releases that emit the artifact: the literal rule and the contract budgets; the reader of
those minors in Control, the checker and the SPA plugin's literal checks; the reader–runtime differential test (one
evaluator, `compileContract`, produces both sides); and on the consumer, the policy generator, its model checks and
the contract's 161 re-listed imports, all of which can become ordinary code. The readers of older minors stay in
Control until those minors leave the support window.

What it does not remove: the SPA still needs the handlers sliced off before bundling. That rule ("a `.handle` the
slice cannot remove whole is refused") is separate from the literal rule and stays. Whether it can stay without the
reader's literal walk is not verified.

## Design B: the live build reports the artifact

The literal reading of the request: the run's own build evaluates the contract and hands the artifact to Control, and
the snapshot waits for it.

- **Cloudflare**: the runner gets a first job that clones, installs, evaluates and reports the artifact. Control
  classifies it and parks or publishes, and the existing deploy job then rebuilds and refuses an artifact other than
  the approved one. That costs one more container start, clone and install per run (not measured).
- **Zerops** has no runner (ADR-0003). The platform API this repository uses has `build-and-deploy` and the deploy of
  an already built version; a build without activation is not a verified fact (`zerops-platform.md`). So the build
  would have to post the artifact to Control mid-build and wait for publication. A parked run would fail its build and
  build again after approval. `FABRIKA_CONTRACT_DIGEST` is a literal in the execution descriptor rendered before the
  build (ADR-0043), so it would have to move into the build's own output, which is an ADR-0043 change. Control must
  never evaluate the contract itself: it holds the account-wide Zerops token, and that is the core of ADR-0005.

B adds roughly 15–25 h of provider work on top of A, one unverified Zerops fact, and a longer run (a park costs a
failed build). Its trust change is the same as A's, because the same build evaluates the same source. Its one
advantage is that no generated file is committed, which matters most to MCP authoring. **Recommendation: A.**

## What the platform trusts that it does not trust today

Today the artifact the approver sees is computed by Control's own code from the source text at the pinned commit. No
code the author controls takes part in that step. The author can influence only the source text, which is what the
pull request shows. The only gap is a disagreement between the reader and the runtime; a differential test and the
boot check close it.

After the change, the artifact the approver sees was computed by the application's own toolchain: the framework
release its lockfile pins, and the top-level code of every module the contract imports, run on the author's machine or
in the dev sandbox. It is checked against the source only inside the application's build and the application's
process, and the author's code reaches both. In plain terms, the platform newly trusts that:

1. **the toolchain compiled the committed source faithfully.** The artifact is the application's own report, which
   ADR-0005 and ADR-0050 reject today in so many words;
2. **neither the build's check nor the boot check was defeated**;
3. **compiling the contract is deterministic**: it reads no environment variable, clock, random value, network or file
   outside the commit.

**What an author who breaks this can do:** show the approver an artifact narrower than the source. For example it
could hide a new `sql: 'write'`, a new `unscoped` table or a wider table policy, so that a protected environment does
not park on it.

**How the risk is contained:**

- **Enforcement outside the application reads only the approved artifact. This is unchanged and is the main
  containment.** The proxy table, `FABRIKA_CONTRACT_DIGEST`, the IAM schema and the workload, connector and membership
  keys all come from the approved snapshot, never from the checkout. An endpoint, a caller kind or a requirement that the artifact hides is therefore
  refused by the proxy: hiding it makes it unreachable, not open. What a hidden widening could still reach is enforced
  inside the application process: table policies and declared reach (`sql`, `unscoped`, `connect`, `egress`, `kicks`).
- **Reaching that needs the boot check defeated.** On Bun the application compiles its own source and refuses to start
  when the digest is not the approved one. On Cloudflare it decodes the bundled artifact and, at first use, compares
  each endpoint's schema and declaration with it. Defeating either means patching the framework inside the
  application's own process or build. That is a hostile author, which ADR-0012 §8 already says the framework does not
  contain ("This does not stop code that sets out to escape"). The threat ADR-0050 names is the honest but careless
  agent that loosens whatever refused it. The refusal that agent meets here is "the artifact does not match the
  source", and the cheapest fix is to emit it again, which is the faithful fix.
- **The build's check runs on the commit's tree, before anything the author runs.** It comes after a frozen
  `--ignore-scripts` install into an empty `node_modules` and before every authored build command, in a child without
  credentials, under the platform's own Bun configuration with no `preload`. Whether `bun` can be told to ignore an application's `bunfig.toml`
  this way is not verified. Control also refuses a `bun.lock` that patches or overrides `@fabrika/app`,
  `@fabrika/auth-core`, `@fabrika/db` or `zod`: it already reads that file, so the check is data only. This interacts
  with the analysis's proposal to drop the checker's `package-replacement` rule: that rule can go, but this narrow
  refusal moves into Control.
- **Non-determinism fails closed.** A contract that reads an environment variable compiles differently at boot than in
  the build, so the application refuses to start: loud, not open. A checker hint for `process.env`, `Date` and
  `Math.random` in shell modules makes the mistake visible before a deploy.
- **Control still executes nothing.** It parses JSON with a strict parser, so ADR-0005's central property, "the control
  plane never executes app code", holds unchanged.
- **Optional cross-check during the transition.** While an application's source still reads under the static reader,
  Control can read both and refuse a disagreement. That costs nothing new while ADR-0062 keeps the readers for older
  minors, and it detects a faithfulness problem on real applications before the readers go.

**What stays weaker than today:** the pull request's source diff is no longer guaranteed to be what the approver sees;
the artifact's diff in the same pull request is. Handler code was never guaranteed either way.

## ADR text changes

**ADR-0005.** The title stays. In the Context, replace the paragraph that starts "A manifest that the application's
build writes cannot serve that purpose" with:

> The access surface must also be readable without the control plane executing anything, and checked against the
> commit outside the control plane. A contract restricted to what a static reader can parse cost its largest
> application a literal language, budgets and generated sources; the platform's enforcement reads only the approved
> artifact, so what an artifact hides is refused, not opened.

Replace the Decision paragraphs from "We will read an application's contract by static parsing" through "Parsing
evaluates nothing: the reader calls no function of the application." with:

> We will read an application's contract **from the compiled artifact its commit carries**. The application's toolchain
> (`fabrika contract emit`) compiles the contract in a process without credentials and writes the canonical artifact
> beside the source. Control reads that file at the run's pinned commit and parses it as data, with the strict parser
> of the artifact's format. The platform build compiles the contract of the commit's tree before any authored build
> command and refuses an artifact that does not match it. The application refuses to start when its own contract's
> digest is not the approved one. An application on a framework release before the artifact is read by that release's
> static reader, as before.
>
> The control plane reads static JSON. **It never executes app code.**

Keep the paragraphs on the startup check and the Cloudflare encoding. Replace "`readContractSource` in
`@fabrika/check/contract` is the reader…" with a sentence that names the artifact file and the build's check.

In the Consequences, replace "The contract language is literal data…" and "The static reader and the runtime can
disagree…" with:

> - **The contract is ordinary code.** Shell modules may compute their values; the artifact is what they compile to.
>   Compiling must be deterministic: a contract that reads its environment fails the build's comparison or the startup
>   check.
> - **The approved artifact is the toolchain's word, checked twice.** The build's comparison and the startup check
>   bind it to the source. Both run in code the author's application can reach, so an author who patches the framework
>   in its own process can show the approver less than its source declares; enforcement still reads only the approved
>   artifact (ADR-0012 §8).

In the Alternatives, rewrite "Take the access surface from the manifest or an upload" to reject only an upload or a
build-time manifest that is not bound to the commit, and add "Read the contract statically from source", rejected for
its cost, with the reason above. "Extend the reader with partial evaluation" stays rejected: it is moot.

**ADR-0012.**

- §1, rule "The shell is a literal": replace it with "The shell is compiled by the application's toolchain. Its modules
  may compute values; handlers are sliced off for the SPA as before."
- §2: keep the slice rule for the SPA and drop "Control, the checker … read every shell module as its slice".
- §8, the bullet "Control reads the shell from source by static parsing": "Control reads the compiled artifact the
  commit carries; the build and the startup check bind it to the source (ADR-0005)".
- In the Consequences, drop "The literal rule makes the shell more verbose…computed contracts are impossible". In the
  Alternatives, "A computed contract. Rejected" becomes accepted, and "Code-first…the extracted data is the
  application's self-report" names the binding that answers it.

**ADR-0050 §1:** "Right after a run's commit is pinned, Control reads the application's compiled contract artifact
from the commit (or, for an older release, the shell through the static reader of ADR-0005) and the migration files at
that commit." In the Alternatives, "Keep reading access data from the provider artifact or the runner outcome" stays
rejected: both are mutable and not bound to the commit.

**ADR-0062 rule 1:** "The artifact is versioned. From release <n> the application's toolchain produces it and its
commit carries it; Control parses it with its format's parser. An older release in the window is read by the reader of
its minor, which Control bundles." Rewrite the alternative "The application builds and uploads its own artifact" so it
rejects the upload only.

## Migration for existing applications

- An application on an older release changes nothing: Control picks the reader by the release in `bun.lock`, as today.
- An application that raises its pin to the first release that emits the artifact runs `fabrika contract emit` once
  and commits the file. The canonical artifact and its digest are the same ones the reader produced, so the first
  deploy after the switch shows no access change. The compatibility suite (`framework-compat.test.ts`) gets a fixture
  that proves it.
- The consumer can then fold its policy generator back into `src/db/tables.ts` as ordinary code and build the
  contract's groups from its modules instead of listing 161 imports. That is optional and gradual.
- **Rollout path of an existing installation.** No generated installation file, environment variable or provider
  state changes. The Zerops build recipe gains its check step only for releases that emit the artifact:
  `contractRecipe` is platform protocol and changes additively (ADR-0062). The Cloudflare runner ships with the
  platform release.

## Cost to build

| Part                                                                                                            | Agent time  |
| --------------------------------------------------------------------------------------------------------------- | ----------- |
| `fabrika contract emit` and its file, over the existing child                                                   | 1–2 h       |
| Control: the artifact path by release, the size cap, the missing-file refusal, the lockfile patch refusal       | 3–4 h       |
| Build check: the first step of `contractRecipe` on Zerops; the comparison in the Cloudflare runner              | 2–3 h       |
| Checker: the stale-artifact rule; literal rules off for the new release; the SPA slice without the literal walk | 3–5 h       |
| Compatibility fixture and tests                                                                                 | 2 h         |
| ADR-0005, ADR-0012, ADR-0050, ADR-0062, reference and skill text                                                | 3–4 h       |
| **Total A**                                                                                                     | **14–20 h** |
| MCP authoring: emit in the sandbox, commit through Control                                                      | +3–5 h      |
| Design B instead: the runner's first job, the Zerops mid-build callback and the ADR-0043 change                 | +15–25 h    |

Add review rounds; this change moves a security boundary, so it deserves a second, independent reviewer.

## Open questions

- **The artifact's path and form**: committed pretty JSON is reviewable but large. The consumer's contract was about
  2 MB plain (reported), so the file is a few MB and GitHub's web diff may collapse it. The shared encoding is smaller
  but unreadable in a pull request.
- **Bun configuration**: can the build's check run `bun` without the application's `bunfig.toml` `preload`? Not
  verified.
- **The cross-check**: should Control refuse a disagreement between the artifact and the static reader during the
  transition, or only report it?
- **The spread alternative**: the analysis's cheaper option, a reader that accepts spreads of `const` data (3–4 h),
  was not chosen. It also needs an ADR-0005 change ("the reader grows only by specific literal forms"), and it removes
  the 267-refusal class but not the budgets or the generated tables.
