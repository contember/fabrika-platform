import type { BuilderConnectionEnvironmentDto, BuilderConnectionReceiptDto, CreateBuilderConnectionReceiptRequest } from '@fabrika/control-contract'
import { ACTIONS } from '../actions'
import type { StoredBuilderConnectionReceipt } from '../db/builder-connections'
import { appScope } from '../iam'
import { type BuilderPairingContext, requireBuilderPairingProof } from './builder-pairing'
import { fail } from './domain'
import { requireApp, toAppDto } from './registry/apps'
import type { RegistryUseCaseContext } from './registry/context'
import { resolveRegistrationNamespace } from './registry/registration'
import { assertAppEnvironmentPart, assertProxyDomain, canonicalOrigin } from './registry/validation'

export async function getBuilderConnectionReceipt(c: RegistryUseCaseContext, attemptId: string): Promise<BuilderConnectionReceiptDto> {
	const receipt = await c.repositories.builderConnections.get(attemptId)
	if (receipt === null || !c.auth.can(ACTIONS.APP_MANAGE, appScope(receipt.app.id))) fail(404, 'builder connection receipt not found')
	return receipt
}

export async function createBuilderConnectionReceipt(
	c: RegistryUseCaseContext,
	pairing: BuilderPairingContext,
	input: CreateBuilderConnectionReceiptRequest,
): Promise<BuilderConnectionReceiptDto> {
	if (c.auth.principal?.type !== 'user') fail(403, 'builder connection approval requires a human')
	if (!c.auth.can(ACTIONS.APP_MANAGE, appScope(input.appId))) fail(403, 'not authorized: app.manage')
	const creatorId = await requireBuilderPairingProof(pairing, { attemptId: input.attemptId, approvalVerifier: input.approvalVerifier })
	const requestKey = receiptRequestKey(input)
	const previous = await c.repositories.builderConnections.find(input.attemptId)
	if (previous !== null) return matchRetry(previous, requestKey, creatorId)
	const app = await requireApp(c, input.appId)
	const requested = input.environment
	const existing = await c.repositories.registry.getAppEnv(input.appId, requested.env)
	const environment: BuilderConnectionEnvironmentDto = {
		env: requested.env,
		namespaceId: requested.namespaceId,
		domain: requested.domain,
		publicOrigin: canonicalOrigin(requested.publicOrigin, null),
		triggerRef: requested.triggerRef,
	}
	assertAppEnvironmentPart('environment', environment.env)
	assertProxyDomain(environment.domain)
	if (existing !== null) {
		if (
			existing.provider !== c.provider.id || existing.namespace_id !== environment.namespaceId || existing.domain !== environment.domain
			|| existing.public_origin !== environment.publicOrigin || existing.trigger_ref !== environment.triggerRef
		) fail(409, 'existing environment does not match the selected placement')
	} else {
		if (!c.auth.can(ACTIONS.NAMESPACE_MANAGE)) fail(403, 'not authorized: namespace.manage')
		await resolveRegistrationNamespace(c, environment.namespaceId, input.appId, environment.env, null)
	}
	const stored = await c.repositories.builderConnections.create(
		{
			version: 1,
			attemptId: input.attemptId,
			provider: c.provider.id,
			app: toAppDto(app),
			environment,
		},
		requestKey,
		creatorId,
	)
	return matchRetry(stored, requestKey, creatorId)
}

function matchRetry(stored: StoredBuilderConnectionReceipt, requestKey: string, creatorId: string): BuilderConnectionReceiptDto {
	if (stored.requestKey !== requestKey || stored.creatorId !== creatorId) fail(409, 'attemptId already has a different builder connection receipt')
	return stored.receipt
}

/** Only non-secret selection participates in durable retry identity. */
function receiptRequestKey(input: CreateBuilderConnectionReceiptRequest): string {
	return JSON.stringify({
		appId: input.appId,
		env: input.environment.env,
		namespaceId: input.environment.namespaceId,
		domain: input.environment.domain,
		publicOrigin: canonicalOrigin(input.environment.publicOrigin, null),
		triggerRef: input.environment.triggerRef,
	})
}
