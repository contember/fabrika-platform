// The external application form (ADR-0089): the draft a person edits, the whole-aggregate request it becomes, what a
// save would change that the page warns about, and IAM's refusal before the deploy imported its client list. The checks
// here only say early what IAM refuses; IAM checks every write again.

import { RpcError } from '@fabrika/app'
import { displayNameProblem, isCimdClientId, isOAuthResourceUri } from '@fabrika/auth-core'
import {
	type ExternalAppDto,
	isHttpsDocumentUrl,
	isOAuthIdentityAppId,
	isOAuthIdentityRoleKey,
	MAX_EXTERNAL_APP_CLIENTS,
	MAX_OAUTH_IDENTITY_ROLES,
	OAUTH_REGISTRY_NOT_IMPORTED,
	type PutExternalAppRequest,
} from '@fabrika/iam-contract'

export interface RoleDraft {
	key: string
	name: string
}

export interface ClientDraft {
	clientId: string
	/** One redirect URI per line. */
	redirectUris: string
	/** Empty: IAM fetches the document at the client id. */
	metadataUrl: string
}

export interface ExternalAppDraft {
	app: string
	name: string
	resource: string
	roles: RoleDraft[]
	clients: ClientDraft[]
}

/** The longest role name IAM stores. */
const MAX_ROLE_NAME_LENGTH = 100

export function emptyClient(): ClientDraft {
	return { clientId: '', redirectUris: '', metadataUrl: '' }
}

/** A new application starts with one client to fill in and no roles: every active user signs in until roles exist. */
export function emptyDraft(): ExternalAppDraft {
	return { app: '', name: '', resource: '', roles: [], clients: [emptyClient()] }
}

export function draftOf(app: ExternalAppDto): ExternalAppDraft {
	return {
		app: app.app,
		name: app.name ?? '',
		resource: app.resource,
		roles: (app.roles ?? []).map((role) => ({ key: role.key, name: role.name })),
		clients: app.clients.map((client) => ({
			clientId: client.clientId,
			redirectUris: client.redirectUris.join('\n'),
			metadataUrl: client.metadataUrl ?? '',
		})),
	}
}

/**
 * A field's path in the draft: `app`, `name`, `resource`, `roles`, `roles.<i>.key`, `roles.<i>.name`, `clients`,
 * `clients.<i>.clientId`, `clients.<i>.redirectUris` or `clients.<i>.metadataUrl`. The form shows each problem at its field.
 */
export type DraftProblems = ReadonlyMap<string, string>

export type DraftRequest =
	| { readonly ok: true; readonly request: PutExternalAppRequest }
	| { readonly ok: false; readonly problems: DraftProblems }

function lines(text: string): string[] {
	return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** The request `externalApps.put` takes for the draft, or each field IAM would refuse and why. */
export function externalAppRequest(draft: ExternalAppDraft): DraftRequest {
	const problems = new Map<string, string>()
	const app = draft.app.trim()
	if (!isOAuthIdentityAppId(app)) {
		problems.set('app', 'Use lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters.')
	}
	const nameProblem = displayNameProblem(draft.name)
	if (nameProblem !== null) problems.set('name', `The name ${nameProblem}.`)
	const resource = draft.resource.trim()
	if (!isOAuthResourceUri(resource) || !resource.startsWith('https://')) {
		problems.set('resource', 'Enter the https URI the application asks IAM for, such as https://tool.example.com.')
	}

	if (draft.roles.length > MAX_OAUTH_IDENTITY_ROLES) problems.set('roles', `An application declares at most ${MAX_OAUTH_IDENTITY_ROLES} roles.`)
	const roles = draft.roles.map((role, index) => {
		const key = role.key.trim()
		const name = role.name.trim()
		if (!isOAuthIdentityRoleKey(key)) {
			problems.set(`roles.${index}.key`, 'Lowercase letters, digits and dashes, and not a built-in role such as admin.')
		} else if (draft.roles.findIndex((other) => other.key.trim() === key) !== index) {
			problems.set(`roles.${index}.key`, 'Another role has this key.')
		}
		if (name === '' || name.length > MAX_ROLE_NAME_LENGTH) {
			problems.set(`roles.${index}.name`, `Name the role in 1 to ${MAX_ROLE_NAME_LENGTH} characters.`)
		}
		return { key, name }
	})

	if (draft.clients.length > MAX_EXTERNAL_APP_CLIENTS) problems.set('clients', `An application has at most ${MAX_EXTERNAL_APP_CLIENTS} clients.`)
	const clients = draft.clients.map((client, index) => {
		const clientId = client.clientId.trim()
		if (!isCimdClientId(clientId)) {
			problems.set(`clients.${index}.clientId`, "The https URL of the client's metadata document, with a path.")
		} else if (draft.clients.findIndex((other) => other.clientId.trim() === clientId) !== index) {
			problems.set(`clients.${index}.clientId`, 'Another client has this client id.')
		}
		const redirectUris = lines(client.redirectUris)
		if (redirectUris.length === 0 || redirectUris.length > 32) {
			problems.set(`clients.${index}.redirectUris`, 'List 1 to 32 redirect URIs, one per line.')
		} else if (!redirectUris.every((uri) => isOAuthResourceUri(uri))) {
			problems.set(`clients.${index}.redirectUris`, 'Each redirect URI is an exact https URL (loopback http for local development) without a fragment.')
		} else if (new Set(redirectUris).size !== redirectUris.length) {
			problems.set(`clients.${index}.redirectUris`, 'A redirect URI is listed twice.')
		}
		const metadataUrl = client.metadataUrl.trim()
		if (metadataUrl !== '' && !isHttpsDocumentUrl(metadataUrl)) {
			problems.set(`clients.${index}.metadataUrl`, 'An https URL without credentials or a fragment, or leave it empty.')
		}
		return { clientId, redirectUris, metadataUrl: metadataUrl === '' ? null : metadataUrl }
	})

	if (problems.size > 0) return { ok: false, problems }
	return { ok: true, request: { app, name: draft.name, resource, roles: roles.length === 0 ? null : roles, clients } }
}

/** What a save changes that ends sign-ins or refuses people, so the form can say it before the save. */
export interface DraftConsequences {
	/** The application had no roles and now declares some: everyone is refused until a role is granted. */
	readonly rolesIntroduced: boolean
	/** It had roles and now declares none: every active user of the installation signs in. */
	readonly rolesDropped: boolean
	/** Role keys it had that the draft no longer declares; their grants stop counting. */
	readonly removedRoles: readonly string[]
	/** Client ids it had that the draft no longer lists; their sign-ins are revoked. */
	readonly removedClients: readonly string[]
	/** The resource changes: every sign-in of its clients is revoked. */
	readonly resourceChanged: boolean
}

/** `original` is null for an application not registered yet. */
export function draftConsequences(original: ExternalAppDto | null, draft: ExternalAppDraft): DraftConsequences {
	const before = (original?.roles ?? []).map((role) => role.key)
	const after = draft.roles.map((role) => role.key.trim()).filter((key) => key !== '')
	const clients = draft.clients.map((client) => client.clientId.trim())
	return {
		rolesIntroduced: before.length === 0 && after.length > 0,
		rolesDropped: before.length > 0 && after.length === 0,
		removedRoles: after.length === 0 ? [] : before.filter((key) => !after.includes(key)),
		removedClients: (original?.clients ?? []).map((client) => client.clientId).filter((id) => !clients.includes(id)),
		resourceChanged: original !== null && original.resource !== draft.resource.trim(),
	}
}

/**
 * What a save of an existing application ends, one sentence each, for the confirmation before it is sent; empty when
 * the save ends nothing. A new application ends nobody's sign-in, so it needs none.
 */
export function revocationsToConfirm(consequences: DraftConsequences): string[] {
	const lines: string[] = []
	const clients = consequences.removedClients.length
	if (clients > 0) lines.push(`${clients === 1 ? 'A removed client loses' : `${clients} removed clients lose`} every sign-in through it.`)
	if (consequences.resourceChanged) lines.push("The new resource revokes every sign-in of the application's clients.")
	if (consequences.removedRoles.length > 0) {
		lines.push(`${consequences.removedRoles.map((key) => `'${key}'`).join(', ')} is taken from everyone it is granted to.`)
	}
	if (consequences.rolesDropped) lines.push('Without roles, every active user of the installation can sign in.')
	if (consequences.rolesIntroduced) lines.push('Everyone is refused at their next sign-in or token refresh until you grant one of the new roles.')
	return lines
}

/** IAM refuses every registry write until a deploy of this release imported the deploy variable's client list. */
export function registryNotImported(cause: unknown): boolean {
	return cause instanceof RpcError && cause.httpStatus === 409 && cause.message === OAUTH_REGISTRY_NOT_IMPORTED
}
