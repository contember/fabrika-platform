// @fabrika/auth — the app-facing IAM SDK (the only package published to npm).
//
// Depends ONLY on @fabrika/auth-core: the binding is typed as the `IamRpc` contract (so the SDK
// never imports the IAM service), and `can()`/`scopedTo()` reuse core's `permits`/`matchAction`.
//
// Enforcement lives in @fabrika/proxy (ADR-0007). Nothing exported here can evaluate a gate.

export { IamClient } from './client'
export { FakeIamClient } from './fake'
export type { FakeIamConfig, FakePersona } from './fake'
export { applyScope } from './scope'
// The typed HTTP errors + the per-resource authorization helper a per-path gate cannot express.
export { ForbiddenError, requirePermission, UnauthenticatedError } from './errors'
export type { HttpError } from './errors'
// Request-time surface: the single `createIam` entry point (verification + share-link redemption +
// the management methods), the dev persona model (`makeDevContext`), and the anonymous context an app
// sets on a request the proxy admitted through a `public` gate.
export { anonymousContext, createIam, Iam, makeDevContext } from './iam'
export type { AuthFailure, AuthFailureReason, AuthResult, CreateIamOptions, IamEnv, PersonaSpec } from './iam'
// The shared middleware contract consumed by `@fabrika/app`. Owned here so an app pipeline needs no
// duplicate compatibility interface; the SDK itself no longer ships any middleware.
export type { AuthCarrier, Middleware } from './middleware'
// The HTTP transport for the SAME `IamRpc` contract, for a runtime with no Cloudflare service binding
// (a long-running Bun/Node process). Drops into anywhere a binding goes — `createIam`, `IamClient`,
// `env.IAM` — because the contract is unchanged and only the transport differs.
export { HttpIamRpc, IamTransportError } from './rpc-http'
export type { FetchLike, HttpIamRpcOptions } from './rpc-http'
// Local verification of the proxy-injected access token. `createIam` wires it for you; it is exported
// for an app that resolves a token outside the `Iam` surface.
export { TokenVerifier } from './verify'
export type { VerifyResult } from './verify'
// Deploy-time helper: reconcile an app's declared AppSchema (authz vocabulary) into IAM (an
// HTTP admin call, NOT over the service binding). Import from a deploy/provisioning step.
export { reconcileSchema, ReconcileSchemaError } from './provision'
export type { ReconcileSchemaOptions } from './provision'
export type {
	AuthContext,
	IssuedJwt,
	IssuedKey,
	IssueFailure,
	IssueJwtRequest,
	IssueKeyRequest,
	ListPrincipalsFailure,
	PrincipalIdentity,
	PrincipalList,
	RevokedKey,
	RevokeFailure,
} from './types'

// The header the proxy injects its verified token on. Re-exported so an app never spells it out.
export { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'

// Re-export from core so apps need only depend on the SDK: DomainEvent (one event shape),
// IamRpc (the binding contract — apps type their `env.IAM` as IamRpc without importing core),
// Scope (the `{ type, value }` coordinate apps pass to `can()`), the AppSchema vocabulary types
// apps DECLARE in `fabrika.schema.ts` for `reconcileSchema()`, and the per-path gate types
// (`AppGates` & co.) apps DECLARE for the PROXY manifest — never for in-process enforcement.
export type {
	AppActionDef,
	AppGates,
	AppSchema,
	AppScopeDef,
	CredentialLocation,
	DomainEvent,
	GateKind,
	GateRule,
	IamRpc,
	PrincipalListItem,
	RoleDef,
	Scope,
} from '@fabrika/auth-core'
