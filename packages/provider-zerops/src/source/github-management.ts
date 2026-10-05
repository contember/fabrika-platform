import { z } from 'zod'
import {
	GITHUB_LOGIN_PATTERN,
	GITHUB_OWNER_PATTERN,
	ID_PATTERN,
	MAX_ID_LENGTH,
	MAX_INSTALLATION_REPOSITORIES,
	MAX_WEBHOOK_SECRET_LENGTH,
	MAX_WEBHOOK_URL_LENGTH,
	ZEROPS_SOURCE_PROTOCOL_VERSION,
} from './constants'
import type {
	ZeropsSourceInstallationsVerifyInput,
	ZeropsSourceInstallationsVerifyRequestV1,
	ZeropsSourceInstallationsVerifyResponseV1,
	ZeropsSourceWebhookConfigureInput,
	ZeropsSourceWebhookConfigureRequestV1,
	ZeropsSourceWebhookConfigureResponseV1,
} from './types'
import { identifierSchema, installationIdSchema, parseSourceWire, repositorySchema, sha256Schema } from './validation'

const WEBHOOK_PATH = '/webhooks/github'

/** The bare path belongs to Cloudflare; Zerops requires one connection id (ADR-0039). */
const isWebhookPath = (pathname: string): boolean => {
	if (!pathname.startsWith(`${WEBHOOK_PATH}/`)) return false
	const connectionId = pathname.slice(WEBHOOK_PATH.length + 1)
	// ID_PATTERN excludes percent-escapes, so encoded separators cannot round-trip.
	return connectionId.length > 0 && connectionId.length <= MAX_ID_LENGTH && ID_PATTERN.test(connectionId)
}

const webhookUrlSchema = z.string().min(1).max(MAX_WEBHOOK_URL_LENGTH).refine((candidate) => {
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		return false
	}
	return parsed.protocol === 'https:' && parsed.port === '' && parsed.username === '' && parsed.password === ''
		&& parsed.search === '' && parsed.hash === '' && isWebhookPath(parsed.pathname) && parsed.hostname !== '' && candidate === parsed.href
}, 'must be an exact secure GitHub webhook URL')

const connectionSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION),
	connectionId: identifierSchema,
	credentialSha256: sha256Schema,
}).strict()
const webhookConfigureRequestSchema = connectionSchema.extend({
	url: webhookUrlSchema,
	secret: z.string().min(1).max(MAX_WEBHOOK_SECRET_LENGTH).refine(
		(secret) => ![...secret].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f),
		'webhook secret is invalid',
	),
})
const webhookConfigureResponseSchema = connectionSchema.extend({
	webhook: z.object({ url: webhookUrlSchema, contentType: z.literal('json'), insecureSsl: z.literal('0') }).strict(),
})
const installationScopeSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('organization'),
		organization: z.string().min(1).max(39).toLowerCase().regex(GITHUB_OWNER_PATTERN),
	}).strict(),
	z.object({
		kind: z.literal('repositories'),
		repositories: z.array(repositorySchema).min(1).max(MAX_INSTALLATION_REPOSITORIES).refine(
			(repositories) => new Set(repositories.map((entry) => `${entry.owner}/${entry.name}`)).size === repositories.length,
			'repositories contains a duplicate',
		),
	}).strict(),
])
const installationsVerifyRequestSchema = connectionSchema.extend({ scope: installationScopeSchema })
const installationVerificationSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('missing') }).strict(),
	z.object({
		status: z.literal('installed'),
		installationId: installationIdSchema,
		accountLogin: z.string().min(1).max(100).regex(GITHUB_LOGIN_PATTERN),
		repositorySelection: z.enum(['all', 'selected']),
	}).strict(),
])
const installationsVerifyResponseSchema = connectionSchema.extend({ installation: installationVerificationSchema })

export function decodeZeropsSourceWebhookConfigureRequest(value: unknown): ZeropsSourceWebhookConfigureRequestV1 {
	return parseSourceWire(webhookConfigureRequestSchema, value, 'source webhook configure request')
}

export function buildZeropsSourceWebhookConfigureRequest(input: ZeropsSourceWebhookConfigureInput): ZeropsSourceWebhookConfigureRequestV1 {
	return decodeZeropsSourceWebhookConfigureRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		url: input.url,
		secret: input.secret,
	})
}

export function decodeZeropsSourceWebhookConfigureResponse(value: unknown): ZeropsSourceWebhookConfigureResponseV1 {
	return parseSourceWire(webhookConfigureResponseSchema, value, 'source webhook configure response')
}

export function buildZeropsSourceWebhookConfigureResponse(
	input: Omit<ZeropsSourceWebhookConfigureResponseV1, 'protocolVersion'>,
): ZeropsSourceWebhookConfigureResponseV1 {
	return decodeZeropsSourceWebhookConfigureResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}

export function decodeZeropsSourceInstallationsVerifyRequest(value: unknown): ZeropsSourceInstallationsVerifyRequestV1 {
	return parseSourceWire(installationsVerifyRequestSchema, value, 'source installations verify request')
}

export function buildZeropsSourceInstallationsVerifyRequest(input: ZeropsSourceInstallationsVerifyInput): ZeropsSourceInstallationsVerifyRequestV1 {
	return decodeZeropsSourceInstallationsVerifyRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		scope: input.scope,
	})
}

export function decodeZeropsSourceInstallationsVerifyResponse(value: unknown): ZeropsSourceInstallationsVerifyResponseV1 {
	return parseSourceWire(installationsVerifyResponseSchema, value, 'source installations verify response')
}

export function buildZeropsSourceInstallationsVerifyResponse(
	input: Omit<ZeropsSourceInstallationsVerifyResponseV1, 'protocolVersion'>,
): ZeropsSourceInstallationsVerifyResponseV1 {
	return decodeZeropsSourceInstallationsVerifyResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}
