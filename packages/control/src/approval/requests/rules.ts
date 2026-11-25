// The rules an approval request is judged by, shared by its use cases and its execution (ADR-0083 §8).

import { sha256Hex } from '@fabrika/auth-core'
import {
	ACTION_CATEGORIES,
	type ActionCategory,
	type ApprovalPolicy,
	type ApprovalSettings,
	PERMISSIVE_POLICY,
	requesterMayApprove,
	requesterPersonId,
	requiredApprovers,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import type { AppEnvRow, ApprovalRequestRow } from '../../db'
import { appEnvPolicy, appEnvSettings } from '../categories'
import type { RequesterPerson } from '../human'

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

/** Who decides a request under its environment's settings now: how many people, and whether the requester's person may. */
export function deciders(settings: ApprovalSettings, row: Pick<ApprovalRequestRow, 'category'>): { approvers: 1 | 2; requesterMayApprove: boolean } {
	const category = requestCategory(row)
	// A category this release does not know takes the strictest reading.
	if (category === null) return { approvers: 2, requesterMayApprove: false }
	return { approvers: requiredApprovers(settings, [category]), requesterMayApprove: requesterMayApprove(settings, [category]) }
}
