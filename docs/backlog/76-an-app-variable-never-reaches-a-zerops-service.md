---
id: 76
title: An app variable never reaches a Zerops service
blocked-by: []
---

# 76 — An app variable never reaches a Zerops service

**Summary.** `apps.variables.put` records a value the console and CLI both accept, and the Zerops
deploy writes none of it to the service. The one variable the worked example cannot boot without is
set by hand. Effort M — the fix is a decision, not a diff.

## Problem

`ProviderDeployInput` carries `vars` alongside `secrets` and `managedEnvironment`
(`packages/provider-contract/src/control.ts:70-73`). The Zerops control provider writes
`managedEnvironment` to the service and nothing else
(`packages/provider-zerops/src/control.ts:490-515`); `vars` reaches only
`interpolateManifest(renderFabrikaImportYaml(...), artifact.app.pipeline.vars, run.vars)`
(`packages/provider-zerops/src/provider.ts:462`), which substitutes `${NAME}` in the IMPORT document
and only for names the app declared in `pipeline.vars`.

So an operator who sets a variable an app did not declare gets a stored row and no effect, with no
error anywhere. Measured live on 2026-08-19: `control apps variables put --app=notes --env=prod
--name=FABRIKA_IAM_ISSUER` was accepted, the value never appeared in the service's environment, and
every container kept exiting with `FABRIKA_IAM_ISSUER is required` until the same value was written
straight through the Zerops env API.

The example's own `zerops.yaml` says this variable is "addressed BY SERVICE through the env API",
which is the mechanism fabrika does not perform on this path.

## Approach / acceptance

Decide which of the two is right, because they are not the same thing:

- **`FABRIKA_IAM_ISSUER` is platform-owned.** The installation knows its IAM issuer, exactly as it
  knows `FABRIKA_OPERATIONS_DSN`, which `managedEnvironment` already carries. Then this belongs in
  `managedEnvironment` and no app ever sets it.
- **Operator variables should reach the service.** Then the Zerops provider writes `vars` the way it
  writes `managedEnvironment`, and the two namespaces of names need a stated precedence.

Whichever wins, an undeclared variable must stop being silently inert: either it applies, or the
write is refused.

Witness: a fresh app deploys and boots with no hand-written service variable, and setting a variable
either takes effect on the next deploy or is refused at the point it is set.

## Touch points

`packages/provider-zerops/src/control.ts`, `packages/control/src/run-lifecycle.ts`,
`packages/provider-contract/src/control.ts`, `examples/zerops-app/`.

<!-- Origin: found bringing the first app up in a live namespace, 2026-08-19. -->
