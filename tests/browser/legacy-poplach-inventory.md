# Legacy Poplach browser scenario inventory

This inventory maps the browser scenarios in
`~/projects/oss/poplach/tests/browser` at 2026-07-31 to the Fabrika Operations
adoption proof. The source suite is evidence to account for. It is not copied
into Fabrika because its standalone project, identity, and storage model no
longer matches the platform composition.

| Legacy scenario                                          | Disposition | Fabrika witness or reason                                                                                                                                                                                                     |
| -------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_smoke.test.ts`                                         | Covered     | `three-plane-navigation.test.ts` proves the authenticated unified shell and Operations overview.                                                                                                                              |
| `alerts-disabled.test.ts`                                | Covered     | `operations-alert-routing.test.ts` persists spike enable/disable state. Alert delivery behavior remains a domain and local-stack concern rather than a UI assertion.                                                          |
| `dsn-roundtrip.test.ts`                                  | Obsolete    | Operators no longer create standalone Poplach projects or DSNs. Delivery projects managed source coordinates and credentials into Operations. WU5 proves the managed DSN with the official browser SDK.                       |
| `email-channel.test.ts`                                  | Deferred    | Fabrika Operations currently supports webhook channels only. Email delivery is outside this adoption sprint.                                                                                                                  |
| `ingest-and-group.test.ts`                               | Kernel/WU5  | WU5 sends a managed error with the official `@sentry/browser` SDK and proves grouping. Browser operators do not hand-build envelopes.                                                                                         |
| `ingest-validation.test.ts`                              | Kernel/WU5  | Ingest authentication and malformed-envelope behavior belong to Operations HTTP tests and the narrowed WU5 SDK compatibility witness.                                                                                         |
| `issue-ignore.test.ts`                                   | Covered     | `operations-issue-triage.test.ts` persists ignored state and retained activity for a scenario-owned issue.                                                                                                                    |
| `issue-tracking-extras.test.ts` — SDK fingerprint        | Kernel/WU5  | Official-SDK grouping replaces the hand-built fingerprint browser setup.                                                                                                                                                      |
| `issue-tracking-extras.test.ts` — comment and assignment | Covered     | `operations-issue-triage.test.ts` uses a real IAM principal and persists both actions.                                                                                                                                        |
| `issue-tracking-extras.test.ts` — merge                  | Covered     | `operations-bulk-status-and-merge.test.ts` merges scenario-owned issues and verifies the persisted list result.                                                                                                               |
| `member-access.test.ts`                                  | Covered     | `operations-error-discovery.test.ts` uses an application-scoped IAM session and asserts that its hidden sibling cannot be inferred.                                                                                           |
| `not-found.test.ts`                                      | Deferred    | Graceful unknown issue deep links remain useful, but they are not an adoption-critical operator workflow in this sprint. Router and RPC tests retain the contract.                                                            |
| `project-setup.test.ts`                                  | Obsolete    | The source catalog and ingest credentials are projected from Delivery. Operations has no independent project-creation workflow.                                                                                               |
| `resource-routes.test.ts`                                | Kernel/WU5  | Envelope and source-map method/parameter contracts are non-UI HTTP behavior covered below the browser workflow layer.                                                                                                         |
| `sign-in.test.ts`                                        | Covered     | The Fabrika harness creates real IAM sessions. Scoped visibility is covered by `operations-error-discovery.test.ts`; the harness separately verifies an anonymous gateway login response. External OIDC remains out of scope. |
| `source-maps.test.ts`                                    | Covered     | `operations-event-release-correlation.test.ts` verifies a resolved source frame, retained event context, and its projected release.                                                                                           |
| `spike-alert.test.ts`                                    | Covered     | `operations-alert-routing.test.ts` proves spike/rule configuration and webhook lifecycle. Scheduled detection and delivery deduplication remain covered by Operations service tests.                                          |
| `triage-issues.test.ts`                                  | Covered     | Discovery, detail, status, activity, assignment, snooze, release context, and persisted mutations are split across the discovery, triage, bulk/merge, and correlation scenarios.                                              |

## Stable Fabrika fixture vocabulary

- `operations-browser-fixtures` projects `Browser Notes / test` and the hidden
  sibling `Hidden sibling / secret`.
- `Browser fixture primary failure` has two occurrences, source-map context,
  and a projected release.
- `Browser fixture merge candidate` provides a second visible issue, but
  mutation scenarios create their own uniquely marked issues to remain
  independently runnable.
- The visible source starts with an enabled `/healthz` check, spike threshold
  `25`, enabled new-issue alerts, and a disabled webhook whose destination is
  returned only in redacted form.
- `local-stack` provides the real Control, IAM, Operations, PostgreSQL, MinIO,
  proxy, and example-application composition.
