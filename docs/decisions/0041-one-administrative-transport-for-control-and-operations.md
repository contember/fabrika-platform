---
id: 0041
title: One administrative transport for Control and Operations
status: accepted
date: 2026-09-21
---

# 0041 — One administrative transport for Control and Operations

## Context

Control and Operations expose the same administrative operations through typed RPC and REST adapters. The console uses RPC, and the Control CLI uses the same `ControlRpcContract` (ADR-0033). REST was retained for compatibility. The project owner explicitly confirmed that this compatibility is not required.

Sharing payload validation reduces duplication but still leaves two route tables, transport error mappings and sets of transport tests. Internal consumers can use the existing RPC contract instead.

## Decision

**Control and Operations have one administrative transport: their existing typed RPC contracts.** Remove duplicate administrative REST endpoints, their adapters and unused transport-only exports. Migrate internal consumers to RPC without a compatibility shim or deprecation period.

Preserve domain use cases, authorization, audit, persistence and failure semantics. Transfer behavioral tests to RPC or the domain boundary; replace obsolete REST availability assertions with tests that removed routes no longer dispatch operations.

Protocol-specific HTTP remains: authentication and callbacks, webhooks, health checks, assets, Sentry ingest, source-map upload, and private catalog/release reconciliation. IAM's four provisioning REST operations are outside this decision. The Operations gateway forwards its RPC endpoint while retaining same-origin admission and token forwarding.

## Consequences

Existing administrative REST callers must migrate. This is intentional. Console and CLI continue to use the existing RPC contract. Removing an adapter must not remove its domain behavior or weaken authorization coverage.

## Alternatives considered

- Keep both transports over shared input definitions: rejected because compatibility is unnecessary and duplicate transport maintenance remains.
- Generate REST and RPC from one endpoint definition: rejected because a second public administrative transport has no current requirement.
- Convert every HTTP protocol to RPC: rejected because callbacks, streaming uploads and externally specified protocols have separate requirements.
