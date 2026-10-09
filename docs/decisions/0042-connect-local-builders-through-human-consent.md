---
id: 0042
title: Connect local builders through human consent
status: accepted
date: 2026-10-08
---

# 0042 — Connect local builders through human consent

## Context

The builder owns local design artifacts, coding-agent guidance and a local review dashboard. An installed platform owns application identity, environments and deployment. Moving between them currently requires manual registration and separate operator commands.

Hosting coding agents would add workspace and agent-runtime operation before the application flow is proven. The current requirement is local coding with a continuous path into an administrator-prepared Zerops installation.

A local coding agent holds the builder key and edits every file of the project. It can widen the application's access surface as easily as it changes code ([ADR-0050](0050-approved-access.md)).

Existing IAM credentials can delegate app-scoped Control permissions to a separate service principal. They cannot be obtained by an unauthenticated local builder through the console's administrative API: that API requires IAM administration. A Control-only bootstrap override is also not authority that IAM can delegate. Application creation requires global `app.manage`, while subsequent application operations support app-scoped authority.

## Decision

We will keep the builder and coding agent local. The installed console will authenticate the person and obtain explicit consent to connect the local project to an application.

1. **The human creates or selects the application in the console.** Use the existing application registry operations. The administrator prepares namespaces, source connections and domains. The builder does not receive global application-creation or namespace-management authority.
2. **IAM owns a device-authorization transaction, separate from session handoff.** A daemon-only redemption proof and a separate browser approval proof bind the transaction. Browser login still uses the proxy and existing host-bound session handoff. No localhost origin is added to IAM's administrative trust registry.
3. **Approval delegates a separate machine identity.** IAM validates an active human and current permissions for the Control audience. The builder receives `app.manage`, `deploy.trigger` and `deploy.read` scoped to the selected application. Consent names the full breadth of `app.manage`, including deletion and all application environments. It does not imply an app-and-environment intersection.
4. **Consent freezes the authorization.** Exchange rechecks the approver's live authority and atomically consumes the approved attempt with creation of the service principal, grant and hash-only credential. A completed exchange never mints again. After a lost response, the original issuer can identify and revoke the issued credential before starting another attempt. Fresh permission resolution is required; this does not introduce serializable locking across all IAM policy mutations.
5. **Keys expire and remain revocable.** Attempts live at most ten minutes; issued keys live at most thirty days. The resulting service grant is independent of the human's subsequent session. Existing access-token TTL bounds still apply after revocation.
6. **Control owns deployment selection.** A typed, immutable, non-secret connection receipt records the application and initial environment selection. IAM receives no deployment manifest or provider placement payload. The scoped builder retrieves the receipt from the configured Control origin. A receipt records intent; it reserves no namespace resources or domain.
7. **The local daemon owns custody and deployment operations.** Store the key in a private user-level file outside project roots. Project metadata holds only non-secret coordinates. Admit local HTTP and WebSocket requests by authority and browser origin before dispatch. CLI and UI communicate with the daemon over HTTP; the daemon calls the existing Control RPC.
8. **Application code compiles locally in a separate process.** Do not pass the platform credential to the compiler, coding agent or browser. Use the provider compiler and existing Control environment/deploy operations. Compilation is not a claim to sandbox arbitrary code against other files owned by the local user.
9. **Deploy an explicit remotely available commit.** The builder does not commit or push application code. Repeat updates preserve current environment placement and never silently turn an application-create conflict into replacement. The run snapshots the access data it reads from that commit (ADR-0050). Other registry configuration is not snapshotted; this feature does not claim immutable manifest identity across concurrent registry changes.
10. **Uploads carry no proxy table and no IAM schema.** The builder's manifest describes resources only. Control reads the access surface from the deployed commit ([ADR-0005](0005-compile-app-config-to-static-manifest.md)).
11. **The builder key cannot approve.** It is a service principal, and only a human user principal with `access.approve` approves an access change (ADR-0050). Consent never delegates `access.approve`.

Item 11 is built: `approvals.complete` refuses every service principal, key and OAuth token (work unit B6).
Item 10 holds in effect, not yet in form: a contract application's upload may still carry its endpoint
table and IAM schema, but no provider publishes them; the access comes from the snapshot of the commit.
Dropping them from the upload is left to the build (A17).

**Invariant: browser consent never yields a human session, human access token, or platform administration secret to the local builder.** Only the daemon redeems its proof for the app-scoped machine key.

**Invariant: the configured installation origins cannot be replaced by repository metadata or credentialed HTTP redirects.** Reconnecting to another installation requires an explicit local action.

## Consequences

Application creation and subsequent changes share one identity without remote coding infrastructure. The first environment can be created after code exists, while the project can connect before its configuration is written. Control remains provider-neutral and retains sole ownership of deployment; IAM retains credential ownership.

There is a new credential-establishment protocol and durable state on both IAM and Control. Both database implementations must implement the same lifecycle. Lost-response recovery is explicit because IAM cannot retrieve a stored plaintext key. Consent and revocation need ordinary-user surfaces distinct from IAM administration.

A widening that the local agent deploys to a protected environment waits for a human in the dashboard. The builder can deploy it and report that it waits, but it cannot complete it.

Approvers need actual IAM-resolved Control grants. A human admitted only by Control's bootstrap override cannot delegate them. Namespace selection initially uses the human's existing namespace-management permission; the daemon never receives it.

Local user-level file permissions protect credentials from unrelated users, not arbitrary code running as the same operating-system user. The local application compiler is therefore isolated from credential-bearing process state, not advertised as a security sandbox.

## Alternatives considered

- **Remote coding-agent workspaces.** A coherent browser-only product, but it introduces an operational system the current local-first requirement explicitly avoids.
- **Manually transfer an operator key.** Smaller implementation, but it interrupts the intended flow and encourages broad credentials on developer machines. The user selected automatic browser pairing.
- **Give the daemon global creation and namespace authority.** Reuses existing global actions but unnecessarily broadens the machine identity. Human console creation followed by app-scoped delegation fits the existing authorization model.
- **Reuse the browser session handoff.** That protocol establishes host-bound browser sessions at the proxy. Giving its output to a daemon would violate the established custody boundary.
- **Let the builder key approve the changes it deploys.** Rejected: the local agent holds the key, so it could approve its own widening.
- **Keep the proxy table and the IAM schema in the uploaded manifest.** Rejected: the local build that writes the manifest is code the agent edits, so the platform would enforce the application's self-report.
- **Carry deployment metadata inside IAM's authorization object.** Couples identity to Control's provider placement. A typed Control receipt keeps ownership explicit without a generic opaque metadata channel.
