---
id: 245
title: A namespace keeps its Box host after its last dev environment
blocked-by: []
---

# 245 — A namespace keeps its Box host after its last dev environment

**Summary.** The namespace job creates the `zbox` service when a `dev` member needs it, and nothing removes it when the
namespace's last `dev` environment is gone. It keeps running and costs its reserved resources. Small to medium.

## Problem

`ensureSandboxHost` (`packages/provider-zerops/src/namespace/sandbox-host.ts`) imports the Box Workspace service the
first time a namespace's members include a `dev` environment. A namespace without a `dev` member gets no host, but one
that had a `dev` member keeps it after the environment is deleted: no step reads the members and removes the service,
and the vault keeps its key ([244](244-dev-sandbox-vault-rows-outlive-what-they-protect.md)).

## Approach / acceptance

When a namespace job finds no `dev` member and the namespace still has a `zbox` service, delete the service (and its
key's vault row), after every sandbox record of the namespace is gone. Fabrika deletes no provider resource of an
application (ADR-0034); the Box host is the namespace's own, like its proxy, so decide and record that it may. Test: a
namespace job after the last `dev` environment's deletion deletes the `zbox` service once, and a later job does
nothing.

## Touch points

- `packages/provider-zerops/src/namespace/sandbox-host.ts`
- `packages/provider-zerops/src/namespace/provisioning.ts`
- `packages/control/src/api/namespaces.ts`
