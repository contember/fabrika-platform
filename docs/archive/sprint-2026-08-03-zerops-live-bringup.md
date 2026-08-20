# Sprint 2026-08-03 — Zerops live bring-up

> ## OUTCOME — shipped
>
> The Zerops path is no longer unexercised. The `light` tier is **live on `prg1`** in
> project `fabrika-test`: IAM, Operations, control, the auth proxy and an example app
> all build, boot and serve, on one shared `postgresql:single@18` and one bucket.
>
> **Commits.** `0eed4da` light tier · `8250d6b` `zeropsSetup`/`buildFromGit` ·
> `768f9ab` `prepare` portability · `5ba87d1` + `4e7ba49` proxy listeners ·
> `389dabe` `FABRIKA_ZEROPS_*` rename · `d1b612d` login return URL.
>
> **Verification.** 1577 tests, 0 failures, run against a real Postgres and a real
> S3 — no suite skipped. Typecheck, biome and dprint clean. Live: every claim in
> "Findings" below was produced by a request to the running installation.
>
> **Six defects found, five fixed.** Each was invisible to schema validation and to
> the dry-run driver; all six needed an account. F12 is open by choice —
> [`backlog/48`](../backlog/48-decide-how-the-proxy-learns-its-public-scheme.md).
>
> **Deferred, with the user's agreement.** The production two-project topology,
> custom domains, browser SSO (needs them), and every deploy the control plane
> triggers itself — the last blocked on
> the later [application deploy sprint](sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md).
> Remaining scope folded back into
> [`backlog/05`](../backlog/05-bring-up-on-a-real-zerops-account.md); the platform
> facts into [`reference/zerops-platform.md`](../reference/zerops-platform.md).

**Theme.** Take fabrika's Zerops path off paper and onto a real account, and build the
single-project **light tier** the account can actually afford.

Account: `matejka@contember.com`, org Contember, region `prg1`.
Project: `fabrika-test` (`0niMIbRAR4SR6qs8soYL8A`), `corePackage: LIGHT`,
`envIsolation: service` (confirmed by `zz api ExportProject`).

Closes the live half of [`backlog/05`](../backlog/05-bring-up-on-a-real-zerops-account.md).

## Decisions taken with the user

1. **Light tier, not the committed production topology.** One shared
   `postgresql:single@18` for IAM, Operations, control _and_ apps; min 1 container
   everywhere; `corePackage: LIGHT`.
2. **`ENVIRONMENT` becomes a per-installation variable**, written through the env API
   instead of being baked into the committed root `zerops.yaml`.
3. **One project.** Platform and the example app share `fabrika-test`. This deliberately
   relaxes [ADR-0006](../decisions/0006-two-projects.md) for the light tier; the
   cross-project hop is out of scope for this sprint.
4. **`zz push` for now**, no git integration. fabrika's GitHub App does not reach the
   Zerops path at all — see finding F5.

## Load-bearing facts, verified live at HEAD

Verified with a throwaway `probe` service (`alpine/bun@1.3` → resolved to `1.3.9`) plus a
real `db` (`postgresql:single@18`) in `fabrika-test`.

### F1 — env-API variables DO resolve `${service_var}` at container start ✔

The light tier depends entirely on this, and it holds:

```
RUNTIME PROBE_REF=[postgresql://db:…@db:5432]     # stored as ${db_connectionString}
RUNTIME PROBE_SELFREF=[probe]                     # stored as ${probe_hostname}
```

`zz env show` reports the **stored** form (`${db_connectionString}`); resolution happens
in the container. So a data-service reference can move out of the committed
`zerops.yaml` and become per-installation configuration without losing anything.

### F2 — a build container sees NONE of its service's env-API variables ⚠

```
BUILD sees PROBE_REF=[]  PROBE_LITERAL=[]  PROBE_SECRET=[]
```

Answers the old backlog 44 (deleted; the fact now lives in [`../reference/zerops-platform.md`](../reference/zerops-platform.md)). As
committed, the proxy's `printf %s "${FABRIKA_PROXY_MANIFEST_JSON}" > ./proxy.manifest.json`
build command would write an **empty** file, `generate-config.ts` would exit non-zero, and
the proxy could never deploy on Zerops.

### F3 — but `${RUNTIME_*}` bridges them, nested references included ✔

```yaml
build:
  envVariables:
    BRIDGE_REF: ${RUNTIME_PROBE_REF}
```

```
BRIDGE_LITERAL=[plain-value-42]
BRIDGE_REF=[postgresql://db:…@db:5432]    # nested ${db_connectionString} resolved too
BRIDGE_SECRET=[sekret-abc]
DIRECT_LITERAL=[]                          # the same key without the bridge stays empty
```

So F2 costs one declaration in `setups.ts`, not the move of manifest materialization into
`run.initCommands` that the setup header anticipated.

### F4 — the `user-data` list NEVER succeeds; the WRITE works ⚠

```
GET  /service-stack/{id}/user-data  → 400 serviceStackNotFound
POST /service-stack/{id}/user-data  → 200
```

Confirms `backlog/41` (since shipped and deleted) and
goes past it: the list 400s on services that have deployed successfully too, so it is not
"not readable yet" but _never readable_. `putServiceEnv` lists before it writes, so no
code in `packages/` can write a Zerops service variable at all. POST on an existing key
returns `userDataDuplicateKey` rather than replacing, and the only working read is
`POST /user-data/search` — which needs a `clientId` the API client does not carry, making
the fix a signature change. The bring-up used a standalone script instead.

### F5 — fabrika's GitHub App does not reach the Zerops path

`repoSource` / `GitHubAppRepoSource` is consumed only by `platform-cf.ts`. The Zerops
driver offers a public `buildFromGit` URL or nothing; the private-repo path is _Zerops'
own_ GitHub OAuth integration, connected per service
(`SetupExternalRepositoryIntegration`, `repositoryFullName` + branch + `zeropsYamlSetup`).
The account has no GitHub authorization yet (`githubAuthorizationRequired`), and the repo
has no git remote. The later
[application deploy sprint](sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md) delivered the
private application-source path.

### F6 — version aliases are real; `zz catalog` lists only concrete versions

`alpine/bun@1.3` provisioned as `alpine/bun@1.3.9`. Both the import and `zerops.yaml`
schemas accept the alias and `alpine/go@latest`. No change needed. `alpine/go@latest` resolves to Go 1.22 and Caddy 2.10.2 built anyway — Go's automatic
toolchain download supplies the rest. Confirmed when the proxy built.

## Findings from the bring-up itself

Six defects, each of which only a real account could surface. All are fixed and
committed except F12.

### F7 — `zeropsSetup` without `buildFromGit` is refused ⚠ fixed

`400 projectImportInvalidParameter`, `{"iam.buildFromGit": ["parameter is required
for use of pipelineConfig"]}`. Every generated provisioning document named
`zeropsSetup` on its runtime services, so **step 1 of the documented bring-up could
not succeed for any topology**, standard or light. Schema validation cannot catch it:
the field is legal, the combination is not. → `8250d6b`.

### F8 — `prepare` shelled out to a machine-local tool ⚠ fixed

`bun install --frozen-lockfile` exited 1 inside every Zerops build container with
`Executable not found in $PATH: "cpu-lease"`, before a single build command of ours
ran. Pre-existing, from `5d0084a`; it would have broken CI too. → `768f9ab`.

### F9 — `ZEROPS_` is a reserved prefix ⚠ fixed

`400 userDataZeropsPrefixForbidden` — "Custom env variables with 'ZEROPS_' prefix
are forbidden." Every credential the Zerops control provider reads was named that
way, and the env API is the only channel a per-installation secret has on that
platform. **The control plane could not be configured on the platform its variables
were named after.** Renamed to `FABRIKA_ZEROPS_*` with legacy aliases → `389dabe`.

### F10 — the post-login return URL lost its scheme ⚠ fixed

`loginUrl` built the redirect from `request.url`, which behind the TLS-terminating
balancer is `http://`. Sign-in died on a deployment whose health checks, JWKS and
admin page were all green — the exact failure mode the runbook warns about.
→ `d1b612d`.

### F11 — one listener is one public hostname ⚠ fixed

Routing is by Host and two apps may not share one. On the subdomain path Zerops
mints one hostname per HTTP **port**, so the listener count caps how many public
hosts an installation can serve. Three platform hosts left no room for an
application. → `5ba87d1`, `4e7ba49`.

### F12 — the proxy's own redirect still carries `http://` ✗ open

Third instance of F10's root cause, in `packages/proxy`. `readForwardedRequest`
trusts `X-Forwarded-Proto`, which Caddy overwrites with the scheme **it** received
(plain HTTP from the balancer), so the `redirect=` parameter is `http://`. The
login origin itself is correct once the proxy's `FABRIKA_IAM_URL` is the public one.

Not fixed here because both candidate fixes have a cost worth choosing deliberately:
preserving the balancer's header in the generated Caddy config regresses the local
stack (where the browser talks to Caddy directly and there is no upstream header),
and giving the proxy an explicit public scheme adds manifest configuration.
→ [`backlog/48`](../backlog/48-decide-how-the-proxy-learns-its-public-scheme.md).

## Limits of the light tier, discovered by running it

- **Browser SSO needs custom domains.** The session cookie is host-only and the
  design shares it across IAM and the console via `SESSION_COOKIE_DOMAIN` (the local
  stack sets `fabrika.localhost`). Three sibling `*.prg1.zerops.app` hostnames have
  no safe common parent — setting one there would hand the platform session to every
  other Zerops customer's app. Machine surfaces are unaffected.
- **The namespace lifecycle wants a real public repository.** Adopting the existing
  project as a namespace succeeds, but reconcile triggers a proxy build from
  `proxyBuildFromGit` and `contember/fabrika-platform` does not exist publicly, so
  the namespace stays `failed`. Same git blocker as `trigger-deploy` (F5), one step
  earlier.

## Work units

| WU | Task                                             | State                                 |
| -- | ------------------------------------------------ | ------------------------------------- |
| 1  | Verify env-API reference resolution              | done — F1, F2, F3                     |
| 2  | Light tier in `topology.ts` / `setups.ts`        | done — `0eed4da`                      |
| 3  | Regenerate artifacts, fix the suite              | done — 1577 tests, real Postgres + S3 |
| 4  | Provision the light platform into `fabrika-test` | done — F7 fixed on the way            |
| 5  | Deploy iam → operations → control → proxy        | done — F8, F9 fixed on the way        |
| 6  | Verify the proxy enforcement boundary            | done — boundary correct, F10 fixed    |
| 7  | Deploy and exercise the example app              | done for gates; control-triggered out |
| 8  | Fold findings back, close backlog items          | done                                  |

## Out of scope

- The second (apps) project and the cross-project IAM hop — ADR-0006, deferred by decision 3.
- Custom domains; the throwaway path uses `.zerops.app` subdomains.
- HA anything. The production topology stays as committed; the light tier is additive.
- Git-triggered deploys and the control-plane `trigger-deploy` step (F5).
- End-to-end Operations ingest: the DSN comes from the control→Operations catalog
  projection, which needs the namespace reconcile, which needs the git source above.
  The app received a well-formed DSN by hand so it could boot.

## Run log

- Probe and `db` imported into `fabrika-test`. The probe stayed up as a live oracle
  for the semantic questions and is deleted at close.
- `startWithoutCode: true` still creates an app version and runs a `stack.deploy`
  process with `configContent: run.base` only — worth remembering when reading
  process lists.
- `zz apply` reports `drift:type` for `alpine/bun@1.3` vs a running `alpine/bun@1.3.9`.
  That is alias-vs-resolved, not real drift.
- The control plane's Zerops credential is a project-scoped INTEGRATION token
  (`fabrika-control-fabrika-test`, client role `NO_ACCESS`, `ADMIN` on the one
  project), never a personal access token. Revoke with
  `zz api deleteIntegrationToken --param id=<clientId> --param tokenId=0yA1GErQSDuL5QoNR5zU6g`.
