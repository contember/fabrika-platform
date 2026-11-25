// The contract one kind of approval request implements (ADR-0083 §8): what it takes, where it acts, who may ask for it,
// what it binds, how it executes and how its unknown outcome is followed, and how the page describes it. A kind is
// written against its own types; `requestKind` erases them, so the registry holds every kind under one type.

import type { AuthContext } from '@fabrika/auth'
import { canonicalJson } from '@fabrika/auth-core'
import type { ActionCategory, ApprovalRequestDescription } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import type { z } from 'zod'
import type { ApprovalRequestRow, ControlRepositories } from '../../db'

/** What a kind reads and writes through. A kind that needs more (a provider, the vault, IAM) adds it here with its step. */
export interface RequestKindContext {
	readonly repositories: ControlRepositories
}

/** The coordinates a request acts at: one application environment. */
export interface RequestCoordinates {
	readonly appId: string
	readonly env: string
}

/** One execution of an approved request, under its environment's deployment lease. */
export interface RequestExecution {
	readonly requestId: string
	/** Recorded on the row before this call: an effect that may be attempted twice is keyed by it. */
	readonly operationId: string
	/** Aborts once the environment's lease is lost: stop before the next external effect. */
	readonly signal: AbortSignal
}

/** What an execution observed. A throw is neither: the outcome is unknown, and the sweep follows it. */
export type RequestOutcome = { readonly state: 'executed'; readonly result: JsonValue } | { readonly state: 'failed'; readonly error: string }

export interface RequestKindDefinition<Input, Before> {
	/** The name an agent asks by: the Control procedure the request stands for, or `iam.<procedure>` for IAM's. */
	readonly kind: string
	/** The action category whose mode and settings judge it. */
	readonly category: ActionCategory
	/**
	 * The input, checked when the request is created and parsed again from the stored row. Not strict, so a rollback
	 * still parses a row with a later release's key; but a stored input that does not read back to its digest (a key
	 * dropped, a default filled) is neither described nor executed, since the person approved the whole of it.
	 */
	readonly input: z.ZodType<Input, z.ZodTypeDef, unknown>
	/** The before-state as stored, parsed the same way. */
	readonly before: z.ZodType<Before, z.ZodTypeDef, unknown>
	coordinates(input: Input): RequestCoordinates
	/**
	 * The Control action the requester's own token must hold at the coordinates to ask: the action itself, or
	 * `access.request` for what the requester cannot execute itself (a grant, a key).
	 */
	readonly requesterAction: string
	/**
	 * Whether a person may decide it. Absent: `access.approve` at the coordinates, Control's own kinds. An IAM kind names
	 * the application's IAM administration here.
	 */
	readonly approverMayDecide?: (auth: AuthContext, coordinates: RequestCoordinates) => boolean
	/**
	 * What the action depends on now: a generation, a stored value or its digest, the target it replaces. Captured when
	 * the request is created and again before it executes, under the lease; the two are compared by the SHA-256 of
	 * their canonical JSON, and a difference closes the request `stale`.
	 */
	captureBefore(c: RequestKindContext, input: Input): Promise<Before>
	/** Execute with the approver's authority (`auth`), the requester recorded beside them on the row. */
	execute(c: RequestKindContext & { readonly auth: AuthContext }, input: Input, execution: RequestExecution): Promise<RequestOutcome>
	/**
	 * Settle an `unknown` execution of the same operation: follow it (a data operation records its own steps) or retry it
	 * where its effect is idempotent. Runs in maintenance, with no person's token; it decides nothing new.
	 */
	follow(c: RequestKindContext, input: Input, execution: RequestExecution): Promise<RequestOutcome | { readonly state: 'unknown' }>
	/** What the page shows: plain data, with the text the agent wrote marked as such. */
	describe(input: Input, before: Before): ApprovalRequestDescription
	/**
	 * Release what the request held while it waited (a sealed secret), once a person refused it or it expired. Called once,
	 * after that conditional write; a throw is logged and never retried, and a Control that does not serve the kind skips it.
	 */
	readonly discard?: (c: RequestKindContext, request: ApprovalRequestRow) => Promise<void>
}

/** One checked input of a kind, its types erased. */
export interface RequestAction {
	readonly coordinates: RequestCoordinates
	/** The input in canonical JSON (keys sorted): what the row stores and its digest is taken over. */
	readonly inputJson: string
	/** The before-state now, in canonical JSON. */
	captureBefore(c: RequestKindContext): Promise<string>
	describe(beforeJson: string): ApprovalRequestDescription
	execute(c: RequestKindContext & { readonly auth: AuthContext }, execution: RequestExecution): Promise<RequestOutcome>
	follow(c: RequestKindContext, execution: RequestExecution): Promise<RequestOutcome | { readonly state: 'unknown' }>
}

/** A registered kind. */
export interface RequestKind {
	readonly kind: string
	readonly category: ActionCategory
	readonly requesterAction: string
	readonly approverMayDecide?: (auth: AuthContext, coordinates: RequestCoordinates) => boolean
	readonly discard?: (c: RequestKindContext, request: ApprovalRequestRow) => Promise<void>
	/** Check an input: the action, or why it is refused. */
	action(input: unknown): { readonly ok: true; readonly action: RequestAction } | { readonly ok: false; readonly error: string }
}

/** The kinds a Control serves, by name. */
export type RequestKindRegistry = ReadonlyMap<string, RequestKind>

export function requestKind<Input, Before>(definition: RequestKindDefinition<Input, Before>): RequestKind {
	return {
		kind: definition.kind,
		category: definition.category,
		requesterAction: definition.requesterAction,
		...(definition.approverMayDecide === undefined ? {} : { approverMayDecide: definition.approverMayDecide }),
		...(definition.discard === undefined ? {} : { discard: definition.discard }),
		action(raw) {
			const parsed = definition.input.safeParse(raw)
			if (!parsed.success) {
				return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }
			}
			const input = parsed.data
			return {
				ok: true,
				action: {
					coordinates: definition.coordinates(input),
					inputJson: canonicalJson(input),
					captureBefore: async (c) => canonicalJson(await definition.captureBefore(c, input)),
					describe: (beforeJson) => definition.describe(input, definition.before.parse(JSON.parse(beforeJson))),
					execute: (c, execution) => definition.execute(c, input, execution),
					follow: (c, execution) => definition.follow(c, input, execution),
				},
			}
		},
	}
}

/** The kinds this release serves: none. Steps that route a write through a request register theirs here. */
export const PRODUCTION_REQUEST_KINDS: RequestKindRegistry = new Map()
