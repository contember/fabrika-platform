# Security alerts in Operations

A security review asked that the platform alert on signals IAM records but never raised: a series of refused sign-ins
and a privileged sign-in. (The third signal it named, an application service that became reachable past its proxy, is
a separate change that reports to the application's own ingest project as a `new_issue`.) This spec records the decided
design and how it is built.

## TLDR

- **Pull.** Operations' minute maintenance pass asks IAM for one bounded summary, `signInSignals({ since, until })`,
  over the IAM channel it already holds. Only IAM's full entrypoint serves it, never `PropustkaApplication`.
- **A `security` alert kind on an installation source.** Operations creates one source of the installation itself
  (`origin = 'installation'`); only an app-scoped grant at IAM's app id or a global grant reaches it.
- **Privileged sign-in** is the existing `auth_log.privileged = 1` on an `allow` row at IAM: one alert each.
- **Thresholds** live on the installation source: 5 refusals per account and 50 installation-wide in 15 minutes by
  default, each alerting at most once an hour.
- No new credential, binding, environment variable, cron or generated file. Alerts stay silent until an operator adds a
  `security` rule and channel.

## Decisions

| Question           | Decided                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Boundary           | B, pull by Operations. Push from IAM needed a new cron, binding and credential; a shared table breaks ADR-0017. |
| Where, which kind  | A new `security` kind on a new installation source. Synthetic `new_issue`s would inherit triage and its caps.   |
| Privileged sign-in | The existing flag: installation and user administrators.                                                        |
| Thresholds         | Per installation, on the source, like the spike threshold.                                                      |

## Design

### IAM: `signInSignals`

`IamSignInSignalsRpc` (`packages/auth-core/src/rpc.ts`) is a contract of its own beside `IamRpc`, so the application
entrypoint cannot grow it by accident. The default `Propustka` class and the management `/rpc/*` serve it;
`index.test.ts` pins that `PropustkaApplication` does not.

The input is a window by `created_at` in unix seconds, both ends inclusive, at most a day. Reading by `created_at` with
an overlap, never `id > cursor`, because the Postgres identity is not commit-ordered. The answer
(`packages/iam/src/sign-in-signals.ts`, `AuditRepository.signInSignals`):

- `accounts`: refused password sign-ins per known `principal_id`, at IAM;
- `refusals` and `reasons`: every counted refusal, in total and by reason;
- `privileged`: the `allow` rows at IAM with `privileged = 1` (id, principal, reason, time);
- `truncated`: a list passed its limit of 500.

**Which refusals count** is an allow-list typed over `LoginRefusal` (`COUNTED_LOGIN_REFUSALS`), so a new reason fails
the typecheck until it is decided:

| Reason                                                                                                                                        | Counts in                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `password_invalid`, `password_throttled`                                                                                                      | the account (known principal) and the installation |
| `second_factor_invalid`, `second_factor_throttled`                                                                                            | the installation                                   |
| `invalid_key` (a refused or revoked `px_` key, any app)                                                                                       | the installation                                   |
| everything else (`login_cross_origin`, `password_malformed`, `handoff_refused`, `oidc_*`, `terminal_assertion_*`, application token refusals) | nowhere: not a credential guess at IAM             |

IAM migration 0043 indexes `auth_log(created_at)`, so the per-minute read does not scan the retention period.

### Operations: the installation source and the producer

- **The source** (`packages/operations/src/installation-source.ts`): IAM's app id, environment `_installation`,
  service `default`. The leading underscore is outside the catalog's coordinate pattern, so Control can never project a
  source onto it; the catalog upsert and `getByCoordinate` touch only `origin = 'control'` rows anyway. The maintenance
  pass creates it (`SecurityAlertsRepository.ensureInstallationSource`).
- **Access** (`src/access.ts`): for this source only the app-scoped check applies. An environment-scoped grant, even on
  an environment of the same name, never reaches it.
- **The producer** (`src/security-alerts.ts`) runs in each maintenance pass before the outbox claim:
  1. Without an enabled `security` rule and channel on the source it asks nothing and clears its mark, so enabling
     later raises nothing for the time before.
  2. Without IAM it skips and says so once per process.
  3. It asks IAM for the window from its mark minus 15 minutes to now, capped at the last day.
  4. When IAM does not answer or lacks the method, it logs one line (no error object, no key) and keeps the mark.
  5. It raises the alerts below, then moves the mark forward.
- **Alerts**, each enqueued per enabled `security` channel through the existing outbox:

  | Signal                  | Fires when                                   | Repeat                                                       |
  | ----------------------- | -------------------------------------------- | ------------------------------------------------------------ |
  | `account_refusals`      | one account reaches the account threshold    | a one-hour claim per account; dedup key per account and hour |
  | `installation_refusals` | the total reaches the installation threshold | a one-hour claim; dedup key per hour                         |
  | `privileged_sign_in`    | each privileged `allow` row                  | dedup key per `auth_log` id                                  |

  Overlapping windows therefore alert once. Payloads carry principal ids, counts, thresholds, reasons and times; never
  an email, an address or a credential.
- **Priority**: the outbox claims `security` with the health kinds, ahead of issue alerts.
- **Storage** (migration 0002, both dialects): `security_alert_config` (the thresholds) and the one-row
  `security_signal_cursor` (the mark).
- **Wiring.** Cloudflare passes the existing `IAM` service binding, decoded once by `decodeSignInSignals`
  (`src/platform-cf.ts`). Bun builds one `HttpIamRpc` per process from `FABRIKA_IAM_RPC_URL` / `FABRIKA_IAM_RPC_KEY` and
  shares it with token verification (`src/node/runtime.ts`).

### Console and API

`alerts` answers `security` thresholds for the installation source (defaults when unset) and `null` elsewhere;
`updateSecurityAlert` sets them (positive integers up to 1,000,000) and refuses an application source. The alert routing
page of the installation source shows the thresholds and offers only the `security` kind.

## Rollout of an existing installation

IAM's migration 0043 and Operations' migration 0002 run with each service's deploy. The first maintenance pass after
the Operations deploy creates the installation source. Nothing in the environment, the Zerops crontab, `zerops.yaml`,
the import YAMLs or the Cloudflare bindings changes. An Operations upgraded before IAM logs one line per pass while
configured and catches up from its mark (up to a day) once IAM serves the method.

## Tests

- IAM: the allow-list itself; the summary on SQLite and Postgres (filtered reasons, account counts, privileged rows,
  the window refused); a refused `px_` key through `mintFromKey` counted; the entrypoint member lists; the `/rpc/*`
  dispatch; the HTTP client's decoding, including a 404 from an older IAM.
- Operations: 5 refusals for one account enqueue one alert and an overlapping pass none; thresholds; installation-wide;
  privileged once; IAM unavailable leaves the mark; an off-contract binding answer; unconfigured asks nothing; the
  catalog reconcile leaves the source alone; delivery priority; access and the operator API for the installation
  source; the security repository on Postgres.

## Not verified

- The Cloudflare service binding against an IAM that predates the method (expected to reject the call, which skips).
- The minute pass budget on Cloudflare with one more RPC.
- A live Zerops installation.
- Whether a second-factor completion keeps the original `reason` on its `allow` row (the payload carries what IAM wrote).

## Related

- [Backlog 278](../backlog/278-control-alerts-when-iam-or-operations-is-down.md) needs an installation source for IAM's
  health check; this source is it.
