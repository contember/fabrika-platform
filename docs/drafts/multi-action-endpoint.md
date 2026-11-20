# Design draft: one endpoint for several actions

**TLDR.**

- Today an endpoint admits exactly one action, and its handler cannot see the caller's other actions. A screen that
  several roles read with different reach becomes one endpoint per action with the same output, and the SPA picks and
  merges them.
- Proposal: `access: { anyOf: [...], app: true }`. The proxy admits a caller that holds any listed action. The handler
  reads `ctx.holds(action)`, and `ctx.db.app` reaches what the union of the held listed actions reaches.
- This adds a requirement form to the proxy's one decision, not a second decision. It is a new manifest row form, so it
  follows ADR-0062's order: the platform release ships first.
- Cost: about 9–13 h of agent time plus one review round. The scoped forms (`on`, `in`, `over`) are left for a second
  step.

## Problem

An endpoint declares one action (`access: { action, app: true }`, or `on`/`in`/`over` one dimension). `ctx.principal`
is `{ kind, id, label, email }`: it carries none of the caller's actions. So a handler cannot answer "may this caller
also approve it" or "how far does this caller see". A screen read by several roles needs one endpoint per role's
action. The SPA asks each one the caller's actions allow (from `__fabrika-me.json`) and merges the answers.

Measured on a large consumer application (Cloudflare, about 120 k lines of business backend), 2026-11-20:

| Fact                                                     | Value                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| Endpoint declarations (`access: {` in `endpoints.ts`)    | 1,121                                                               |
| Of them `app: true`                                      | 1,119 (no `on`, no `in`, 1 `over`, no `capabilities`)               |
| Distinct actions named by endpoints                      | 244                                                                 |
| API methods the SPA's wire layer exposes                 | about 750 (reported by the consumer, not re-measured)               |
| First migrated wave                                      | 310 endpoints with 78 distinct outputs (reported)                   |
| Repeated output schemas in that wave's contract          | about 0.8 MB of 2.03 MB (reported)                                  |
| Worst screen                                             | one detail view issues up to 6 requests (reported)                  |
| Worst save                                               | split into up to 4 mutations that do not commit together (reported) |
| Client code that picks endpoints by the caller's actions | 5,230 lines (from the analysis, not re-measured)                    |

Two costs follow. The contract grows with every repeated output, which brings it closer to the reader's budgets (see
[contract-from-build-output.md](./contract-from-build-output.md)). And a save that one role performs in several steps
loses atomicity: the transaction is per invocation, and the work is now spread over several invocations.

## Design

### The declaration

```ts src/cash/endpoints.ts
export const cash = app.group({ callers: ['human'] }, (r) => ({
	detail: r.query({
		input: z.strictObject({ deskId: z.string() }),
		output: CashDeskDetail,
		access: { anyOf: ['cash.read', 'cash.audit', 'cash.manage'], app: true },
	}).handle(async ({ input, ctx }) => {
		const desk = await ctx.db.app.cash_desks.get(input.deskId)
		return {
			...fromRow(CashDeskRow, desk),
			canClose: ctx.holds('cash.manage'),
			audit: ctx.holds('cash.audit') ? await auditTrail(ctx, input.deskId) : null,
		}
	}),
}))
```

Rules:

- `anyOf` lists 2 to 16 distinct actions of the vocabulary. The artifact stores them sorted, so the order in the source
  does not change the digest.
- v1 takes `anyOf` only with `app: true`. That covers 1,119 of the consumer's 1,121 endpoints. The scoped forms are a
  second step ("Open questions").
- `anyOf` excludes `capabilities`, `creates`, membership management (`members.manage`, `members.list`), `issues`,
  delegation, link procedures, exports and public procedures. Each of these is tied to one action today, and none is
  needed by the measured use.

### What the proxy checks

The row carries a new requirement kind in `@fabrika/auth-core`:

```ts
interface AnyOfRequirement {
	readonly kind: 'anyOf'
	readonly actions: readonly [string, string, ...string[]]
	readonly access: { readonly form: 'app' }
}
```

`satisfies` admits a token that holds at least one listed action as a global grant. This is the `app` form's rule,
applied to each action. The row digest covers the kind and the list, so `X-Fabrika-Endpoint` still proves that the
proxy and the application applied the same rules. The framework repeats the check as authorization (ADR-0012 §5,
step 4), as it does for every requirement.

### What the handler gets

- **`ctx.app`** carries the held set H: the listed actions the verified token holds as global grants. H is never empty,
  because the requirement admitted the request.
- **`ctx.db.app` reaches what the union of H reaches.** A table operation is allowed when its action list shares an
  action with H. A column read or write action is allowed when H holds it. A table's `when` keyed by an action applies
  as an OR over H: a row passes when any held action's condition admits it, and a held action without a condition
  admits every row. This is the semantics of one role that holds those actions.
- **`ctx.holds(action)`** answers whether the verified token holds `action` as a global grant. It takes any action of
  the vocabulary, not only the listed ones, and it exists on every credentialed RPC procedure, single-action ones
  included. That also covers flags such as "may write training records" on a single-action endpoint. It reads the
  token the request already carries and asks IAM nothing. It grants nothing: `ctx.db` is built from the endpoint's
  capability, never from `holds`. It is information, like the caller document, and an `if` on it is the application's
  own authorization (ADR-0022 rule 5: "An app owns the check an endpoint row cannot make").

A save that one role performed as four mutations becomes one `anyOf` mutation with one transaction. Each write is
allowed by whichever held action the table names.

### What the approval shows

- A new `anyOf` endpoint reads: "callers holding any of `cash.read`, `cash.audit`, `cash.manage` globally".
- `action: 'a'` becoming `anyOf: ['a', 'b']`, and an action added to the list, widen by the added actions. An action
  removed from the list narrows.
- The removal comparison (ADR-0050 §3) is total over `EndpointRow`, so the new kind fails Control's typecheck until the
  comparison decides it. The rule: `anyOf` admits a superset of `action` exactly when it lists that action, and of
  another `anyOf` exactly when its list contains the other's.
- `ctx.holds` does not appear: it is not in the contract and grants no reach.

None of these lines needs closer review unless the endpoint also declares a step off the road, so a merge of endpoints
publishes on a protected environment without waiting.

### What it does not change

- **The proxy stays the only enforcement point.** `anyOf` is a requirement form the proxy evaluates in its one decision,
  with `planEndpoint` and `satisfies`. `ctx.holds` is authorization. The analysis called the whole change
  "authorization, not enforcement". That is right for `ctx.holds`. The `anyOf` requirement is part of the enforcement
  decision itself, and that is why it needs a proxy that reads it.
- The caller document, IAM's schema and the token format do not change.

### Alternatives considered

- **The proxy checks `member` and the framework checks `anyOf`.** No protocol change, but the proxy would then admit
  any member to the handler. ADR-0022's Context says it outright: "If only the application checks them, the check sits
  inside the process an agent can edit." Rejected.
- **`ctx.holds` alone, without `anyOf`.** Fixes the flags and costs about 2 h, but every screen still needs one
  endpoint per admitting action. It is a subset of this design and can ship first.
- **`capabilities` with the `app` form.** It needs every action (all-of), which is the opposite of what the screens
  need.
- **Writes name their action (`ctx.db.app.as('cash.manage')`).** More precise attribution, but every write site
  changes. The union matches what a role already means. Left open in case approvers want per-write attribution.

## ADR text changes

**ADR-0012 §10** gets a third bullet:

> - **`access: { anyOf: ['<action>', …], app: true }`** admits a caller that holds any of two to sixteen actions as a
>   global grant. The proxy checks it as one requirement. The handler's `ctx.app` holds the listed actions the caller
>   holds, and `ctx.db.app` reaches what any of them reaches: a table operation, a column and a `when` condition each
>   admit the request when one held action admits it. An `anyOf` endpoint has no members, links or delegation, and
>   takes no `capabilities` or `creates`. The scoped forms do not take `anyOf`.

**ADR-0012 §5, step 4** becomes: "Check the endpoint's requirement: `member` (any permission of this application), the
action in some scope, for the `app` form the action held as a global grant, for `anyOf` one of its actions held as a
global grant, and for `capabilities` each of its actions."

**ADR-0012 §2**, after the bullet on capabilities:

> - `ctx.holds(action)` answers whether the caller's verified token holds an action of the vocabulary as a global
>   grant. It is information for the handler's own authorization; it grants no reach and asks IAM nothing.

**ADR-0022 rule 3, step 5**: after "for the `app` access form the action held as a global grant" insert "for `anyOf`
any one of its actions held as a global grant".

**ADR-0022, Consequences**, "A new row form needs a proxy that reads it": add "an `anyOf` requirement" to the list.

**ADR-0050 §3**, the endpoint bullet: "An `anyOf` requirement is compared by action: an action the list gains widens,
one it loses narrows; `action` → `anyOf` widens by the actions added."

`docs/reference/overview.md` needs no change: the vocabulary (enforcement, authorization, admission) holds as it is.

## Protocol and rollout

- **Manifest rows** are platform protocol (ADR-0062). The new requirement kind is additive: an older proxy's strict
  parser refuses the row instead of serving it without the check. A Zerops namespace pinned to an older proxy source
  therefore refuses the deploy of an application that uses `anyOf`, with one line, until the operator re-pins it to
  `--proxy-source=current`. The Cloudflare proxy Worker is redeployed by the platform's own release.
- **Order**: the platform release that parses and checks `anyOf` ships first; the framework release that emits it
  follows. Control's bundled older parsers (0.4.8, 0.5.5, 0.6.0) refuse the row, which is the intended refusal.
- **Rollout path of an existing installation.** No generated installation file, environment variable or provider
  state changes. Control, the proxy and IAM upgrade with the platform release. An application meets the form only
  when it raises its own pin and declares it.

## Migration for existing applications

- Nothing changes until an application declares `anyOf`. `action` keeps working.
- Merging N endpoints into one gives a new path. The old endpoints' removal narrows and the new one widens, with no
  closer-review line, so it publishes without a park. A mount with `compatibility: 'backward'` keeps the old procedures
  until its clients move, because its promise holds the publication to them.
- For the large consumer the analysis estimates 1,121 → about 755 endpoints, one per client API method, and the first
  wave's 310 endpoints → about 80. Both are estimates: an equal output does not prove that the endpoints merge. The
  client adapters that pick endpoints by the caller's actions shrink with them.

## Cost to build

| Part                                                                                              | Agent time |
| ------------------------------------------------------------------------------------------------- | ---------- |
| `auth-core`: the requirement kind, `satisfies`, the digest, the artifact parser                   | 1–2 h      |
| `proxy-core`: the manifest parser and its tests; the older-parser refusal path                    | 1 h        |
| `@fabrika/app`: the builder and types (`anyOf` literal tuple, `ctx.holds`), `buildArtifact`, boot | 3–4 h      |
| `@fabrika/db`: the `app` grant with an action set; the union over operations, columns and `when`  | 2–3 h      |
| Control: the diff and removal comparison                                                          | 1–2 h      |
| Static reader (if it is still the reader), skill and references                                   | 1 h        |
| **Total**                                                                                         | **9–13 h** |

Add one review round and the platform release before the framework release. Shipping `ctx.holds` alone first costs
about 2 h of that.

## Open questions

- **Scoped forms.** `anyOf` with `on`, `in` or `over` needs a `Ref`/`Within` keyed by an action set. It must also
  settle `on`'s 404 when the caller holds a listed action on the object and another one only in an unrelated scope. No
  measured application needs it today.
- **A scoped `ctx.holds(action, scope)`.** It is easy to add, but `can()` over an object resolved from request data is
  the application's own check today. Add it only when a dimension application asks for it.
- **The list limit.** Sixteen is a guess that keeps the row small. The consumer's widest merge has not been measured.
