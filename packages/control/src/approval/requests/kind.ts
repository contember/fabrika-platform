// The contract one kind of approval request implements (ADR-0083 §8): what it takes, where it acts, who may ask for it,
// what it binds, how it executes and how its unknown outcome is followed, and how the page describes it. A kind is
// written against its own types; `requestKind` erases them, so the registry holds every kind under one type.

import type { AuthContext } from '@fabrika/auth'
import { canonicalJson } from '@fabrika/auth-core'
import type { ActionCategory, ApprovalRequestDescription } from '@fabrika/control-contract'
import type { IamAdministrationScope } from '@fabrika/iam-contract'
import type { DeployLocks } from '@fabrika/platform'
import type { ControlProvider, JsonValue } from '@fabrika/provider-contract'
import type { z } from 'zod'
import type { NamespaceProxyChanged } from '../../api/namespaces'
import type { OperationDeploys, OpsTransport } from '../../data-operations'
import type { ApprovalRequestRow, ControlRepositories } from '../../db'
import type { Lease } from '../../lease'
import type { Vault } from '../../vault'
import type { ConsoleAdmission } from '../human'
import type { IamApprover, IamGrantsReader, IamRequestedKeys } from './iam'

/** What a kind reads through in maintenance too: following an execution, or discarding what a request held. */
export interface RequestKindContext {
	readonly repositories: ControlRepositories
	/** Control's vault, where a request's secret value waits sealed; absent where the installation has none. */
	readonly vault?: () => Promise<Vault>
	/** IAM's grants and grant requests, read with the provisioning key; absent where Control cannot reach IAM. */
	readonly iamGrants?: IamGrantsReader
	/** The installation's provider, which a kind whose effect it keeps reads back; absent, such a request stays unknown. */
	readonly provider?: ControlProvider
	/** The keys approval requests issued in IAM, read and revoked with the provisioning key; absent where Control cannot reach IAM. */
	readonly iamKeys?: IamRequestedKeys
}

/** What a kind acts through when a request is created or executed: the registry's use-case context, less the caller. */
export interface RequestActionContext extends RequestKindContext {
	readonly provider: ControlProvider
	readonly catalogChanged?: () => void
	readonly namespaceProxyChanged?: NamespaceProxyChanged
	/** The environment's object (ADR-0069): its deploy locks and its ops channel; absent, a data operation answers 503. */
	readonly maintenance?: { readonly lock: DeployLocks; readonly ops: OpsTransport }
	/** A restore's own deploys; absent, a restore is refused. */
	readonly deploys?: () => Promise<OperationDeploys>
}

/** An execution acts as the approver, a person in the console, under the environment's lease (`RequestExecution.signal`). */
export interface RequestExecutionContext extends RequestActionContext {
	readonly auth: AuthContext
	readonly admission: ConsoleAdmission
	/** IAM as the approver, with their console token; absent where Control cannot reach IAM as them. */
	readonly iamApprover?: IamApprover
}

/**
 * The person reading or deciding a request: their Control token, and what they administer in IAM, which IAM answers for
 * their console token (null for nothing, and where Control has no IAM to ask as them; `IamUnreachableError` when IAM
 * does not answer).
 */
export interface RequestApprover {
	readonly auth: AuthContext
	iamAdministration(): Promise<IamAdministrationScope | null>
}

/**
 * The coordinates a request acts at: one application environment, or `ALL_ENVIRONMENTS` for the all-environments layer
 * and an application-wide write, which reach every environment of the application.
 */
export interface RequestCoordinates {
	readonly appId: string
	readonly env: string
}

/**
 * What a kind whose row stores other than what the agent sent takes when the request is created: the asked input, checked
 * strictly; and `hold`, which answers the input the row stores in its place. A secret value is sealed under the request's
 * own purpose and its fingerprint answered; a key's ask is recorded with what the requester's own token holds (`requester`).
 * `hold` refuses (`fail`) before it seals anything.
 */
export interface AskedInput<Asked, Input> {
	readonly schema: z.ZodType<Asked, z.ZodTypeDef, unknown>
	coordinates(asked: Asked): RequestCoordinates
	hold(
		c: RequestActionContext,
		asked: Asked,
		requestId: string,
		requester: AuthContext,
	): Promise<{ readonly input: Input; readonly fingerprint?: string }>
}

/** One execution of an approved request, under its environment's deployment lease. */
export interface RequestExecution {
	readonly requestId: string
	/** Recorded on the row before this call: an effect that may be attempted twice is keyed by it. */
	readonly operationId: string
	/** Aborts once the environment's lease is lost: stop before the next external effect. */
	readonly signal: AbortSignal
	/** The environment's lease the execution holds, which a data operation runs under rather than taking its own. */
	readonly lease: Lease
}

/** What an execution observed. A throw is neither: the outcome is unknown, and the sweep follows it. */
export type RequestOutcome = { readonly state: 'executed'; readonly result: JsonValue } | { readonly state: 'failed'; readonly error: string }

/**
 * Where a requester holds `requesterAction`: at the application, as the procedure's route requires it, or unscoped
 * (`global`), as the procedure's use case requires it for some inputs.
 */
export type RequesterAt = 'app' | 'global'

export interface RequestKindDefinition<Input, Before, Asked = never> {
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
	 * `access.request` for what the requester cannot execute itself (a grant, a key). Where no `approverMayDecide` names
	 * who decides, the approver must hold it too, since the change executes as them.
	 */
	readonly requesterAction: string
	/**
	 * Where `requesterAction` must be held: at the application, as the procedure's own route requires it, unscoped where
	 * its use case requires that, or at the coordinates (the application or the environment) when absent. A request of
	 * `ALL_ENVIRONMENTS` takes the application at least. A function decides it per input.
	 */
	readonly requesterAt?: RequesterAt | ((input: Input) => RequesterAt | undefined)
	/** Set when the asked input differs from the stored one (it carries a secret value); absent, the input is asked as stored. */
	readonly asked?: AskedInput<Asked, Input>
	/**
	 * Refuse, when the request is created, what this release cannot execute as a request or what would only fail (`fail`
	 * with the status to answer). A kind with `asked` checks in `hold` instead.
	 */
	readonly admit?: (c: RequestActionContext, input: Input) => Promise<void>
	/**
	 * Why the approver may not approve it beyond `approverMayDecide`, or null: a key holds only actions its approver holds
	 * in Control. Checked before the approval is recorded or a passkey challenge spent on it.
	 */
	readonly refuseApprover?: (approver: AuthContext, input: Input) => string | null
	/**
	 * Whether a person may decide it. Absent: `access.approve` at the coordinates, Control's own kinds. An IAM kind names
	 * the application's IAM administration here, and throws `IamUnreachableError` when IAM cannot say.
	 */
	readonly approverMayDecide?: (approver: RequestApprover, coordinates: RequestCoordinates) => Promise<boolean>
	/**
	 * What the action depends on now: a generation, a stored value or its digest, the target it replaces. Captured when
	 * the request is created and again before it executes, under the lease; the two are compared by the SHA-256 of
	 * their canonical JSON, and a difference closes the request `stale`.
	 */
	captureBefore(c: RequestActionContext, input: Input): Promise<Before>
	/**
	 * Whether the input writes only what `before` holds: a direct write that changes nothing then applies at once instead
	 * of waiting as a request whose page would show no change (D8). Absent, every write is a change. A kind with `asked`
	 * (a secret value) never has one: telling its value from the stored one would take reading a plaintext.
	 */
	readonly unchanged?: (input: Input, before: Before) => boolean
	/**
	 * Execute with the approver's authority (`auth`), the requester recorded beside them on the row. A refusal of the use
	 * case it reuses is an outcome (`failed`); any other throw leaves the outcome unknown.
	 */
	execute(c: RequestExecutionContext, input: Input, execution: RequestExecution): Promise<RequestOutcome>
	/**
	 * Settle an `unknown` execution of the same operation by observing what it left: a data operation records its own
	 * steps, a provider's state is compared with `before`, which held when the execution started. Runs in maintenance,
	 * with no person's token; it decides nothing new.
	 */
	follow(
		c: RequestKindContext,
		input: Input,
		execution: RequestExecution,
		before: Before,
	): Promise<RequestOutcome | { readonly state: 'unknown' }>
	/**
	 * What the page shows: plain data, with the text the agent wrote marked as such. `before` is null for a reader who may
	 * not execute the request (`mayExecute`): it shows what changes, never what is there now, a value or a fingerprint.
	 */
	describe(input: Input, before: Before | null): ApprovalRequestDescription
	/**
	 * Release what the request held while it waited (a sealed secret) once it is closed: refused, expired, stale, failed or
	 * executed (the use case moved the value), never while its outcome is unknown. Called once, after that conditional
	 * write; a throw is logged and never retried, and a Control that does not serve the kind skips it.
	 */
	readonly discard?: (c: RequestKindContext, input: Input, requestId: string) => Promise<void>
}

/** One checked input of a kind, its types erased. */
export interface RequestAction {
	readonly coordinates: RequestCoordinates
	/** The input in canonical JSON (keys sorted): what the row stores and its digest is taken over. */
	readonly inputJson: string
	/** Where the requester, and the approver who executes it, hold the kind's action for this input. */
	readonly requesterAt?: RequesterAt
	/** The before-state now, in canonical JSON. */
	captureBefore(c: RequestActionContext): Promise<string>
	/** `full` for a reader who may execute the request; any other sees no before-state, value or fingerprint. */
	describe(beforeJson: string, full: boolean): ApprovalRequestDescription
	execute(c: RequestExecutionContext, execution: RequestExecution): Promise<RequestOutcome>
	/** `beforeJson` is the stored before-state, which held when the execution started. */
	follow(c: RequestKindContext, execution: RequestExecution, beforeJson: string): Promise<RequestOutcome | { readonly state: 'unknown' }>
	/** Why `approver` may not approve it, or null (`RequestKindDefinition.refuseApprover`). */
	refuseApprover(approver: AuthContext): string | null
}

/** A request being created: where it acts, and how its kind admits it and holds what it carries. */
export interface AskedRequest {
	readonly coordinates: RequestCoordinates
	readonly requesterAt?: RequesterAt
	/**
	 * Refuse what the kind cannot execute as a request, or seal what the request carries under its own purpose, and answer
	 * the action the row stores; `release` drops what was sealed when the row is not written after all.
	 */
	hold(c: RequestActionContext, requestId: string, requester: AuthContext): Promise<AskedHold>
}

export interface AskedHold {
	readonly action: RequestAction
	readonly fingerprint?: string
	release(): Promise<void>
}

/** A registered kind. */
export interface RequestKind {
	readonly kind: string
	readonly category: ActionCategory
	readonly requesterAction: string
	/** The strictest scope any input of the kind takes; an action names the one its input does. */
	readonly requesterAt?: RequesterAt
	readonly approverMayDecide?: (approver: RequestApprover, coordinates: RequestCoordinates) => Promise<boolean>
	/** Release what a stored request held; a throw is the caller's to log. */
	readonly discard?: (c: RequestKindContext, request: ApprovalRequestRow) => Promise<void>
	/**
	 * Whether a direct write's input changes nothing where it acts now, judged by the kind's `unchanged` over the
	 * before-state read now; false for an input the kind does not read in full. Absent where the kind cannot tell.
	 */
	readonly changesNothing?: (c: RequestActionContext, input: unknown) => Promise<boolean>
	/**
	 * Check an input an agent asks with. Refused: one the kind's schema does not read in full (a key it does not take, a
	 * value it would change), since the row would then store less than what was asked.
	 */
	ask(input: unknown): { readonly ok: true; readonly asked: AskedRequest } | { readonly ok: false; readonly error: string }
	/** Check a stored input: the action, or why it is refused. */
	action(input: unknown): { readonly ok: true; readonly action: RequestAction } | { readonly ok: false; readonly error: string }
}

/** The kinds a Control serves, by name. */
export type RequestKindRegistry = ReadonlyMap<string, RequestKind>

export function requestKind<Input, Before, Asked = never>(definition: RequestKindDefinition<Input, Before, Asked>): RequestKind {
	const requesterAt = definition.requesterAt
	const requesterAtOf = (input: Input): { readonly requesterAt?: RequesterAt } => {
		const at = typeof requesterAt === 'function' ? requesterAt(input) : requesterAt
		return at === undefined ? {} : { requesterAt: at }
	}
	const actionOf = (input: Input): RequestAction => ({
		coordinates: definition.coordinates(input),
		inputJson: canonicalJson(input),
		...requesterAtOf(input),
		captureBefore: async (c) => canonicalJson(await definition.captureBefore(c, input)),
		describe: (beforeJson, full) => definition.describe(input, full ? definition.before.parse(JSON.parse(beforeJson)) : null),
		execute: (c, execution) => definition.execute(c, input, execution),
		follow: (c, execution, beforeJson) => definition.follow(c, input, execution, definition.before.parse(JSON.parse(beforeJson))),
		refuseApprover: (approver) => definition.refuseApprover?.(approver, input) ?? null,
	})
	const strictest = typeof requesterAt === 'function' ? 'global' : requesterAt
	const discard = definition.discard
	const asked = definition.asked
	const unchanged = definition.unchanged
	return {
		kind: definition.kind,
		category: definition.category,
		requesterAction: definition.requesterAction,
		...(strictest === undefined ? {} : { requesterAt: strictest }),
		...(definition.approverMayDecide === undefined ? {} : { approverMayDecide: definition.approverMayDecide }),
		...(unchanged === undefined || asked !== undefined ? {} : {
			changesNothing: async (c, raw) => {
				const parsed = read(definition.input, raw)
				return parsed.ok && unchanged(parsed.value, await definition.captureBefore(c, parsed.value))
			},
		}),
		...(discard === undefined ? {} : {
			discard: async (c, request) => {
				const parsed = definition.input.safeParse(JSON.parse(request.input_json))
				if (!parsed.success) throw new Error('the stored input does not parse')
				await discard(c, parsed.data, request.id)
			},
		}),
		ask(raw) {
			if (asked !== undefined) {
				const parsed = read(asked.schema, raw)
				if (!parsed.ok) return parsed
				const value = parsed.value
				return {
					ok: true,
					asked: {
						coordinates: asked.coordinates(value),
						...(strictest === undefined ? {} : { requesterAt: strictest }),
						hold: async (c, requestId, requester) => {
							const held = await asked.hold(c, value, requestId, requester)
							return {
								action: actionOf(held.input),
								...(held.fingerprint === undefined ? {} : { fingerprint: held.fingerprint }),
								release: () => discard === undefined ? Promise.resolve() : discard(c, held.input, requestId),
							}
						},
					},
				}
			}
			const parsed = read(definition.input, raw)
			if (!parsed.ok) return parsed
			const input = parsed.value
			const admit = definition.admit
			return {
				ok: true,
				asked: {
					coordinates: definition.coordinates(input),
					...requesterAtOf(input),
					hold: async (c) => {
						if (admit !== undefined) await admit(c, input)
						return { action: actionOf(input), release: () => Promise.resolve() }
					},
				},
			}
		},
		action(raw) {
			const parsed = definition.input.safeParse(raw)
			if (!parsed.success) return { ok: false, error: issues(parsed.error) }
			return { ok: true, action: actionOf(parsed.data) }
		},
	}
}

function issues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')
}

/** Parse an asked input, refusing one the schema reads with a key dropped or a value changed. */
function read<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	raw: unknown,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string } {
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { ok: false, error: issues(parsed.error) }
	if (canonicalJson(parsed.data) !== canonicalJson(raw)) return { ok: false, error: 'input: holds a key or a value this kind does not take' }
	return { ok: true, value: parsed.data }
}
