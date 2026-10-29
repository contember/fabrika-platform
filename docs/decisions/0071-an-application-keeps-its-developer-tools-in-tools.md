---
id: 0071
title: An application keeps its developer tools in tools/
status: proposed
date: 2026-10-29
---

# 0071: An application keeps its developer tools in tools/

## Context

An application's repository holds code that never runs in the application: a command line an AI assistant or a person
uses against a deployed environment, typed against the contract (`createClient(contract, 'api', { baseUrl, key })` with
a service key). Such a tool reads its key from the developer's keychain, its origin from the environment, and spawns
processes. `fabrika-check` refused all of that: every source file outside a dot directory gets the rules for code that
runs in the application (`env-read`, `forbidden-global`, `forbidden-import`, `cross-app-fetch`, `sensitive-log`), and
only tests are exempt from some of them.

Those rules exist because the code they read runs in the application's process, on the platform. A tool runs on a
developer's machine, with the developer's own credentials; the rules have nothing to protect there. What has to hold
is the other direction: nothing the application runs may load a tool, or the exemption becomes an escape from the
rules for application code.

## Decision

We will treat `tools/` at the application root as a developer's tools.

- A module under `tools/` (its tests included) is checked only for how it is written (`type-assertion`, `any-type`,
  `suppression-comment`, `capability-widening`), `key-literal`, `package-replacement`, `generated-test-import` and the
  rules of its tests. Every other rule is lifted there.
- `tool-import` (a refusal) refuses a value load or re-export of a module under `tools/` from any module outside it:
  a server module, the SPA, a test, `fabrika.config.ts`, through an import map, a `tsconfig` path or a literal
  `import()`. A type-only import is erased and stays, as everywhere.
- A `[test] preload` in `bunfig.toml` may not name a module under `tools/`, and no `package.json` may lie under
  `tools/` (`tool-import` too): a package there could be loaded by its name, through a workspace or a `file:`
  dependency, which no import's resolved file shows.
- The place is fixed. No configuration names another directory, and nothing narrows `tool-import`.

## Consequences

- An application can keep a typed command line over its own contract in its repository, where a contract change
  breaks its typecheck.
- Moving application code into `tools/` takes it out of the application: no entrypoint or bundle loads it. That is
  why the place is not a suppression in the sense of the checker's invariant, and why
  `tool-import` must stay a refusal.
- A Zerops deploy copies the whole tree (`deployFiles: ./`), so `tools/` is in the container, but nothing there
  loads it. A Cloudflare deploy bundles from the generated entrypoint and never reaches it.
- An application's own build commands could still run a tool. They are the author's, and the checker never claimed to
  judge them.
- A tool's tests are tests like any other: the platform build's tests step (`bun test` over the repository) runs them,
  and `fabrika db test-isolation` does not, since it runs the generated tests by path. That step runs before
  `fabrika-check`, so the checker never vouched for what a test does in the build, in `tools/` or anywhere else. A
  tool's test must therefore pass in the build: it tests the tool's logic, and reaches no keychain and no network.
- The checker's rules are the framework API: an application meets the change when it raises its `@fabrika/check` pin.
  No platform protocol changes.

## Alternatives considered

- **A dot directory (`.cli/`).** The checker already skips dot directories and refuses imports into them, so it
  works today. It hides the tool from the reader of the repository and from the checker's other rules (a key literal,
  a type assertion), and it reads as a trick.
- **A list in `fabrika.config.ts`.** A configurable exemption is exactly the per-rule switch the checker refuses to
  have: an agent blocked by a rule would add its directory to the list.
- **A separate repository.** The tool loses the contract's types, and a contract change no longer breaks it.
- **Lifting single rules in `tools/` (only `env-read` and process spawning).** A tool also fetches its own origin,
  logs an error and reads files; lifting rule by rule grows with each tool, while the boundary that matters is
  `tool-import`.
