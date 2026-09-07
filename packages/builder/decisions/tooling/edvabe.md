---
id: edvabe
kind: tooling
title: edvabe — local E2B-compatible sandbox runtime
slot: null
provides: [sandbox-runtime, e2b-compat, code-execution, dev-tooling]
requires: []
recommends: [roj, opice]
conflicts: []
npm: []
status: stable
sources:
  - where: "edvabe/README.md"
    read: "Quick start (go install / Docker), the E2B SDK env-var setup, code interpreter + custom templates."
  - where: "edvabe/cmd/edvabe/main.go"
    read: "CLI commands (serve/doctor/build-image), state/cache dirs, and the control-plane scope."
---

# edvabe

## What it is

A **single Go binary** exposing a wire-compatible subset of the **E2B sandbox API**
locally (port 3000). Point an unmodified E2B SDK (Python/TS) at it via env vars and
sandboxes run in local Docker containers instead of E2B's cloud — a drop-in for
dev/testing. Additive dev tooling (`slot: null`).

## When & why to use

- **Local sandboxed code execution** for agent/code-interpreter workflows — pairs with `roj` (its tools run code in a sandbox).
- Test E2B SDK code without cloud cost; offline/air-gapped dev.

## When NOT to use

- Production / multi-tenant / HA (single-user local-dev only); workloads needing Firecracker microVM state preservation; Windows.

## Gotchas

- Needs the **Docker socket mounted** (creates sibling sandbox containers).
- It's the **control plane** only; the data plane is the upstream `envd` reverse-proxied (don't bump the hardcoded `envdVersion` blindly).
- **Pause ≠ snapshot** — `docker pause` keeps RAM up to a cap, then demotes to stop (RAM lost; resume needs re-init).

## Relationships — why

- **slot `null`** — additive; **recommends `roj`** (local sandbox for agent tool execution) and **`opice`** (agent-driven tests that execute code).
