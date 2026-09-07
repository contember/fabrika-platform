---
id: feature-architecture
kind: pattern
title: Feature-split + light hexagonal (ports & adapters)
slot: null
provides: [feature-modules, hexagonal, ports-adapters, testable-domain]
requires: []
recommends: [di-container, opice]
conflicts: []
status: stable
sources:
  - where: "AWS Prescriptive Guidance — hexagonal architecture pattern"
    read: "Domain/application core, ports, adapters, and composition boundaries."
  - where: "roj — packages/sdk/src/ports/ (session/event-store/runtime ports) + adapters"
    read: "The same ports/adapters split for an agent SDK that runs on Bun, E2B, or local."
---

# Feature-split + light hexagonal

## What it is

The app is organized **by feature/domain** (`model/<feature>/` — pure logic, no
platform imports), platform concerns sit behind **ports** (`ports/` — interfaces:
storage, llm, actors, observability, schedule), implemented by **adapters**
(`adapters/cloudflare/` for prod, `adapters/inmemory/` for tests), and an **app/**
composition layer wires adapters into services (via the DI container) and exposes
transport (HTTP/RPC/cron). Dependency direction is enforced: **domain → ports;
adapters implement ports; nothing in `model/` imports an adapter or a CF value**.

## When & why to use

- Multiple targets/backends (cloud vs local, CF vs in-process, swappable LLM/storage providers).
- You want the domain **testable without the platform SDK** — unit tests run on in-memory adapters (no CF account, fast).

## When NOT to use

- Single platform forever, no local testing — the indirection isn't worth it. Only pays off with ≥2 implementations of a port.

## Gotchas

- **Ports are interfaces** — don't add classes/subclasses; if it doesn't fit, add a port or an adapter method.
- **Adapters are implementation details** — tests know only the port; `instanceof MapObjectStore` is a leak.
- **Enforce the dependency direction in lint** — `model/**` may only `import type` from `cloudflare:workers`; never a value import or an `adapters/` import.
- **Port signatures are a contract** — once multiple adapters + call sites depend on one, changing it is a breaking change; lock it with contract tests early.

## Relationships — why

- **recommends `di-container`** (wires adapters → domain services) and **`opice`** (the in-memory adapters make the running app cheap to drive in tests).
