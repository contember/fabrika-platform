// What a request kind that IAM carries out reads and does there (ADR-0083 §8). Control reads an application's grants and
// grant requests with its provisioning key, which judges nothing: it binds the before-state and follows an unknown
// execution. The change itself, and the question whether a person administers the application, go to IAM with that
// person's console token, so IAM checks them as it checks the console.

import { type InferRpcClient, RpcError } from '@fabrika/app'
import {
	type CreateGrantRequest,
	type IamAdministrationScope,
	iamAdministrationScope,
	type IamAdminRpcContract,
	type PermissionEntry,
	type ProvisionRequestedApiKeyRequest,
	type RequestedApiKey,
} from '@fabrika/iam-contract'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import { consoleIamClient } from '../console-iam'

/** A grant a principal holds at one application, as a request binds it. */
export const heldGrantSchema = z.object({
	id: z.string(),
	roleKey: z.string().nullable(),
	permissions: z.array(z.string()).nullable(),
	scopeType: z.string().nullable(),
	scopeValues: z.array(z.string()).nullable(),
	expiresAt: z.number().nullable(),
})
export type HeldGrant = z.infer<typeof heldGrantSchema>

/** A grant as IAM holds it now: what a request binds, and who made it, by which `follow` tells an execution's own grant. */
export interface CurrentGrant extends HeldGrant {
	readonly grantedBy: string | null
}

const principalSchema = z.object({
	label: z.string(),
	grants: z.array(
		heldGrantSchema.extend({ app: z.string().nullable(), scopeValues: z.array(z.string()).nullable().optional(), grantedBy: z.string().nullable() }),
	),
})

/** An open grant request, as `follow` matches it against an execution. */
export const openGrantRequestSchema = z.object({
	id: z.string(),
	kind: z.string(),
	principalId: z.string(),
	roleKey: z.string().nullable(),
	scopeType: z.string().nullable(),
	scopeValues: z.array(z.string()).nullable(),
	requestedBy: z.string(),
	status: z.string(),
})
export type OpenGrantRequest = z.infer<typeof openGrantRequestSchema>

const grantRequestListSchema = z.object({ items: z.array(openGrantRequestSchema) })

/** IAM's grants and open grant requests, read with Control's provisioning key. */
export interface IamGrantsReader {
	/**
	 * The principal's label and its grants at `app` (an `<app>@<env>` id), cross-app ones left out; null when IAM knows no
	 * such principal.
	 */
	principalAt(principalId: string, app: string): Promise<{ readonly label: string; readonly grants: readonly CurrentGrant[] } | null>
	/** The grant requests at `app` that wait for an administrator. */
	openGrantRequests(app: string): Promise<readonly OpenGrantRequest[]>
}

export function iamGrantsReader(client: InferRpcClient<IamAdminRpcContract>): IamGrantsReader {
	return {
		async principalAt(principalId, app) {
			let raw: unknown
			try {
				raw = await client.principals.get({ principalId })
			} catch (cause) {
				if (cause instanceof RpcError && cause.httpStatus === 404) return null
				throw cause
			}
			const principal = principalSchema.parse(raw)
			const grants = principal.grants
				.filter((grant) => grant.app === app)
				.map((grant) => ({
					id: grant.id,
					roleKey: grant.roleKey,
					permissions: grant.permissions,
					scopeType: grant.scopeType,
					scopeValues: grant.scopeValues ?? null,
					expiresAt: grant.expiresAt,
					grantedBy: grant.grantedBy,
				}))
			return { label: principal.label, grants }
		},
		async openGrantRequests(app) {
			return grantRequestListSchema.parse(await client.grantRequests.list({ app })).items
		},
	}
}

/** What a grant answered: the grant made, or IAM's own request for a second administrator where the application's grants wait. */
export type GrantOutcome = { readonly kind: 'granted'; readonly grantId: string } | {
	readonly kind: 'requested'
	readonly grantRequestId: string
	readonly status: string
}

const grantChangeSchema = z.union([
	z.object({ pending: z.object({ id: z.string(), status: z.string() }) }),
	z.object({ id: z.string() }),
])

const meSchema = z.object({
	permissions: z.array(z.object({ action: z.string(), scope: z.object({ type: z.string(), value: z.string() }).nullable() })),
})

/** IAM could not be asked, or did not answer what it was asked: it said neither yes nor no. */
export class IamUnreachableError extends Error {
	constructor() {
		super('IAM could not be reached')
		this.name = 'IamUnreachableError'
	}
}

/** IAM as the person deciding a request in the console, with their console token. */
export interface IamApprover {
	/** What the person administers in IAM; null for nothing. Throws `IamUnreachableError` when IAM cannot say. */
	administration(): Promise<IamAdministrationScope | null>
	/** The person's console grant (`grants.create`). IAM's refusal throws as an `RpcError` with its status. */
	createGrant(input: CreateGrantRequest): Promise<GrantOutcome>
	/**
	 * A key the person approved for the agent that asked (`apiKeys.provisionRequested`), encrypted to the agent's public
	 * key; a repeat under the same request answers the same key. IAM's refusal throws as an `RpcError` with its status.
	 */
	provisionRequestedKey(input: ProvisionRequestedApiKeyRequest): Promise<RequestedApiKey>
}

/** The approver's IAM, over the console's IAM gateway transport; null without a console token on `request`. */
export function consoleIamApprover(gateway: HttpService, request: Request): IamApprover | null {
	const client = consoleIamClient(gateway, request)
	if (client === null) return null
	return {
		async administration() {
			let answered: unknown
			try {
				answered = await client.me()
			} catch (cause) {
				// A person IAM gives no administration is refused `me`; anything else is IAM not answering.
				if (cause instanceof RpcError && (cause.httpStatus === 401 || cause.httpStatus === 403)) return null
				throw new IamUnreachableError()
			}
			const me = meSchema.safeParse(answered)
			if (!me.success) throw new IamUnreachableError()
			const permissions: PermissionEntry[] = me.data.permissions.map((entry) => ({ action: entry.action, scope: entry.scope, source: 'grant' }))
			return iamAdministrationScope(permissions)
		},
		async createGrant(input) {
			const answered = grantChangeSchema.parse(await client.grants.create(input))
			return 'pending' in answered
				? { kind: 'requested', grantRequestId: answered.pending.id, status: answered.pending.status }
				: { kind: 'granted', grantId: answered.id }
		},
		async provisionRequestedKey(input) {
			return requestedKeySchema.parse(await client.apiKeys.provisionRequested(input))
		},
	}
}

const requestedKeySchema = z.object({ principalId: z.string().min(1), jwe: z.string().min(1), expiresAt: z.number().int() })

/** The keys approval requests issued in IAM, read and revoked with Control's provisioning key. */
export interface IamRequestedKeys {
	/** The key the request issued, still encrypted to its requester; null when IAM issued none under it. */
	requested(approvalRequestId: string): Promise<RequestedApiKey | null>
	/** Revoke the key of `principalId`; one IAM no longer knows counts as revoked. */
	revoke(principalId: string): Promise<void>
}

export function iamRequestedKeys(client: InferRpcClient<IamAdminRpcContract>): IamRequestedKeys {
	return {
		async requested(approvalRequestId) {
			return z.object({ key: requestedKeySchema.nullable() }).parse(await client.apiKeys.requested({ approvalRequestId })).key
		},
		async revoke(principalId) {
			try {
				await client.apiKeys.revoke({ principalId })
			} catch (cause) {
				if (cause instanceof RpcError && cause.httpStatus === 404) return
				throw cause
			}
		},
	}
}

/** Whether `administration` reaches the people of `app` (an `<app>@<env>` id), as IAM's own `managesApp` reads it. */
export function administers(administration: IamAdministrationScope | null, app: string): boolean {
	if (administration === null) return false
	if (administration.kind === 'installation') return true
	return administration.apps === null || administration.apps.includes(app)
}
