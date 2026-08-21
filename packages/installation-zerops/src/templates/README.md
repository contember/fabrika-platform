# {{REPO}} — the {{INSTALLATION}} fabrika installation (Zerops)

The **per-installation root of trust** for the `{{INSTALLATION}}` fabrika installation on Zerops. Its
GitHub pipeline deploys the platform so that the platform never deploys itself: the credentials for
this Zerops account live here, in a GitHub Environment, and not in the public
[contember/fabrika-platform](https://github.com/contember/fabrika-platform) repository that many
operators install from.

## This pipeline UPDATES an installation. It does not create one.

Running it against a project that has no `iam`, `operations`, `source`, `proxy` and `control` service fails and
changes nothing. The first bring-up is still a hand sequence, in this order:

1. import the Zerops topology **without code** — `fabrika platform plan --provider=zerops` lists and
   validates the generated `*.provision.zerops-import.yaml` documents; the operator applies the one for
   their tier,
2. write every secret each service holds — signing keys, the IAM RPC/proxy/provisioning keys, the
   vault key, database and object-storage coordinates,
3. deploy once, so the proxy has HTTP ports and therefore a public address.

From then on, this pipeline owns the installation.

## One step, and why

The whole ordered sequence lives inside `fabrika platform deploy --provider=zerops`:

```
resolve the project and its services
  → write every service's environment (the composed proxy manifest, the environment name, the origins)
  → deploy iam + operations + source together, then proxy → control, waiting for each
  → reconcile the console's app schema with IAM
  → ensure the public entry point
```

That order is a security property, not just a dependency: a fabrika application enforces nothing by
itself, so the enforcement proxy is deployed **before** the control plane whose gates just changed. It
therefore lives in code with a test, rather than in a workflow file that can be edited. The Cloudflare
sidecar repository keeps its order in the workflow instead; the two providers differ deliberately.

The run is unattended and idempotent. A re-run redeploys; it writes only the variables that differ,
enables no subdomain that is already published, and reconciles the same schema. A run that cannot
apply the proxy manifest never reaches the deploy, so new code never ends up behind an older, more
permissive manifest.

## What `fabrika.ref` pins, and what it does not

[`fabrika.ref`](./fabrika.ref) pins a **published tag** of `contember/fabrika-platform` — never a
branch. The workflow refuses anything that does not look like a tag.

That tag decides everything this pipeline DOES: the deploy order, the proxy manifest it composes (the
gate rules that enforce the whole installation), the console schema it reconciles, and every variable
it writes.

It does **not** decide which revision Zerops BUILDS. A Zerops build takes its source from the service's
own repository integration, or from the `FABRIKA_ZEROPS_BUILD_FROM_GIT` URL — and that URL selects a
repository, not a revision. Until each service is connected to a repository with a tag trigger, treat
the pinned tag and the built code as agreeing only when the tag is the tip of the branch Zerops
builds. This is the one place where the pin does not reach.

## The `{{INSTALLATION}}` GitHub Environment

Written by `fabrika platform init --provider=zerops {{INSTALLATION}}`, not by hand.

The same init leaves source in anonymous public-repository mode. Configure an organization-owned GitHub
App later in the authenticated Control console at **Settings → Source**. The private key stays on the
platform's `source` service and the webhook secret stays in Control's encrypted vault; neither is copied
into this repository or Environment. If an older installation already has a complete GitHub App
credential set, init preserves it and directs the operator to adopt it in Control. Partial, invalid, or
mismatched state is refused. Init never reads or writes a local GitHub credential recovery file.
If an older init left such a file, adopt a complete remote credential set in Control and delete the
file only after the UI reports connected. If the remote state is empty or partial and the file is the
only complete copy, use the last compatible CLI release to finish remote persistence first.

**Secrets** — both belong to the installation and are placed on it at bring-up. `init` copies them
here; it never generates one, because a value this repository invented would not be the value the
installation already holds.

| Secret                         | What it is                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FABRIKA_ZEROPS_ACCESS_TOKEN`  | A Zerops **integration** token scoped to this installation's projects (client role `NO_ACCESS`, per-project `ADMIN`) — never a personal access token.  |
| `FABRIKA_IAM_PROVISIONING_KEY` | The `px_` admin key the installation's IAM already holds as `FABRIKA_IAM_PROVISIONING_KEY`. The deploy authenticates the console's schema PUT with it. |

**Variables** — the rest of the configuration, all non-secret.

| Variable                           | Required | What it is                                                                                               |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `FABRIKA_ZEROPS_PROJECT_ID`        | yes      | The Zerops project holding the five platform runtime services.                                           |
| `FABRIKA_PLATFORM_ENVIRONMENT`     | yes      | The name this installation calls itself; written to every service as `ENVIRONMENT`. Never `local`.       |
| `FABRIKA_PLATFORM_SCHEME`          | yes      | `https` for anything reachable from a browser.                                                           |
| `FABRIKA_PLATFORM_IAM_HOST`        | no       | Where IAM answers publicly.                                                                              |
| `FABRIKA_PLATFORM_CONSOLE_HOST`    | no       | Where the console answers publicly.                                                                      |
| `FABRIKA_PLATFORM_OPERATIONS_HOST` | no       | Where Operations ingest answers publicly.                                                                |
| `FABRIKA_ZEROPS_BUILD_FROM_GIT`    | no       | Public repository Zerops builds each service from. Empty uses each service's own repository integration. |
| `FABRIKA_ZEROPS_API_URL`           | no       | Region API base, when this installation is not on the default one.                                       |

The three host variables go together: **all three, or none.** Naming none derives them from the
proxy's generated Zerops subdomains, and the deploy publishes that subdomain. Naming all three makes
this a custom-domain installation — the domains are bound to the project balancer out of band, and the
deploy publishes no subdomain, because that would add a second public address nobody asked for.

There is deliberately **no bootstrap-admin variable here.** This pipeline writes no credential and no
admission list — it configures where the installation answers and deploys it. Who may administer the
installation is IAM's to say, and it is said through IAM's own admin surface. Nothing about this
repository has to be closed off later.

## Roll forward, or redeploy

- Bump [`fabrika.ref`](./fabrika.ref) to a newer published tag and push. That is the version bump.
- Or run _Actions → platform → Run workflow_ for a redeploy at the same tag.
- Tick **dry_run** on that manual run to read the installation and report what would change without
  writing or deploying anything. It is the safe first run after editing the Environment.

Only a change to `fabrika.ref` or to the workflow triggers a push-driven run; editing this README does
not deploy.

`fabrika.ref` is operator-owned: `fabrika platform init` writes it once and never overwrites a later
version pin.
