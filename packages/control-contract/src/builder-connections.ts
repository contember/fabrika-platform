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
	const receipt = object(value, ['version', 'attemptId', 'provider', 'app', 'environment', 'createdAt'])
	if (field(receipt, 'version') !== 1) throw new Error('unsupported builder connection receipt version')
	const app = object(field(receipt, 'app'), [
		'id',
		'repoUrl',
		'defaultBranch',
		'workerDir',
		'buildCmd',
		'configPath',
		'githubConnectionId',
		'githubInstallationId',
		'createdAt',
	])
	const environment = object(field(receipt, 'environment'), ['env', 'namespaceId', 'domain', 'publicOrigin', 'triggerRef'])
	const installation = field(app, 'githubInstallationId')
	if (installation !== null && (typeof installation !== 'number' || !Number.isSafeInteger(installation) || installation < 0)) {
		throw new Error('invalid githubInstallationId')
	}
	return {
		version: 1,
		attemptId: matching(receipt, 'attemptId', BUILDER_CONNECTION_ATTEMPT_ID),
		provider: matching(receipt, 'provider', BUILDER_CONNECTION_IDENTIFIER),
		app: {
			id: matching(app, 'id', BUILDER_CONNECTION_IDENTIFIER),
			repoUrl: string(app, 'repoUrl'),
			defaultBranch: string(app, 'defaultBranch'),
			workerDir: nullableString(app, 'workerDir'),
			buildCmd: nullableString(app, 'buildCmd'),
			configPath: nullableString(app, 'configPath'),
			...(field(app, 'githubConnectionId') === undefined ? {} : { githubConnectionId: nullableString(app, 'githubConnectionId') }),
			githubInstallationId: installation,
			createdAt: timestamp(app),
		},
		environment: {
			env: matching(environment, 'env', BUILDER_CONNECTION_IDENTIFIER),
			namespaceId: nullableString(environment, 'namespaceId', 128),
			domain: nullableString(environment, 'domain', 253),
			publicOrigin: nullableString(environment, 'publicOrigin', 2048),
			triggerRef: nullableString(environment, 'triggerRef', 1024),
		},
		createdAt: timestamp(receipt),
	}
}

function object(value: unknown, keys: readonly string[]): object {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
		throw new Error('invalid builder connection receipt object')
	}
	return value
}

function field(value: object, key: string): unknown {
	return Reflect.get(value, key)
}

function string(value: object, key: string): string {
	const result = field(value, key)
	if (typeof result !== 'string') throw new Error(`invalid receipt ${key}`)
	return result
}

function matching(value: object, key: string, pattern: RegExp): string {
	const result = string(value, key)
	if (!pattern.test(result)) throw new Error(`invalid receipt ${key}`)
	return result
}

function nullableString(value: object, key: string, maxLength?: number): string | null {
	if (field(value, key) === null) return null
	const result = string(value, key)
	if (maxLength !== undefined && (result.length === 0 || result.length > maxLength)) throw new Error(`invalid receipt ${key}`)
	return result
}

function timestamp(value: object): number {
	const result = field(value, 'createdAt')
	if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new Error('invalid receipt createdAt')
	return result
}
