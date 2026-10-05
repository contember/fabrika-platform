import { z } from 'zod'
import type { AppDto } from './index.js'

export const BUILDER_CONNECTION_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const BUILDER_APPROVAL_VERIFIER = /^[A-Za-z0-9_-]{43}$/
export const BUILDER_CONNECTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface BuilderConnectionEnvironmentDto {
	readonly env: string
	readonly namespaceId: string | null
	readonly domain: string | null
	readonly publicOrigin: string | null
	readonly triggerRef: string | null
}

export interface BuilderConnectionReceiptDto {
	readonly version: 1
	readonly attemptId: string
	readonly provider: string
	readonly app: AppDto
	readonly environment: BuilderConnectionEnvironmentDto
	readonly createdAt: number
}

export interface CreateBuilderConnectionReceiptRequest {
	readonly attemptId: string
	readonly approvalVerifier: string
	readonly appId: string
	readonly environment: BuilderConnectionEnvironmentDto
}

export interface GetBuilderConnectionReceiptRequest {
	readonly attemptId: string
}

/** Decode the persisted/wire snapshot without accepting provider envelopes or credential fields. */
export function parseBuilderConnectionReceipt(value: unknown): BuilderConnectionReceiptDto {
	const result = builderConnectionReceiptSchema.safeParse(value)
	if (result.success) return result.data
	const issues = result.error.issues
	const objectIssue = (path: string) =>
		issues.some((issue) => issue.path.join('.') === path && (issue.code === 'invalid_type' || issue.code === 'unrecognized_keys'))
	if (objectIssue('')) throw new Error('invalid builder connection receipt object')
	if (issues.some((issue) => issue.path[0] === 'version')) throw new Error('unsupported builder connection receipt version')
	if (objectIssue('app') || objectIssue('environment')) throw new Error('invalid builder connection receipt object')
	if (issues.some((issue) => issue.path.join('.') === 'app.githubInstallationId')) throw new Error('invalid githubInstallationId')
	const issue = issues[0]
	throw new Error(`invalid receipt ${issue?.path.at(-1) ?? 'object'}`)
}

const receiptTimestampSchema = z.number().int().safe().nonnegative()
const receiptIdentifierSchema = z.string().regex(BUILDER_CONNECTION_IDENTIFIER)

export const builderConnectionAppSchema = z.object({
	id: receiptIdentifierSchema,
	repoUrl: z.string(),
	defaultBranch: z.string(),
	workerDir: z.string().nullable(),
	buildCmd: z.string().nullable(),
	configPath: z.string().nullable(),
	githubConnectionId: z.string().nullable().optional(),
	githubInstallationId: receiptTimestampSchema.nullable(),
	createdAt: receiptTimestampSchema,
}).strict().transform(({ githubConnectionId, githubInstallationId, createdAt, ...app }) => ({
	...app,
	...(githubConnectionId === undefined ? {} : { githubConnectionId }),
	githubInstallationId,
	createdAt,
}))

export const builderConnectionEnvironmentSchema = z.object({
	env: receiptIdentifierSchema,
	namespaceId: z.string().min(1).max(128).nullable(),
	domain: z.string().min(1).max(253).nullable(),
	publicOrigin: z.string().min(1).max(2048).nullable(),
	triggerRef: z.string().min(1).max(1024).nullable(),
}).strict()

export const builderConnectionReceiptSchema = z.object({
	version: z.literal(1),
	attemptId: z.string().regex(BUILDER_CONNECTION_ATTEMPT_ID),
	provider: receiptIdentifierSchema,
	app: builderConnectionAppSchema,
	environment: builderConnectionEnvironmentSchema,
	createdAt: receiptTimestampSchema,
}).strict()
