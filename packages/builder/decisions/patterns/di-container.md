---
id: di-container
kind: pattern
title: DI container / IoC (Proxy-based lazy-memoized container)
slot: null
provides: [dependency-injection, ioc, service-composition]
requires: []
recommends: []
conflicts: []
status: stable
sources:
  - where: "MDN Proxy documentation"
    read: "Language semantics for lazy getters, memoization, and circular-dependency detection."
  - where: "Martin Fowler — Inversion of Control Containers and the Dependency Injection pattern"
    read: "Composition-root ownership and dependency lifetimes."
---

# DI container / IoC

## What it is

A lightweight **dependency-injection container**: a class whose services are **getter
properties**; the constructor `return createContainer(this)` wraps it in a Proxy that
**memoizes each getter on first access** and **detects circular dependencies**. No
external lib, no decorators/reflection. Scope = container lifetime (one per request,
one per Durable Object). Eliminates `new Service(db, logger, clock, …)` chains — you
write `this.serviceA` and lazy resolution does the rest.

## When & why to use

- Tightly-coupled services sharing resources (db, logger, config, clock) that should init once per request/actor.
- You want lazy instantiation (only used services are built) + cheap cycle detection, without a heavy framework.

## When NOT to use

- You need constructor factory params, lifecycle hooks (`onDestroy`), or reflective metadata → a full container (inversify/awilix/tsyringe).

## Gotchas

- **Constructor must be only `return createContainer(this)`** — no field assignments.
- **Use getters, not class fields** — an arrow-function field captures `this` before the Proxy wraps it and bypasses memoization/cycle detection.
- **Mocks via `setService()`** (test API) pin a service for the container's life.
- **Cycle errors are lazy** — thrown at access time, not container creation; an unused cycle stays hidden until that path runs.

## Relationships — why

- A pure TS pattern (no tech deps). Pairs with `feature-architecture` (the container is where adapters get wired into domain services).
