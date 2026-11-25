// The OAuth clients IAM serves and the external applications they sign people in to (ADR-0089). An installation
// administrator registers an external application with its roles and clients; the operator, with the provisioning key,
// registers an MCP authoring client. IAM checks every write; the console reads these shapes only to show them.

import type { OAuthClientProvider, OAuthIdentityRole } from './oauth'

/**
 * IAM's refusal of a registry write before the deploy imported its client list (release N of ADR-0089), answered with
 * HTTP 409. The console and the CLI match it to say what to do instead of showing a generic conflict.
 */
export const OAUTH_REGISTRY_NOT_IMPORTED = 'IAM takes registry writes once a deploy of this release has imported the OAuth client list '
	+ '(oauthClients.importOnce); until then it serves the clients of its OAUTH_CONFIG. Deploy the platform first.'

/** How many clients one external application has. */
export const MAX_EXTERNAL_APP_CLIENTS = 16

/** One client of an external application: its client id, its exact redirect URIs and where IAM fetches its document. */
export interface ExternalAppClient {
	clientId: string
	redirectUris: string[]
	/** Where IAM fetches the Client ID Metadata Document when it is not the client id itself. */
	metadataUrl?: string | null
}

/**
 * An external application as a whole: an app id with no deploy target, its identity resource, its display name, its
 * roles (each granting no action) and its clients. `externalApps.put` replaces all of it at once.
 */
export interface PutExternalAppRequest {
	app: string
	name: string
	resource: string
	/** Absent, null or empty: no roles, and every active user signs in. */
	roles?: OAuthIdentityRole[] | null
	clients: ExternalAppClient[]
}

export interface ExternalAppDto {
	app: string
	/** Null for an application the deploy variable's import registered, which named none. */
	name: string | null
	resource: string
	/** Null when the application declares no roles. */
	roles: OAuthIdentityRole[] | null
	clients: { clientId: string; redirectUris: string[]; metadataUrl: string | null }[]
	createdAt: number
	updatedAt: number
}

export interface ExternalAppInput {
	app: string
}

/** A registered OAuth client: an MCP authoring client (`externalApp` null) or a client of an external application. */
export interface OAuthClientDto {
	clientId: string
	label: OAuthClientProvider
	redirectUris: string[]
	metadataUrl: string | null
	externalApp: string | null
	createdAt: number
	updatedAt: number
}

/** An MCP authoring client, written with the provisioning key only. */
export interface PutOAuthClientRequest {
	clientId: string
	label: OAuthClientProvider
	redirectUris: string[]
	metadataUrl?: string | null
}

export interface OAuthClientInput {
	clientId: string
}

/**
 * The deploy variable's list, imported once (release N of ADR-0089): each entry in the shape `OAUTH_CONFIG.clients`
 * takes, an `OAuthManagedClient` with an optional `metadataUrl`. IAM checks every entry again.
 */
export interface ImportOAuthClientsRequest {
	clients: unknown[]
}

export type ImportOAuthClientsResponse =
	| { status: 'imported'; externalApps: string[]; oauthClients: string[] }
	| { status: 'already_imported' }
