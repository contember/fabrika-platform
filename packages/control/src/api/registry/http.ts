import type {
	AppOptionalFields,
	CreateAppRequest,
	PutAppEnvRequest,
	PutAppSecretRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	UpdateAppRequest,
} from '@fabrika/control-contract'
import { readJson } from '../../http'
import { booleanField, nullableStringField, numberField, prop, stringField } from '../../json'
import { fail, jsonAdapter } from '../domain'
import { readProviderEnvelope } from '../provider-envelope'
import { createAppUseCase, deleteAppUseCase, getAppUseCase, listAppsUseCase, updateAppUseCase } from './apps'
import {
	deleteAppSecretUseCase,
	deleteAppVarUseCase,
	listAppSecretsUseCase,
	listAppVarsUseCase,
	putAppSecretUseCase,
	putAppVarUseCase,
} from './configuration'
import { type RegistryContext, useCaseContext } from './context'
import { deleteAppEnvUseCase, listAppEnvsUseCase, putAppEnvUseCase } from './environments'
import { registerAppUseCase } from './registration'
import { assertAppVarValue, assertOwnedValueRef } from './validation'

export async function listApps(c: RegistryContext): Promise<Response> {
	return jsonAdapter(() => listAppsUseCase(useCaseContext(c)))
}

export async function getApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(() => getAppUseCase(useCaseContext(c), id))
}

export async function createApp(c: RegistryContext): Promise<Response> {
	return jsonAdapter(async () => createAppUseCase(useCaseContext(c), parseCreateApp(await readJson(c.request))), { status: 201 })
}

export async function updateApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(async () => updateAppUseCase(useCaseContext(c), id, parseUpdateApp(await readJson(c.request))))
}

export async function deleteApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(() => deleteAppUseCase(useCaseContext(c), id))
}

export async function listAppEnvs(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppEnvsUseCase(useCaseContext(c), appId))
}

export async function putAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	return jsonAdapter(async () => putAppEnvUseCase(useCaseContext(c), appId, env, parsePutAppEnv(await readJson(c.request))))
}

export async function deleteAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	return jsonAdapter(() => deleteAppEnvUseCase(useCaseContext(c), appId, env))
}

export async function listAppSecrets(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppSecretsUseCase(useCaseContext(c), appId))
}

export async function putAppSecret(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(async () => putAppSecretUseCase(useCaseContext(c), appId, parsePutSecret(await readJson(c.request))))
}

export async function deleteAppSecret(c: RegistryContext, appId: string, name: string): Promise<Response> {
	const env = queryLayer(c.url)
	return jsonAdapter(() => deleteAppSecretUseCase(useCaseContext(c), appId, name, env))
}

export async function listAppVars(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppVarsUseCase(useCaseContext(c), appId))
}

export async function putAppVar(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(async () => putAppVarUseCase(useCaseContext(c), appId, parsePutVar(await readJson(c.request))))
}

export async function deleteAppVar(c: RegistryContext, appId: string, name: string): Promise<Response> {
	const env = queryLayer(c.url)
	return jsonAdapter(() => deleteAppVarUseCase(useCaseContext(c), appId, name, env))
}

export async function registerApp(c: RegistryContext): Promise<Response> {
	return jsonAdapter(async () => registerAppUseCase(useCaseContext(c), parseRegisterApp(await readJson(c.request))), { status: 201 })
}

function parseCreateApp(body: unknown): CreateAppRequest {
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	if (!id || !repoUrl) fail(400, 'id and repoUrl required')
	return { id, repoUrl, ...parseAppOptionalFields(body) }
}

function parseUpdateApp(body: unknown): UpdateAppRequest {
	const repoUrl = stringField(body, 'repoUrl')
	return { ...(repoUrl === undefined ? {} : { repoUrl }), ...parseAppOptionalFields(body) }
}

function parseAppOptionalFields(body: unknown): AppOptionalFields {
	const defaultBranch = stringField(body, 'defaultBranch')
	const workerDir = nullableStringField(body, 'workerDir')
	const buildCmd = nullableStringField(body, 'buildCmd')
	const configPath = nullableStringField(body, 'configPath')
	const githubInstallationId = numberField(body, 'githubInstallationId')
	const resolveInstallationId = booleanField(body, 'resolveInstallationId')
	return {
		...(defaultBranch === undefined ? {} : { defaultBranch }),
		...(workerDir === undefined ? {} : { workerDir }),
		...(buildCmd === undefined ? {} : { buildCmd }),
		...(configPath === undefined ? {} : { configPath }),
		...(githubInstallationId === undefined ? {} : { githubInstallationId }),
		...(resolveInstallationId === undefined ? {} : { resolveInstallationId }),
	}
}

function parsePutAppEnv(body: unknown): PutAppEnvRequest {
	const target = readProviderEnvelope(prop(body, 'target'))
	const artifact = readProviderEnvelope(prop(body, 'artifact'))
	if (target === null) fail(400, 'target must be a versioned provider envelope')
	if (artifact === null) fail(400, 'artifact must be a versioned provider envelope')
	const domain = nullableStringField(body, 'domain')
	const rawPublicOrigin = prop(body, 'publicOrigin')
	if (rawPublicOrigin !== undefined && rawPublicOrigin !== null && typeof rawPublicOrigin !== 'string') {
		fail(400, 'publicOrigin must be an exact HTTP(S) origin')
	}
	const publicOrigin = nullableStringField(body, 'publicOrigin')
	const triggerRef = nullableStringField(body, 'triggerRef')
	const rawNamespaceId = prop(body, 'namespaceId')
	const namespaceId = nullableStringField(body, 'namespaceId')
	if (rawNamespaceId !== undefined && (namespaceId === undefined || namespaceId === '')) {
		fail(400, 'namespaceId must be a non-empty string or null')
	}
	return {
		target,
		artifact,
		...(domain === undefined ? {} : { domain }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
		...(triggerRef === undefined ? {} : { triggerRef }),
		...(namespaceId === undefined ? {} : { namespaceId }),
	}
}

function parsePutSecret(body: unknown): PutAppSecretRequest {
	const name = stringField(body, 'name')
	const valueRef = stringField(body, 'valueRef')
	if (!name || !valueRef) fail(400, 'name and valueRef required (valueRef is a backend reference, never the value)')
	assertOwnedValueRef(valueRef)
	const env = nullableStringField(body, 'env')
	return { name, valueRef, ...(env === undefined ? {} : { env }) }
}

function parsePutVar(body: unknown): PutAppVarRequest {
	const name = stringField(body, 'name')
	const value = stringField(body, 'value')
	if (!name || !value) fail(400, 'name and value required (value is plaintext config — use a secret for sensitive values)')
	assertAppVarValue(value)
	const env = nullableStringField(body, 'env')
	return { name, value, ...(env === undefined ? {} : { env }) }
}

function parseRegisterApp(body: unknown): RegisterAppRequest {
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	const env = stringField(body, 'env')
	if (!id || !repoUrl || !env) fail(400, 'id, repoUrl and env required')
	const registration = parsePutAppEnv(body)
	return { id, repoUrl, env, ...registration, ...parseAppOptionalFields(body) }
}

function queryLayer(url: URL): string | null {
	const value = url.searchParams.get('env')
	return value === null || value === '' ? null : value
}
