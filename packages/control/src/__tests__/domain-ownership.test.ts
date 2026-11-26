// A domain serves one application environment of the whole installation, on every provider and across namespaces, and
// the installation's own hosts (IAM, the console and Control) and every name under them are no application's. The
// registry refuses before it writes; `idx_app_envs_domain` refuses the write that lost a race to the check.

import type { ControlProvider, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import type { RegistryUseCaseContext } from '../api/registry/context'
import { reservedInstallationHosts } from '../api/registry/domain-ownership'
import { putAppEnvUseCase } from '../api/registry/environments'
import { registerAppUseCase } from '../api/registry/registration'
import { AppEnvDomainConflictError, type ControlRepositories } from '../db'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { fakeControlProvider, providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

const CONSOLE = 'https://console.example.com'
const IAM = 'https://iam.example.com'
const HELD = 'is already held by another application environment; a domain serves one environment of the installation'

const envelope = (kind: string): ProviderEnvelope => ({ provider: TEST_PROVIDER_ID, version: 1, payload: { kind } })
const placement = { target: envelope('target'), artifact: envelope('artifact') }

/** A provider with no namespace capability, as Cloudflare's: nothing but Control judges a domain there. */
function deps(repositories: ControlRepositories, provider: ControlProvider = fakeControlProvider): ControlRpcDeps {
	return {
		repositories,
		auth: allowAllAuth(),
		queue: { send: () => Promise.resolve() },
		logs: { get: () => Promise.resolve(null) },
		provider,
		cancelRun: () => Promise.resolve(),
	}
}

function context(repositories: ControlRepositories, reservedHosts: readonly string[] = []): RegistryUseCaseContext {
	const admission = { request: new Request('https://control.test/api/rpc', { method: 'POST' }) }
	return { repositories, provider: fakeControlProvider, auth: allowAllAuth(), admission, signal: new AbortController().signal, reservedHosts }
}

const register = (made: ControlRpcDeps, id: string, domain: string) =>
	rpcResult(rpcRequest('register', { id, repoUrl: `https://github.com/acme/${id}`, env: 'prod', domain, ...placement }), made, {
		consoleOrigin: CONSOLE,
		iamIssuer: IAM,
	})

const put = (made: ControlRpcDeps, appId: string, env: string, domain: string) =>
	rpcResult(rpcRequest('apps.environments.put', { appId, env, environment: { domain, ...placement } }), made, {
		consoleOrigin: CONSOLE,
		iamIssuer: IAM,
	})

async function errorOf(response: Response): Promise<string> {
	const body: unknown = await response.json()
	return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : ''
}

async function refusal(promise: Promise<unknown>): Promise<ControlApiError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof ControlApiError) return error
		throw error
	}
	throw new Error('expected a refusal')
}

describe('a domain held by another application environment', () => {
	test('is refused to a new application and to another environment, compared without case, and nothing is written', async () => {
		const { repositories } = createHarness()
		const made = deps(repositories)
		expect((await register(made, 'shop', 'shop.example.com')).status).toBe(200)

		const taken = await register(made, 'thief', 'SHOP.example.com')
		expect(taken.status).toBe(409)
		expect(await errorOf(taken)).toBe(`domain SHOP.example.com ${HELD}`)
		expect(await repositories.registry.getApp('thief')).toBeNull()

		expect((await register(made, 'other', 'other.example.com')).status).toBe(200)
		const moved = await put(made, 'other', 'prod', 'shop.example.com')
		expect(moved.status).toBe(409)
		expect((await repositories.registry.getAppEnv('other', 'prod'))?.domain).toBe('other.example.com')
		const added = await put(made, 'other', 'stage', 'Shop.Example.Com')
		expect(added.status).toBe(409)
		expect(await repositories.registry.getAppEnv('other', 'stage')).toBeNull()
		// Another environment of the SAME application is refused too: a domain serves one environment.
		expect((await put(made, 'shop', 'stage', 'shop.example.com')).status).toBe(409)
	})

	test('stays with its holder: a re-put keeps it, and once the holder lets it go another environment may take it', async () => {
		const { repositories } = createHarness()
		const made = deps(repositories)
		expect((await register(made, 'shop', 'shop.example.com')).status).toBe(200)
		expect((await put(made, 'shop', 'prod', 'shop.example.com')).status).toBe(200)

		expect((await put(made, 'shop', 'prod', 'shop-old.example.com')).status).toBe(200)
		expect((await register(made, 'next', 'shop.example.com')).status).toBe(200)
		expect((await repositories.registry.getAppEnv('next', 'prod'))?.domain).toBe('shop.example.com')
	})
})

describe("the installation's own hosts", () => {
	test('reads Control (the console) and IAM from the environment, lowercase, skipping what names no host', () => {
		expect(reservedInstallationHosts({ FABRIKA_CONTROL_DOMAIN: 'Console.Example.com', FABRIKA_IAM_ISSUER: 'https://IAM.example.com/' })).toEqual([
			'console.example.com',
			'iam.example.com',
		])
		expect(reservedInstallationHosts({ FABRIKA_IAM_ISSUER: 'not a url' })).toEqual([])
		expect(reservedInstallationHosts({})).toEqual([])
	})

	test('are refused, with every name under them, to a registration and a put', async () => {
		const { repositories } = createHarness()
		const made = deps(repositories)
		for (const domain of ['console.example.com', 'IAM.example.com', 'x.iam.example.com', 'a.b.console.example.com']) {
			const registered = await register(made, 'thief', domain)
			expect(`${domain}: ${registered.status}`).toBe(`${domain}: 409`)
			expect(await errorOf(registered)).toContain("the installation's own host")
		}
		expect(await repositories.registry.getApp('thief')).toBeNull()

		expect((await register(made, 'shop', 'shop.example.com')).status).toBe(200)
		const moved = await put(made, 'shop', 'prod', 'iam.example.com')
		expect(moved.status).toBe(409)
		expect(await errorOf(moved)).toBe("domain iam.example.com is the installation's own host iam.example.com, which no application may take")
		expect((await repositories.registry.getAppEnv('shop', 'prod'))?.domain).toBe('shop.example.com')
		// A sibling of a reserved host, and a name that only ends with its text, are an application's to take.
		expect((await put(made, 'shop', 'prod', 'example.com')).status).toBe(200)
		expect((await put(made, 'shop', 'prod', 'notiam.example.com')).status).toBe(200)
	})
})

describe('a race between two writes of one domain', () => {
	/** The registry check reads no other domain, as a check racing the write that took it would. */
	function staleChecks(repositories: ControlRepositories): ControlRepositories {
		repositories.registry.listOtherAppEnvDomains = () => Promise.resolve([])
		return repositories
	}

	test('the index refuses the write that lost, as a 409, and writes nothing of it', async () => {
		const { repositories } = createHarness()
		await registerAppUseCase(context(repositories), {
			id: 'shop',
			repoUrl: 'https://github.com/acme/shop',
			env: 'prod',
			domain: 'shop.example.com',
			...placement,
		})
		await registerAppUseCase(context(repositories), { id: 'other', repoUrl: 'https://github.com/acme/other', env: 'prod', ...placement })
		const racing = context(staleChecks(repositories))

		const registered = await refusal(
			registerAppUseCase(racing, { id: 'thief', repoUrl: 'https://github.com/acme/thief', env: 'prod', domain: 'SHOP.example.com', ...placement }),
		)
		expect(registered.httpStatus).toBe(409)
		expect(registered.message).toBe(`domain SHOP.example.com ${HELD}`)
		expect(await repositories.registry.getApp('thief')).toBeNull()

		const moved = await refusal(putAppEnvUseCase(racing, 'other', 'prod', { domain: 'shop.example.com', ...placement }))
		expect(moved.httpStatus).toBe(409)
		expect((await repositories.registry.getAppEnv('other', 'prod'))?.domain).toBeNull()
	})

	test('the repository names the conflict on a plain write', async () => {
		const { repositories } = createHarness()
		await repositories.registry.createApp({ id: 'shop', repoUrl: 'github.com/acme/shop' })
		await repositories.registry.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
		await repositories.registry.upsertAppEnv(providerEnvironment('shop', 'prod', { domain: 'shop.example.com' }))

		const write = repositories.registry.upsertAppEnv(providerEnvironment('other', 'prod', { domain: 'Shop.example.com' }), { absent: true })

		await expect(write).rejects.toBeInstanceOf(AppEnvDomainConflictError)
		expect(await repositories.registry.getAppEnv('other', 'prod')).toBeNull()
		// Environments without a domain are not one domain.
		await repositories.registry.upsertAppEnv(providerEnvironment('other', 'prod', { domain: null }))
		await repositories.registry.upsertAppEnv(providerEnvironment('other', 'stage', { domain: null }))
	})
})
