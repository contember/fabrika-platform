// The app's per-path gates: WHICH CREDENTIAL KIND each path requires.
//
// ── These are not enforced by this app ────────────────────────────────────────────────────────────
//
// They are enforced by the PROXY, in front of it. The app service has no public route at all, so a
// request that fails a gate never reaches this process — and neither does a request to a path the app
// forgot to protect. That structural unreachability is the whole reason the rules live outside the
// app. See
// https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md.
//
// The proxy reads this list VERBATIM from its manifest, order preserved, and evaluates it in the
// TypeScript auth service. It is never compiled into Caddy routes: fall-through is inexpressible as a
// matcher, Caddy's path matching is case-insensitive where these globs are case-sensitive, and Caddy's
// `*` stops at `/` where these do not. A second evaluator would therefore admit a different request
// set.
//
// ── Semantics ─────────────────────────────────────────────────────────────────────────────────────
//
//   - array order IS the precedence;
//   - a matching rule whose credential is ABSENT falls through to the next matching rule;
//   - a matching rule whose credential is PRESENT is terminal — valid allows, invalid denies;
//   - a request matching NO rule is DENIED. An empty list therefore seals the app, on purpose.
//
// Globs are case-SENSITIVE and `*` crosses `/`. `/Public/health` does not match `/public/*`.

import type { AppGates } from '@fabrika/auth-core'

export const notesGates: AppGates = {
	// Anonymous. `/public/*` is the app's own carve-out; `/healthz` is for the platform's health check,
	// which arrives with no credential and must not be a 401.
	rules: [
		{ path: '/public/*', kind: 'public' },
		{ path: '/healthz', kind: 'public' },
		// The interesting pair, and the reason fall-through exists. `/api/*` accepts EITHER a machine
		// credential (`Authorization: Bearer px_…`) OR a logged-in human. A request with no bearer falls
		// through from the first rule to the second and is handed a login redirect; a request WITH a bearer
		// stops at the first rule and is allowed or denied on that credential alone — it is never
		// silently downgraded to the human path.
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
		// Everything else is the browser UI: humans only.
		{ path: '/*', kind: 'human' },
	],
}
