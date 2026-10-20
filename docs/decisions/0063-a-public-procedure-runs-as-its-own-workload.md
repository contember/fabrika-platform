---
id: 0063
title: A public procedure runs as its own workload
status: accepted
date: 2026-10-20
---

# 0063 — A public procedure runs as its own workload

## Context

Every request that touches application data runs a handler, with its caller's capabilities or as a declared workload
([ADR-0012](0012-fabrika-app-runtime.md) §9). A visitor without an account has no capabilities: the proxy forwards no
credential to an anonymous kind ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3).

Framework 0.5 let anonymous traffic write data through one kind, `c.form`. A form appended its input to an inbox table
and answered a constant, with no handler. Everything a form needed beyond that became a new option with its own
runtime (files, a hold, a sweep path). An anonymous read, a click counter, an unsubscribe link and a consent record
with the client's address had no road at all.

A handler that anyone may call needs authority from somewhere, and that authority must be:

- **declared**, so the approver sees what anyone may cause;
- **bounded**, so a bug in code anyone can call reaches little;
- **revocable**, so removing the declaration removes the authority;
- **the same mint path** as every other capability, so there is no second issuer to audit.

Jobs and webhooks already hold authority without a person: Control issues a workload key per declaration, IAM signs a
token with exactly the declared actions, and the runtime mints capabilities from it (ADR-0022, "Principal kinds").

## Decision

**A procedure declares `access: { public: true }` and top-level `actions`. Anyone may call it; its handler runs as the
endpoint's own workload, of the workload kind `public`, and holds those actions only. The data layer narrows what the
workload may do with them.**

```ts
const intake = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['intake.register'],
		admission: {
			challenge: {
				provider: 'turnstile',
				secret: 'TURNSTILE_SECRET',
				siteKey: 'TURNSTILE_SITE_KEY',
			},
		},
		kicks: ['intake'],
	}).handle(async ({ input, ctx }) => {
		if (honeypot(input.website)) return {}
		await ctx.db.app('intake.register').submissions.insert(
			submissionOf(input, ctx.client),
		)
		ctx.kick('intake')
		return {}
	}),
}))
```

### 1. Who calls versus what the code reaches

- `access: { public: true }` says anyone may call. Top-level `actions` say what the handler may do, as on a job and a
  webhook. The approval keeps the two apart: "for anyone, without signing in", beside the actions it runs with
  ([ADR-0050](0050-approved-access.md)).
- Public access is an access form of an RPC procedure, not a kind. A link procedure and an export procedure cannot be
  public.
- A group's `callers` applies to its credentialed procedures. A group whose procedures are all public declares none:
  `app.group({}, (r) => …)`. A mount's callers are those of its credentialed groups, `[]` when every group is public.
- A public procedure takes only `kicks` and `signs` of the declared reach. `sql`, `unscoped`, `connect`, `issues`,
  `binds`, `egress` and `mailer` are refused by the build.

### 2. The workload

1. `schemaFromContract` adds `{ kind: 'public', name: '<endpoint id>', actions }` to the IAM schema's workloads. The
   name is the full endpoint id (`<mount>.<group>.<procedure>`), so one group mounted twice is two workloads and never
   merges their authority.
2. IAM accepts the kind in the schema reconcile, the key operations and the workload token exchange. A public workload
   needs at least one action, and the schema reconcile refuses a public action that any application role grants, so a
   role change cannot widen it unseen. A table that staff and a public procedure both read names both actions
   (`actions: { read: ['crm.read', 'catalog.read'] }`).
3. Control issues one key per public procedure of the approved contract, as it does per job and per webhook, and
   writes it as `FABRIKA_PROCEDURE_<ID>_<8 hex of the id's SHA-256>_KEY`. The readable part alone would collide for
   ids that differ by case, `_` or `.`, and `FABRIKA_PUBLIC_*` already names an application's public build values.
   Deploys reconcile, rotate and revoke the family like job and webhook keys.
4. `boot` exchanges the key at IAM's workload token path, verifies `ptype: 'public'` and the workload name, and caches
   the token until shortly before it expires. A flood costs IAM one exchange per token lifetime. An expired token with
   IAM down answers 503, as a webhook does.
5. `callerOf` maps the token to no caller. IAM refuses every membership, link and admin operation for it.
6. The handler mints `ctx.app('<action>')` only for a declared action the token carries, bound to the request, and
   `ctx.db.app('<action>')` is the data layer over it.

### 3. The data layer bounds the reach

- A public site reaches application tables only (`scope: { app: … }`), never a dimension or child table.
- A read needs the table's `read` action. The approval lists the columns that action reads.
- An insert answers only the new key and reads nothing back. The handler knows the id, because ids are generated
  caller-side. A file field of the input goes into a file column of that insert
  ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)). `onConflict` takes `'nothing'` only.
- An update or a delete needs its action and takes only a row id that a verified signed token of this request carries,
  with `expectVersion`, on a versioned table. An update answers only the new version. That is how a public link
  manages one booking: the token names the booking (ADR-0012 §14).
- No lock (`getForUpdate`) and no `claim`.

### 4. The row and the order of a request

- A public procedure compiles to its own anonymous row kind, `public`: no callers, no requirement, no delegation, and
  every credential discarded. An older proxy's strict manifest parser refuses the kind instead of serving it without
  the admission rules (ADR-0022 rule 3).
- The proxy admits its body codec and applies the browser admission matrix (ADR-0022, "Cross-origin endpoints").

The application then takes a public request in this order, each refusal with its answer:

1. The in-flight share: all public procedures of one process hold at most a quarter of its database connections
   (`FABRIKA_APP_DATABASE_CONNECTIONS`, 10 by default). The next public call answers 503, and signed-in staff keep the
   rest.
2. Every bucket the procedure has (`perClient`, `perEndpoint`, `bytesPerHour`), each charged before the body is read
   and kept whatever follows (429). A public mutation counts 10 per client and 100 for the endpoint per minute unless
   it declares its own; a public query has no bucket unless it declares one, because a bucket is a database write per
   call (ADR-0012 §11).
3. The bounded body and the strict input, signed tokens verified as the input is parsed (413, 400).
4. The workload token, before the challenge spends a token (503).
5. The challenge (400 `challenge_failed`, as a 0.5 form answered). Its token arrives as the input field
   `challengeToken`; the provider's action is the procedure's `challenge.action`, by default the endpoint id with `_`
   for `.`. Every SPA mount's browser config serves the site key, never the secret, and `boot` refuses to start
   without the variable.
6. The file parts, staged as pending files (ADR-0061).
7. The handler in one transaction, the output, the commit, and the kicks
   ([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)).

### 5. The request context and helpers

- `ctx.client` is `{ ip, userAgent }` on every request context. `ip` is the address the proxy sets, where the runtime
  vouches for it (Cloudflare, the test kit), and `null` on Bun and Zerops until the balancer's range is trusted
  ([backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md)). `userAgent` is cut to a bounded length. Both are
  information, never a check.
- `honeypot(value)` from `@fabrika/app` is a handler helper: `if (honeypot(input.website)) return {}` answers what a
  real submission answers and does nothing.
- A public handler should do constant work: the same for a new and a known visitor, so neither its answer nor its work
  tells one from the other. The recipe keeps a submission table that a job drains.

### 6. Tests

- The endpoint access kit asks a public procedure as anyone (`kit.anyone(endpoint, input)`), with no credential, from a
  page of its own origin.
- `fabrika db test-scaffold` writes one case per public procedure: anyone reaches it, or, behind a challenge, is refused
  without a solved one.

## Consequences

- Anonymous entry is an ordinary procedure: a form with files, a public read, a public image, a click counter, an
  unsubscribe link, consent evidence with the client's address.
- Removing a public procedure from the contract revokes its key at the next deploy. Its authority cannot outlive the
  declaration.
- **Review.** Every public procedure is a widening with closer review, and so is every action it gains, every kick
  edge it gains, and every bucket it raises or turns off. The approval shows each procedure's effective buckets,
  challenge, time limit and body limit.
- **Flood cost** is bounded by the client bucket before the body, the in-flight share, the bounded body, the handler's
  time limit, the endpoint bucket, the byte budget, the challenge for files, the cached workload token and coalesced
  kicks. On Zerops the client bucket counts one client until backlog 05, and the approval says so.
- Each bucket is charged with its own statement, not in one admission transaction, and the in-flight share is counted
  per process.
- A public procedure does not reach a dimension or child table. Work on records goes through a submission table and a
  job, which holds its own actions.
- A custom IAM policy is not checked against public actions; only the schema's roles are.
- **Rollout.** IAM must know the workload kind (its migration 0020) and Control must issue its keys (its migration
  0011) before an application declares a public procedure, so `fabrika platform upgrade` comes first. On Zerops a
  namespace's proxy pin must read the `public` row. Control refuses a deploy whose contract holds a row no older
  release's proxy parses, a public row among them, while the namespace's proxy source is another than the one it
  deploys new placements from, and names the re-pin (`fabrika control namespaces update --namespace=<id> --proxy-source=current`). No generated
  installation file changes. A 0.4, 0.5 or 0.6 application has no public row, so nothing changes for it.

## Alternatives considered

- **An in-process mint from the artifact, IAM off the public path.** A second mint path, and removing a declaration
  would revoke nothing that was already minted.
- **A table policy "insert for anyone".** Cannot carry a richer handler: a consent record, a deduplicated unsubscribe,
  a redirect.
- **A separate builder for public procedures.** One more kind for what is an access form of an ordinary procedure.
- **`callers: ['anyone']` on a group.** Keeps `callers` literally true, but moves a per-endpoint permission away from
  the endpoint.
- **`{ public: true, actions }` in one object.** Mixes who calls with what the code reaches.
- **A `form` kind for public multipart.** A public click is JSON and a signed-in upload is multipart, so the name fits
  neither. The body codec follows the input and `http`.
- **Keep `c.form` as a declaration macro**, expanded identically by the builder and the reader. Keeps the inbox concept
  and hides the handler to save four lines.
- **`ack()` plus `admission.honeypot`**, the framework answering without the handler. An output type for one admission
  rule; a helper does the same inside the handler.
- **A per-site table and operation mask in the data session.** Stronger, but a second restriction system beside the
  table policies.
- **Let a role hold a public action.** A role change would widen the public reach unseen.
