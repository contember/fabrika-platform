---
id: 176
title: The runtime does not know the declared secret names
blocked-by: []
---

# 176 — The runtime does not know the declared secret names

**Summary.** An error report scrubs an application secret only when its variable name says it is one; the platform
knows the declared names and does not hand them to the runtime. Small, touches both providers.

## Problem

[ADR-0059](../decisions/0059-application-server-errors-carry-their-stack-and-message.md) scrubs the values of
application variables whose name matches a secret pattern (`packages/app/src/jobs/scrub.ts`, `SECRET_NAME`). An
application that declares `pipeline.secrets: ['STRIPE']` gets that value delivered as `STRIPE`, which matches no
pattern, so a message that quotes it reaches Operations unscrubbed. Control and the providers know the declared
names (`packages/provider-contract/src/authoring.ts`, `AppPipeline.secrets`); the runtime does not.

## Approach / acceptance

The platform writes the declared secret names into a framework variable (a new `FRAMEWORK_VARIABLE_NAMES` entry,
names only, never values) on both providers. `secretValues` scrubs those variables' values in addition to the
pattern. Witness: a report of an application whose secret is named `STRIPE` carries no trace of its value.

## Touch points

`packages/auth-core/src/framework-variables.ts`, `packages/provider-zerops/src/managed-env.ts`,
`packages/provider-cloudflare/src/control.ts`, `packages/app/src/jobs/scrub.ts`.
