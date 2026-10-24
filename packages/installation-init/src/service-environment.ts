// The environment fabrika's four platform services read, as one installation's values.
//
// The variable NAMES are the services' own (`@fabrika/iam`'s `node/runtime.ts`, Control's and Operations'
// configuration, the proxy's `readProxyEnv`), so they are the same on every cloud. What a provider supplies
// is where a service's data lives — a DSN or the cloud's reference to one — and where the proxy dials IAM
// privately; it adds the variables of its own cloud beside these and writes the result.
//
// IAM's Bun runtime reads `ISSUER` and `ENVIRONMENT` UNPREFIXED and everything else with the
// `FABRIKA_IAM_` prefix. Both spellings below are the ones it actually reads.

import { FABRIKA_SERVICE_TABLE_DIGEST, IAM_PROXY_SECRET_VARIABLE } from '@fabrika/auth-core'
import { createHmac } from 'node:crypto'
import type { InstallationEmail } from './email'
import type { IamOAuthConfig } from './mcp'
import { type PlatformHosts, platformOrigin } from './proxy-manifest'
import type { InstallationSecrets } from './secrets'

/** The four services an installation configures. Each is a service of the platform's own topology. */
export type PlatformService = 'iam' | 'operations' | 'control' | 'proxy'

/** Each service's variables, in the order they are written. */
export type PlatformServiceEnvironment = Readonly<Record<PlatformService, ReadonlyMap<string, string>>>

/** IAM's OAuth configuration for MCP clients (ADR-0049): written only when the installation enables MCP authoring. */
export const IAM_OAUTH_CONFIG_VARIABLE = 'FABRIKA_IAM_OAUTH_CONFIG'

/** An object store's coordinates, in the provider's own spelling (values or references to them). */
export interface PlatformStorage {
	readonly bucket: string
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly endpoint: string
}

/** Where each service's data lives. */
export interface PlatformData {
	readonly iamDatabase: string
	readonly controlDatabase: string
	readonly operationsDatabase: string
	/** Control's run logs. */
	readonly runLogs: PlatformStorage
	/** Operations' artifacts and source maps. */
	readonly operationsBlobs: PlatformStorage
}

/** Where the installation answers. Both the bring-up and every deploy derive their variables from these. */
export interface PlatformPlacementInput {
	readonly environment: string
	readonly scheme: 'http' | 'https'
	readonly hosts: PlatformHosts
	/** The private address the platform proxy dials IAM at, which owns the session (`host:port`). */
	readonly iamUpstream: string
}

/** What `installationServiceEnvironment` needs. Everything in it is settled before the first write. */
export interface InstallationServiceInput extends PlatformPlacementInput {
	readonly secrets: InstallationSecrets
	readonly data: PlatformData
	/** IAM sends its own mail with it, and Control hands it to applications whose job declares `mailer: 'installation'`. */
	readonly email: InstallationEmail
}

/** Compared byte-for-byte against a token's `iss`, so it is the PUBLIC issuer, never the private upstream. */
const proxySessionOwner = (input: PlatformPlacementInput): string =>
	JSON.stringify({ issuer: platformOrigin(input.scheme, input.hosts.iam), upstream: input.iamUpstream })

/**
 * EVERY fabrika variable a bring-up places, per service.
 *
 * The proxy manifest is deliberately absent: the deploy owns it, in the same run as the code it
 * describes (ADR-0027).
 */
export const installationServiceEnvironment = (input: InstallationServiceInput): PlatformServiceEnvironment => {
	const { secrets, data } = input
	const iamOrigin = platformOrigin(input.scheme, input.hosts.iam)
	const operationsOrigin = platformOrigin(input.scheme, input.hosts.operations)
	const email = input.email.kind === 'none' ? [] : [...input.email.variables]
	return {
		iam: new Map([
			['FABRIKA_IAM_DATABASE_URL', data.iamDatabase],
			['ENVIRONMENT', input.environment],
			['ISSUER', iamOrigin],
			// Password only, by decision: OIDC needs an identity provider the operator has not been
			// asked for. Both are STATED because IAM's own defaults are the other way round — OIDC on,
			// password off — and it refuses to boot with neither.
			['FABRIKA_IAM_OIDC_ENABLED', 'false'],
			['FABRIKA_IAM_PASSWORD_ENABLED', 'true'],
			['FABRIKA_IAM_SIGNING_KEYS', secrets.signingKeys],
			['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
			['FABRIKA_IAM_PROXY_KEY', secrets.proxyKey],
			['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
			...email,
		]),
		operations: new Map([
			['FABRIKA_OPERATIONS_DATABASE_URL', data.operationsDatabase],
			['FABRIKA_OPERATIONS_BLOB_BUCKET', data.operationsBlobs.bucket],
			['FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID', data.operationsBlobs.accessKeyId],
			['FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY', data.operationsBlobs.secretAccessKey],
			['FABRIKA_OPERATIONS_BLOB_ENDPOINT', data.operationsBlobs.endpoint],
			['FABRIKA_OPERATIONS_PUBLIC_HOST', input.hosts.operations],
			['ENVIRONMENT', input.environment],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
			['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
		]),
		control: new Map([
			['FABRIKA_CONTROL_DATABASE_URL', data.controlDatabase],
			['ENVIRONMENT', input.environment],
			// A bare HOST, not an origin: `controlPublicOrigin` accepts either.
			['FABRIKA_CONTROL_DOMAIN', input.hosts.control],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			['OPERATIONS_ARTIFACT_ORIGIN', operationsOrigin],
			['FABRIKA_CONTROL_RUN_LOGS_BUCKET', data.runLogs.bucket],
			['FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID', data.runLogs.accessKeyId],
			['FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY', data.runLogs.secretAccessKey],
			['FABRIKA_CONTROL_RUN_LOGS_ENDPOINT', data.runLogs.endpoint],
			['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
			['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
			['FABRIKA_CONTROL_VAULT_KEY', secrets.vaultKey],
			['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
			...email,
		]),
		proxy: new Map([
			['ENVIRONMENT', input.environment],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			['FABRIKA_IAM_KEY', secrets.proxyKey],
			['FABRIKA_PROXY_SESSION_OWNER_JSON', proxySessionOwner(input)],
		]),
	}
}

/**
 * The fabrika variables whose VALUE a bring-up generates, per service.
 *
 * Their presence on a live service is what "this project already holds an installation" means, and they
 * are written as credentials. A provider adds the names of its own that carry a generated value.
 */
export const INSTALLATION_SECRET_VARIABLES: Readonly<Record<PlatformService, readonly string[]>> = {
	iam: ['FABRIKA_IAM_SIGNING_KEYS', 'FABRIKA_IAM_RPC_KEY', 'FABRIKA_IAM_PROXY_KEY', 'FABRIKA_IAM_PROVISIONING_KEY'],
	operations: ['OPERATIONS_SYNC_KEY', 'FABRIKA_IAM_RPC_KEY'],
	control: ['FABRIKA_IAM_RPC_KEY', 'OPERATIONS_SYNC_KEY', 'FABRIKA_CONTROL_VAULT_KEY', 'FABRIKA_IAM_PROVISIONING_KEY'],
	proxy: ['FABRIKA_IAM_KEY'],
}

/**
 * The secret the platform proxy sends IAM's route, so IAM honours the client address and request id only from the proxy
 * (ADR-0022 rule 5). Derived from the provisioning key, which every deploy holds, so each deploy writes the same value
 * and nothing stores or reads one back. Never from the proxy key: namespace proxies hold that one.
 */
export const deriveIamProxySecret = (provisioningKey: string): string =>
	createHmac('sha256', provisioningKey).update('fabrika-installation-proxy-secret:iam').digest('hex')

/** What a deploy derives the service environment from. */
export interface DeployedServiceInput extends PlatformPlacementInput {
	/** `FABRIKA_IAM_PROVISIONING_KEY`, which the IAM proxy secret is derived from. */
	readonly provisioningKey: string
	/** The digest of the console table the deploy's manifest publishes (`platformServiceTableDigest`). */
	readonly controlTableDigest: string
	/** Present only when the installation enables MCP authoring. */
	readonly oauthConfig?: IamOAuthConfig
}

/**
 * The per-installation configuration a deploy writes, derived from where the installation answers.
 *
 * IAM's OAuth configuration is present only when MCP authoring is enabled; without it the variable is left
 * as it is, and the manifest — whose `/mcp` row then admits no OAuth token — is what turns MCP off.
 */
export const deployedServiceEnvironment = (input: DeployedServiceInput): PlatformServiceEnvironment => {
	const iamOrigin = platformOrigin(input.scheme, input.hosts.iam)
	const iamProxySecret = deriveIamProxySecret(input.provisioningKey)
	const iam = new Map([
		['ENVIRONMENT', input.environment],
		// The `iss` of every minted token AND the OIDC redirect base, so it must be the address
		// routed to the proxy in front of this service.
		['ISSUER', iamOrigin],
		[IAM_PROXY_SECRET_VARIABLE, iamProxySecret],
	])
	if (input.oauthConfig !== undefined) {
		iam.set(IAM_OAUTH_CONFIG_VARIABLE, JSON.stringify(input.oauthConfig))
	}
	return {
		iam,
		operations: new Map([
			['ENVIRONMENT', input.environment],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			['FABRIKA_OPERATIONS_PUBLIC_HOST', input.hosts.operations],
		]),
		proxy: new Map([
			['ENVIRONMENT', input.environment],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			['FABRIKA_PROXY_SESSION_OWNER_JSON', proxySessionOwner(input)],
			// Caddy sends it on the session owner's route.
			[IAM_PROXY_SECRET_VARIABLE, iamProxySecret],
		]),
		control: new Map([
			['ENVIRONMENT', input.environment],
			['FABRIKA_IAM_ISSUER', iamOrigin],
			// A bare host: `controlPublicOrigin` accepts either spelling.
			['FABRIKA_CONTROL_DOMAIN', input.hosts.control],
			// Control picks its own table, MCP or not, by this digest, and refuses to start under another.
			[FABRIKA_SERVICE_TABLE_DIGEST, input.controlTableDigest],
			['OPERATIONS_ARTIFACT_ORIGIN', platformOrigin(input.scheme, input.hosts.operations)],
		]),
	}
}
