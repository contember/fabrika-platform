---
id: roj
kind: technology
title: roj — agent SDK (@roj-ai/*) for building AI agents
slot: agent-sdk
provides: [agent-runtime, llm-orchestration, streaming, sessions, event-sourcing, plugins]
requires: []
recommends: [cloudflare, durable-objects, d1, r2, react]
conflicts: []
npm: ["@roj-ai/sdk@^0.1.18", "@roj-ai/transport@^0.1.18", "@roj-ai/client@^0.1.18", "@roj-ai/client-react@^0.1.18"]
status: wip
sources:
  - where: "roj/CLAUDE.md + packages/sdk/src/index.ts"
    read: "The plugin DSL, event sourcing, preset/agent builders, session management, and LLM provider surface (Anthropic/OpenRouter/mock)."
  - where: "roj/packages/demo/"
    read: "A full e2e example: preset + standalone server + React SPA + snapshot tests."
---

# roj

## What it is

An **agent SDK** (`@roj-ai/*`, the OSS successor to buresh): a TypeScript framework
for multi-agent systems with persistent sessions, event sourcing, a plugin
architecture (filesystem/shell/chat/limits/skills/…), and streaming LLM inference.
Apps define **presets** (agents + plugins + system prompt), wire an LLM provider
(Anthropic native, OpenRouter, or mock), and expose a REST/WebSocket API. It is
LLM-provider-agnostic and host-agnostic. It can be composed with Workers, Durable
Objects, WebSockets, D1, and R2 for a production deployment.

## When & why to use

- **Building AI agents/assistants** into an app (codegen, research, automation) with multi-turn, stateful tool calls.
- You want **event-sourced** sessions (auditable, replayable) and pluggable tool/skill libraries without provider lock-in.

## When NOT to use

- **One-off inference** (single prompt→response) → use the Anthropic SDK / OpenRouter directly.
- No multi-turn/stateful needs.

## Impacts & gotchas

- **Client/server split + async sessions** — agents run server-side; the client creates a session and streams updates over WebSocket. Plan UX for async + reconnection.
- **LLM key handling** — provide and encrypt the provider key; never log it. The default uses Anthropic/Claude.
- **Tool/sandbox security** — plugins execute shell/filesystem in a sandbox (E2B / `edvabe` locally); sanitize tool inputs.
- **DO hibernation** — on CF, the in-memory runtime is rebuilt from the event log via an alarm; don't delete session records.

## Relationships — why

- **slot `agent-sdk`** — the agent layer; composes with any UI/backend.
- **recommends `cloudflare` + `durable-objects`** (one DO per agent instance), **`d1`/`r2`** (session/artifact storage), **`react`** (`@roj-ai/client-react` chat UI). The SDK itself requires none of these — it runs on Bun/Node too. Pairs with `edvabe` for local sandboxed tool execution.
