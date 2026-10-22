---
id: 0067
title: Public packages ship declarations beside their TypeScript sources
status: accepted
date: 2026-10-22
---

# 0067 — Public packages ship declarations beside their TypeScript sources

## Context

Every package runs on Bun, which executes TypeScript. The packages therefore have no build step: each `exports` entry
names its source for every condition (`bun`, `types` and `default` → `./src/….ts`), in the workspace and in the
published tarball.

An application's type check pays for that. `skipLibCheck` skips only declaration files, so the TypeScript of a package
under `node_modules` is checked like the application's own. The platform's build type-checks a Zerops application
(`provider-zerops/src/execution.ts`, `tsconfig.platform.json`). For the example Zerops application, that check read
893 files: 229 of them were `@fabrika/*` sources with 53,587 lines, against 698 lines of the application's own. It took
13–27 s on the Zerops build container. The framework's sources are already type-checked by this repository's CI, under the
compiler options they are written for.

## Decision

We will ship a declaration file for every TypeScript module that a public package ships, and type every entry by it.
Bun keeps running the sources.

1. **Pack time only.** `release:pack` emits the declarations into the staged copy of each package. It uses
   `emitDeclarations` in `scripts/declarations.ts`, with the compiler options of the package's own `tsconfig.json`. They
   go under `types/`, which mirrors the package's tree. A declaration must not sit beside its source: TypeScript prefers
   `x.ts` over `x.d.ts` for the same import. Nothing is committed. In the workspace every `types` condition still names
   the source, so development, the type check and the tests need no build.
2. **The shipped manifest repoints only `types`.** In a condition object, `types` names `./types/….d.ts`; `bun` and
   `default` keep the source. A bare TypeScript target, such as a package `imports` entry, becomes
   `{ types, default }`. `files` gains `types`.
3. **Declarations are held to the source's rules.** Any diagnostic of the emit fails the pack. The imports of the
   emitted declarations must name declared public dependencies, like the imports of the sources
   (`assertPackedImports`). An inferred type can name a package that the source never imports.
4. **The smoke reads them as an application does.** `release:smoke` and `release:registry-smoke` type-check every typed
   entry of every package in the isolated consumer. They use the platform build's compiler options, with
   `skipLibCheck` off and the ambient type packages each package develops against. The smoke fails when an entry does
   not resolve, when a declaration has an error, or when the program reads a `@fabrika/*` source instead of a
   declaration. With `skipLibCheck` on, a name that a declaration cannot resolve would be `any` in the application,
   and nothing would report it.
5. **One compiler.** The repository's TypeScript writes the declarations, and the platform build reads them with
   `PLATFORM_TYPESCRIPT_VERSION`. A test keeps the two equal, because a newer compiler can write syntax that an older
   one cannot parse.

## Consequences

- The platform build's type check reads 169 `@fabrika/*` declaration files (22.5k lines) instead of 229 sources
  (53.6k lines). For the example Zerops application it checks 698 lines of TypeScript instead of 54,514. On the Zerops
  build container it takes 4–5 s instead of 13–27 s, and uses about 175 MB of memory instead of 515 MB.
- An application's errors stay the same. The type-mistake fixtures of `@fabrika/app` and `@fabrika/db` report
  identical diagnostics against the sources and against the declarations. A framework type that an application
  misuses is exact in both.
- An inferred type in a declaration is fixed at emit, under the package's compiler options, and not under the
  application's options. The platform build uses the same strict flags as the packages. Only the Cloudflare packages
  relax two flags.
- `release:pack` takes about 90 s longer. It type-checks each public package again to emit its declarations.
- This is a framework packaging change, not a protocol change
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). The build step and its compiler options do
  not change. An application on a release without declarations installs that release's tarballs, and its build reads
  the sources as before. An application gets the faster check when it raises its pin to a release that ships
  declarations.
- An installation runs the git checkout of its tag, where `types` names the sources, so no installation path reads
  the declarations. `fabrika platform upgrade` changes no generated file, environment variable or provider state.
- A new public package that exports TypeScript gets declarations without any configuration. Its declarations must
  emit without a diagnostic and resolve in the smoke.

## Alternatives considered

- **Compile the packages to JavaScript and declarations.** Rejected: Bun runs TypeScript. A JavaScript build would add
  a second artifact to keep in step with the source, and it would not make the application's type check faster than
  declarations do.
- **Commit the declarations, or generate them in the workspace.** Rejected: every change would need a build before the
  type check or the tests, and a stale declaration would type the workspace differently from its source.
- **`isolatedDeclarations` with explicit types on every export.** Rejected for now: it would require annotations across
  the framework's inferred builder types. The declarations would be the same.
- **Tell applications to exclude `node_modules` or tune their `tsconfig.json`.** Rejected: `skipLibCheck` cannot skip a
  `.ts` file. The platform build uses its own tsconfig and does not read the application's.
