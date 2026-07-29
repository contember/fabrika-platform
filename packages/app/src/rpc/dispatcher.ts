// ─── RPC dispatcher ──────────────────────────────────────────────────
//
// Resolves a dotted method path against a router, validates input, enforces
// authz requirements, runs the handler, and (optionally) validates output. All
// error mapping goes through the structural contract in `errors.ts`.

import type { AuthContext } from '@fabrika/auth'
import { ForbiddenError, HttpError, jsonResponse, readStructuralError } from '../errors.js'
import type { StandardSchemaV1 } from '../standard-schema.js'
import type { AnyProcedure, AnyRouter, RouterDef } from './types.js'

interface SingleCall {
	method: string
	input: unknown
}

interface SingleResult {
	result?: unknown
	error?: { type: string; message: string; issues?: unknown }
}

interface DispatchOutcome {
	readonly body: SingleResult
	readonly status: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

function hasAuth(ctx: unknown): ctx is { auth: AuthContext } {
	if (!isRecord(ctx)) return false
	const auth = ctx['auth']
	return isRecord(auth) && typeof auth['can'] === 'function' && typeof auth['scopedTo'] === 'function' && typeof auth['audit'] === 'function'
}

/**
 * Run a Standard Schema validator and ALWAYS return a Result — a validator that throws (rather than
 * returning issues, as the spec intends) is folded into a single issue so the dispatcher never leaks
 * a raw schema error.
 */
async function safeValidate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<StandardSchemaV1.Result<T>> {
	try {
		return await schema['~standard'].validate(value)
	} catch (err) {
		return { issues: [{ message: err instanceof Error ? err.message : 'Validation failed' }] }
	}
}

/** A short human message from the first issue (path-prefixed); the full list rides in the envelope. */
function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
	const first = issues[0]
	if (!first) return 'Validation failed'
	const path = first.path?.map((seg) => (typeof seg === 'object' ? String(seg.key) : String(seg))).join('.')
	return path ? `${path}: ${first.message}` : first.message
}

function resolve(router: AnyRouter, methodPath: string): AnyProcedure | null {
	const parts = methodPath.split('.')
	let node: AnyProcedure | AnyRouter = router
	for (const part of parts) {
		if (node._tag !== 'router') return null
		const def: RouterDef = node._def
		const next = def[part]
		if (!next) return null
		node = next
	}
	return node._tag === 'procedure' ? node : null
}

async function invokeProcedure(procedure: AnyProcedure, ctx: unknown, rawInput: unknown): Promise<unknown> {
	// Normalize JSON's `null` to `undefined` for no-input procedures.
	const normalized = rawInput === null ? undefined : rawInput
	const inResult = await safeValidate(procedure.input, normalized)
	if (inResult.issues) {
		throw new HttpError(400, 'validation', formatIssues(inResult.issues), { issues: inResult.issues })
	}
	const input = inResult.value

	for (const requirement of procedure.requirements) {
		const scope = requirement.scopeResolver?.(input, ctx)
		if (!hasAuth(ctx) || !ctx.auth.can(requirement.action, scope)) {
			throw new ForbiddenError(`Forbidden: ${requirement.action}`)
		}
	}

	const output = await procedure.handler({ ctx, input })
	if (!procedure.output) return output
	const outResult = await safeValidate(procedure.output, output)
	if (outResult.issues) {
		throw new HttpError(500, 'internal', `Output validation failed: ${formatIssues(outResult.issues)}`)
	}
	return outResult.value
}

async function dispatchOne(router: AnyRouter, ctx: unknown, call: SingleCall): Promise<DispatchOutcome> {
	const procedure = resolve(router, call.method)
	if (!procedure) {
		return { body: { error: { type: 'method_not_found', message: `Unknown method: ${call.method}` } }, status: 404 }
	}
	try {
		const result = await invokeProcedure(procedure, ctx, call.input)
		return { body: { result }, status: 200 }
	} catch (err) {
		// HTTP status comes from the error's OWN structural httpStatus (ForbiddenError → 403,
		// BadRequestError → 400, a custom `{ httpStatus: 503 }` → 503, a plain Error → 500) — not a
		// hardcoded type table — so every error maps correctly without the dispatcher knowing its type.
		const { httpStatus, type, message, issues } = readStructuralError(err)
		return { body: { error: { type, message, ...(issues !== undefined ? { issues } : {}) } }, status: httpStatus }
	}
}

/**
 * Dispatch an RPC POST. The `ctx` is already built (and decorated by middleware,
 * e.g. `ctx.auth`) by the server before this is called. Handles a single call
 * `{ method, input }` or a `{ batch: [...] }`.
 */
export async function dispatchRpcRequest(args: { router: AnyRouter; ctx: unknown; request: Request }): Promise<Response> {
	let rawBody: unknown
	try {
		rawBody = await args.request.json()
	} catch {
		return jsonResponse({ error: { type: 'validation', message: 'Invalid JSON body' } }, 400)
	}

	if (isRecord(rawBody) && Array.isArray(rawBody['batch'])) {
		const results: SingleResult[] = []
		for (const call of rawBody['batch']) {
			results.push((await dispatchOne(args.router, args.ctx, normalizeCall(call))).body)
		}
		return jsonResponse({ batch: results }, 200)
	}

	if (!isRecord(rawBody) || typeof rawBody['method'] !== 'string') {
		return jsonResponse({ error: { type: 'validation', message: 'Body must be { method, input } or { batch: [...] }' } }, 400)
	}

	const single = await dispatchOne(args.router, args.ctx, { method: rawBody['method'], input: rawBody['input'] })
	return jsonResponse(single.body, single.status)
}

function normalizeCall(call: unknown): SingleCall {
	if (isRecord(call) && typeof call['method'] === 'string') {
		return { method: call['method'], input: call['input'] }
	}
	return { method: '', input: undefined }
}
