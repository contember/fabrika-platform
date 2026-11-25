// The rules an approval request is judged by, shared by its use cases and its execution (ADR-0083 §8).

import type { AuthContext } from '@fabrika/auth'
import { sha256Hex } from '@fabrika/auth-core'
import {
	ACTION_CATEGORIES,
	type ActionCategory,
	ALL_ENVIRONMENTS,
	type ApprovalPolicy,
	type ApprovalSettings,
	gate,
	PERMISSIVE_POLICY,
	REQUEST_TTL_HOURS,
	requesterMayApprove,
	requesterPersonId,
	requiredApprovers,
	requiredStepUp,
	type StepUpMode,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { canAtCoordinates } from '../../api/runs'
import type { AppEnvRow, ApprovalRequestRow, ControlRegistryRepository } from '../../db'
import { appScope } from '../../iam'
import { appEnvPolicy, appEnvSettings } from '../categories'
import type { RequesterPerson } from '../human'
import type { RequestApprover, RequestCoordinates, RequestKind } from './kind'

/** `sha256:<hex>` of a canonical JSON text. */
export function jsonDigest(text: string): string {
	return `sha256:${sha256Hex(text)}`
}

/** The person behind a request, as its row recorded the requester. */
export function requesterOf(row: ApprovalRequestRow): RequesterPerson {
	return { personId: requesterPersonId({ id: row.requester_id, type: row.requester_type }, row.requester_issuer_id), label: row.requester_label }
}

/** The modes a change of an environment meets: its own while protected, none otherwise (ADR-0083 §3). */
export function policyOf(appEnv: AppEnvRow): ApprovalPolicy {
	return appEnv.protected === 1 ? appEnvPolicy(appEnv) : PERMISSIVE_POLICY
}

/**
 * The settings a request of an environment meets: its own while protected, the defaults otherwise (ADR-0083 §2). The
 * creation, the decision and the execution all read them here.
 */
export function settingsOf(appEnv: AppEnvRow | null): ApprovalSettings {
	return appEnv !== null && appEnv.protected === 1 ? appEnvSettings(appEnv) : STRICT_SETTINGS
}

/** The category a stored request names, or null for one this release does not know. */
export function requestCategory(row: Pick<ApprovalRequestRow, 'category'>): ActionCategory | null {
	return ACTION_CATEGORIES.find((category) => category === row.category) ?? null
}

/** Who decides a request, and what deciding it takes. */
export interface RequestDeciders {
	readonly approvers: 1 | 2
	readonly requesterMayApprove: boolean
	readonly stepUp: StepUpMode
}

/**
 * Who decides a request under its environment's settings now: how many people, whether the requester's person may, and
 * whether deciding takes a passkey.
 */
export function deciders(settings: ApprovalSettings, row: Pick<ApprovalRequestRow, 'category'>): RequestDeciders {
	const category = requestCategory(row)
	// A category this release does not know takes the strictest reading.
	if (category === null) return { approvers: 2, requesterMayApprove: false, stepUp: 'webauthn' }
	return {
		approvers: requiredApprovers(settings, [category]),
		requesterMayApprove: requesterMayApprove(settings, [category]),
		stepUp: requiredStepUp(settings, [category]),
	}
}

/**
 * The environments a request reaches: its own, or under `ALL_ENVIRONMENTS` every environment of its application. Null
 * when the environment, or the application, no longer exists.
 */
export async function reachOf(
	registry: Pick<ControlRegistryRepository, 'getApp' | 'getAppEnv' | 'listAppEnvs'>,
	coordinates: RequestCoordinates,
): Promise<readonly AppEnvRow[] | null> {
	if (coordinates.env !== ALL_ENVIRONMENTS) {
		const appEnv = await registry.getAppEnv(coordinates.appId, coordinates.env)
		return appEnv === null ? null : [appEnv]
	}
	if ((await registry.getApp(coordinates.appId)) === null) return null
	return registry.listAppEnvs(coordinates.appId)
}

/** The environments whose modes and settings judge a request: the protected ones it reaches (ADR-0083 §1). */
export function judging(reach: readonly AppEnvRow[]): readonly AppEnvRow[] {
	return reach.filter((appEnv) => appEnv.protected === 1)
}

/** The first environment the request reaches that refuses its category to a non-person, or null when none does. */
export function refusingEnvironment(reach: readonly AppEnvRow[], category: ActionCategory): AppEnvRow | null {
	return judging(reach).find((appEnv) => gate({ lines: [], actions: [category] }, policyOf(appEnv)).kind === 'refuse') ?? null
}

/**
 * Who decides a request among the environments it reaches: the most approvers any asks for, the requester's person only
 * where every one allows it, and a passkey where any asks for one. With none protected, the defaults.
 */
export function decidersOf(reach: readonly AppEnvRow[], row: Pick<ApprovalRequestRow, 'category'>): RequestDeciders {
	const each = judging(reach).map((appEnv) => deciders(settingsOf(appEnv), row))
	if (each.length === 0) return deciders(STRICT_SETTINGS, row)
	return {
		approvers: each.some((who) => who.approvers === 2) ? 2 : 1,
		requesterMayApprove: each.every((who) => who.requesterMayApprove),
		stepUp: each.some((who) => who.stepUp === 'webauthn') ? 'webauthn' : 'none',
	}
}

/** How long a request waits for a decision: the shortest `requestTtlHours` among the environments it reaches. */
export function requestTtlHoursOf(reach: readonly AppEnvRow[]): number {
	const hours = judging(reach).map((appEnv) => settingsOf(appEnv).requestTtlHours)
	return hours.length === 0 ? REQUEST_TTL_HOURS.default : Math.min(...hours)
}

/**
 * Whether the caller holds a kind's action where the request acts: unscoped where the input's use case requires that, at
 * the application when the kind's route requires it there or the request reaches every environment, else at the
 * application or the environment.
 */
export function holdsKindAction(
	auth: AuthContext,
	kind: Pick<RequestKind, 'requesterAction' | 'requesterAt'>,
	coordinates: RequestCoordinates,
): boolean {
	if (kind.requesterAt === 'global') return auth.can(kind.requesterAction)
	if (kind.requesterAt === 'app' || coordinates.env === ALL_ENVIRONMENTS) return auth.can(kind.requesterAction, appScope(coordinates.appId))
	return canAtCoordinates(auth, kind.requesterAction, coordinates.appId, coordinates.env)
}

/** Whether the caller may carry the request out, as approving does: the decider its kind names, or else the kind's action where it acts. */
export async function mayExecute(
	approver: RequestApprover,
	kind: Pick<RequestKind, 'requesterAction' | 'requesterAt' | 'approverMayDecide'>,
	coordinates: RequestCoordinates,
): Promise<boolean> {
	if (kind.approverMayDecide !== undefined) return kind.approverMayDecide(approver, coordinates)
	return holdsKindAction(approver.auth, kind, coordinates)
}

/**
 * Whether the caller holds `action` at a request's coordinates: at its environment, or under `ALL_ENVIRONMENTS` at every
 * protected environment the request reaches, and at the application when none is protected.
 */
export async function holdsAtReach(
	auth: AuthContext,
	registry: Pick<ControlRegistryRepository, 'getApp' | 'getAppEnv' | 'listAppEnvs'>,
	action: string,
	coordinates: RequestCoordinates,
): Promise<boolean> {
	if (coordinates.env !== ALL_ENVIRONMENTS) return canAtCoordinates(auth, action, coordinates.appId, coordinates.env)
	const judges = judging((await reachOf(registry, coordinates)) ?? [])
	if (judges.length === 0) return auth.can(action, appScope(coordinates.appId))
	return judges.every((appEnv) => canAtCoordinates(auth, action, appEnv.app_id, appEnv.env))
}
