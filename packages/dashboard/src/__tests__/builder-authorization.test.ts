import { BUILDER_APPROVAL_STORAGE_KEY } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError, type AppDto, type AppEnvDto, type BuilderConnectionReceiptDto, type ControlFetch, createControlClient } from '../lib/api'
import {
	approvalProof,
	approveBuilderSelection,
	builderRequestError,
	clearBuilderApproval,
	currentBuilderEnvironment,
	isBuilderWriteConflict,
	loadKnownBuilderApp,
	readBuilderApproval,
	recoverBuilderCreation,
	revokeBuilderConnection,
} from '../lib/builder-authorization'
import { BuilderConsentReview } from '../routes/builder/authorize'

const state = { attemptId: '0194d95c-9a00-7000-8000-000000000001', approvalVerifier: 'a'.repeat(43), expiresAt: 1500 }
const app: AppDto = {
	id: 'shop',
	repoUrl: 'https://github.com/example/shop',
	defaultBranch: 'main',
	workerDir: null,
	buildCmd: null,
	configPath: null,
	githubInstallationId: null,
	createdAt: 1,
}
const existing: AppEnvDto = {
	appId: app.id,
	env: 'prod',
	namespaceId: 'prepared-prod',
	domain: 'shop.example.com',
	publicOrigin: 'https://public.example.com',
	triggerRef: 'refs/tags/v*',
	authoring: false,
	provider: 'zerops',
	target: { provider: 'zerops', version: 2, payload: {} },
	artifact: { provider: 'zerops', version: 2, payload: {} },
	createdAt: 1,
}
const receipt: BuilderConnectionReceiptDto = {
	version: 1,
	attemptId: state.attemptId,
	provider: 'zerops',
	app,
	environment: currentBuilderEnvironment(existing),
	createdAt: 1,
}
const input = { ...approvalProof(state), appId: app.id, environment: receipt.environment }

function storage(initial: string | null) {
	let value = initial
	return {
		getItem(key: string) {
			expect(key).toBe(BUILDER_APPROVAL_STORAGE_KEY)
			return value
		},
		removeItem(key: string) {
			expect(key).toBe(BUILDER_APPROVAL_STORAGE_KEY)
			value = null
		},
	}
}

interface Call {
	method: string
	input: unknown
}
function transport(calls: Call[], reply: (call: Call) => Response): ControlFetch {
	return async (url, init) => {
		expect(url).toBe('/api/rpc')
		expect(String(url)).not.toContain(state.approvalVerifier)
		if (typeof init?.body !== 'string') throw new Error('missing RPC body')
		const value: unknown = JSON.parse(init.body)
		if (typeof value !== 'object' || value === null || !('method' in value) || typeof value.method !== 'string' || !('input' in value)) {
			throw new Error('invalid RPC envelope')
		}
		const call = { method: value.method, input: value.input }
		calls.push(call)
		return reply(call)
	}
}

describe('builder approval tab custody', () => {
	test('resumes valid tab state without moving or consuming the proof', () => {
		const tab = storage(JSON.stringify(state))
		expect(readBuilderApproval(() => tab, 1000)).toEqual({ ok: true, state })
		expect(readBuilderApproval(() => tab, 1100)).toEqual({ ok: true, state })
		expect(approvalProof(state)).toEqual({ attemptId: state.attemptId, approvalVerifier: state.approvalVerifier })
		expect(clearBuilderApproval(() => tab)).toBe(true)
		expect(readBuilderApproval(() => tab, 1100)).toMatchObject({ ok: false })
	})
	test('expired, malformed and unexpected fields are removed, with safe restart instructions', () => {
		for (const raw of [JSON.stringify({ ...state, expiresAt: 1000 }), '{broken', JSON.stringify({ ...state, token: 'px_secret' })]) {
			const tab = storage(raw)
			const result = readBuilderApproval(() => tab, 1000)
			expect(result.ok).toBe(false)
			expect(JSON.stringify(result)).toContain('Start again')
			expect(JSON.stringify(result)).not.toContain(state.approvalVerifier)
			expect(tab.getItem(BUILDER_APPROVAL_STORAGE_KEY)).toBeNull()
		}
	})
	test('storage access and removal failures fail closed', () => {
		expect(readBuilderApproval(() => {
			throw new Error(state.approvalVerifier)
		}, 1000)).toEqual({ ok: false, message: 'Tab storage is unavailable. Close this tab, allow session storage and start again locally.' })
		const blocked = {
			getItem: () => 'invalid',
			removeItem: () => {
				throw new Error('blocked')
			},
		}
		expect(readBuilderApproval(() => blocked, 1000)).toMatchObject({ ok: false })
		expect(clearBuilderApproval(() => blocked)).toBe(false)
	})
})

describe('builder receipt and approval sequencing', () => {
	test('persists and reports the receipt before approval, sending proof only in RPC bodies', async () => {
		const calls: Call[] = []
		const phases: string[] = []
		const client = createControlClient(transport(calls, ({ method }) => {
			phases.push(method)
			return Response.json({ result: method === 'builderConnections.createReceipt' ? receipt : { ok: true, consent: {} } })
		}))
		await approveBuilderSelection(client, input, (saved) => {
			expect(saved).toEqual(receipt)
			phases.push('receipt-visible')
		})
		expect(phases).toEqual(['builderConnections.createReceipt', 'receipt-visible', 'builderPairing.approve'])
		expect(calls).toEqual([{ method: 'builderConnections.createReceipt', input }, { method: 'builderPairing.approve', input: approvalProof(state) }])
	})
	test('receipt failure never approves or creates/replaces an application', async () => {
		const calls: Call[] = []
		let saved = false
		const client = createControlClient(
			transport(calls, () => Response.json({ error: { type: 'conflict', message: 'selection changed' } }, { status: 409 })),
		)
		await expect(approveBuilderSelection(client, input, () => {
			saved = true
		})).rejects.toThrow()
		expect(saved).toBe(false)
		expect(calls.map((call) => call.method)).toEqual(['builderConnections.createReceipt'])
	})
	test('approval failure retains the observable receipt and retries the identical selection', async () => {
		const calls: Call[] = []
		const saved: BuilderConnectionReceiptDto[] = []
		const client = createControlClient(
			transport(
				calls,
				({ method }) => Response.json({ result: method === 'builderConnections.createReceipt' ? receipt : { ok: false, reason: 'not_allowed' } }),
			),
		)
		expect(await approveBuilderSelection(client, input, (value) => saved.push(value))).toEqual({ ok: false, reason: 'not_allowed' })
		expect(saved).toEqual([receipt])
		await approveBuilderSelection(client, input, () => undefined)
		expect(calls[0]).toEqual(calls[2])
	})
	test('lost approval response leaves a receipt for recovery', async () => {
		let saved: BuilderConnectionReceiptDto | null = null
		const client = createControlClient(transport([], ({ method }) => {
			if (method === 'builderPairing.approve') throw new Error('offline')
			return Response.json({ result: receipt })
		}))
		await expect(approveBuilderSelection(client, input, (value) => {
			saved = value
		})).rejects.toThrow('Network request failed')
		expect(saved).toEqual(receipt)
	})
})

describe('builder correction after rejected writes', () => {
	test('stale placement can be corrected only after receipt lookup confirms absence', async () => {
		const calls: Call[] = []
		let canChangeSelection = false
		let conflict = true
		const corrected = { ...input, environment: { ...input.environment, triggerRef: null } }
		const correctedReceipt = { ...receipt, environment: corrected.environment }
		const client = createControlClient(transport(calls, ({ method }) => {
			if (method === 'builderConnections.getReceipt') return Response.json({ error: { type: 'not_found', message: 'absent' } }, { status: 404 })
			if (method === 'builderConnections.createReceipt') {
				return conflict
					? Response.json({ error: { type: 'conflict', message: 'stale placement' } }, { status: 409 })
					: Response.json({ result: correctedReceipt })
			}
			return Response.json({ result: { ok: true, consent: {} } })
		}))
		await expect(approveBuilderSelection(client, input, () => {
			throw new Error('no receipt should be saved')
		}, () => {
			canChangeSelection = true
		})).rejects.toThrow('stale placement')
		expect(canChangeSelection).toBe(true)
		expect(calls.map((call) => call.method)).toEqual(['builderConnections.createReceipt', 'builderConnections.getReceipt'])
		conflict = false
		await approveBuilderSelection(client, corrected, (saved) => expect(saved).toEqual(correctedReceipt))
		expect(calls).toEqual([
			{ method: 'builderConnections.createReceipt', input },
			{ method: 'builderConnections.getReceipt', input: { attemptId: state.attemptId } },
			{ method: 'builderConnections.createReceipt', input: corrected },
			{ method: 'builderPairing.approve', input: approvalProof(state) },
		])
	})

	test('a saved conflicting receipt stays frozen and is exposed for review without approval', async () => {
		const calls: Call[] = []
		const recovered: BuilderConnectionReceiptDto[] = []
		let canChangeSelection = false
		const client = createControlClient(transport(calls, ({ method }) =>
			method === 'builderConnections.createReceipt'
				? Response.json({ error: { type: 'conflict', message: 'existing receipt' } }, { status: 409 })
				: Response.json({ result: receipt })))
		await expect(approveBuilderSelection(client, input, (saved) => recovered.push(saved), () => {
			canChangeSelection = true
		})).rejects.toThrow()
		expect(recovered).toEqual([receipt])
		expect(canChangeSelection).toBe(false)
		expect(calls.map((call) => call.method)).toEqual(['builderConnections.createReceipt', 'builderConnections.getReceipt'])
	})

	test('receipt write or lookup network failure never releases correction or approves', async () => {
		for (const failureAt of ['builderConnections.createReceipt', 'builderConnections.getReceipt']) {
			const calls: Call[] = []
			let canChangeSelection = false
			const client = createControlClient(transport(calls, ({ method }) => {
				if (method === failureAt) throw new Error('offline')
				return Response.json({ error: { type: 'conflict', message: 'stale placement' } }, { status: 409 })
			}))
			await expect(approveBuilderSelection(client, input, () => undefined, () => {
				canChangeSelection = true
			})).rejects.toThrow('Network request failed')
			expect(canChangeSelection).toBe(false)
			expect(calls.map((call) => call.method)).toEqual(
				failureAt === 'builderConnections.createReceipt'
					? ['builderConnections.createReceipt']
					: ['builderConnections.createReceipt', 'builderConnections.getReceipt'],
			)
		}
	})

	test('approval rejection after a saved receipt never releases its selection', async () => {
		const calls: Call[] = []
		let canChangeSelection = false
		const saved: BuilderConnectionReceiptDto[] = []
		const client = createControlClient(transport(calls, ({ method }) =>
			method === 'builderConnections.createReceipt'
				? Response.json({ result: receipt })
				: Response.json({ error: { type: 'conflict', message: 'approval conflict' } }, { status: 409 })))
		await expect(approveBuilderSelection(client, input, (value) => saved.push(value), () => {
			canChangeSelection = true
		})).rejects.toThrow('approval conflict')
		expect(saved).toEqual([receipt])
		expect(canChangeSelection).toBe(false)
		expect(calls.map((call) => call.method)).toEqual(['builderConnections.createReceipt', 'builderPairing.approve'])
	})

	test('source conflict then app 404 permits an explicit corrected creation, without an implicit write', async () => {
		const calls: Call[] = []
		const client = createControlClient(transport(calls, ({ method, input: body }) => {
			if (method === 'apps.get') return Response.json({ error: { type: 'not_found', message: 'absent' } }, { status: 404 })
			if (typeof body === 'object' && body !== null && 'resolveInstallationId' in body) {
				return Response.json({ error: { type: 'conflict', message: 'no source connection' } }, { status: 409 })
			}
			return Response.json({ result: app })
		}))
		let rejected = false
		try {
			await client.apps.create({ id: app.id, repoUrl: app.repoUrl, resolveInstallationId: true })
		} catch (cause) {
			rejected = isBuilderWriteConflict(cause)
		}
		expect(rejected).toBe(true)
		expect(await recoverBuilderCreation(client, { appId: app.id, rejected })).toEqual({ status: 'absent' })
		expect(calls.map((call) => call.method)).toEqual(['apps.create', 'apps.get'])
		expect(await client.apps.create({ id: app.id, repoUrl: app.repoUrl, githubInstallationId: null })).toEqual(app)
		expect(calls).toEqual([
			{ method: 'apps.create', input: { id: app.id, repoUrl: app.repoUrl, resolveInstallationId: true } },
			{ method: 'apps.get', input: { appId: app.id } },
			{ method: 'apps.create', input: { id: app.id, repoUrl: app.repoUrl, githubInstallationId: null } },
		])
	})

	test('a lost creation response stays uncertain even if lookup returns 404', async () => {
		const calls: Call[] = []
		const client = createControlClient(transport(calls, ({ method }) => {
			if (method === 'apps.create') throw new Error('offline')
			return Response.json({ error: { type: 'not_found', message: 'absent' } }, { status: 404 })
		}))
		let rejected = true
		try {
			await client.apps.create({ id: app.id, repoUrl: app.repoUrl, resolveInstallationId: true })
		} catch (cause) {
			rejected = isBuilderWriteConflict(cause)
		}
		expect(rejected).toBe(false)
		expect(await recoverBuilderCreation(client, { appId: app.id, rejected })).toEqual({ status: 'uncertain' })
		expect(calls.map((call) => call.method)).toEqual(['apps.create', 'apps.get'])
	})

	test('failed app lookup does not confirm absence, and an existing app is recovered without writing', async () => {
		for (const lookup of ['network', 'forbidden', 'found']) {
			const calls: Call[] = []
			const client = createControlClient(transport(calls, () => {
				if (lookup === 'network') throw new Error('offline')
				if (lookup === 'forbidden') return Response.json({ error: { type: 'forbidden', message: 'denied' } }, { status: 403 })
				return Response.json({ result: app })
			}))
			const result = recoverBuilderCreation(client, { appId: app.id, rejected: true })
			if (lookup === 'found') expect(await result).toEqual({ status: 'found', app })
			else await expect(result).rejects.toThrow()
			expect(calls).toEqual([{ method: 'apps.get', input: { appId: app.id } }])
		}
	})
})

test('scoped app lookup never requests the global list or namespace management', async () => {
	const calls: Call[] = []
	const client = createControlClient(transport(calls, ({ method }) => {
		if (method === 'apps.get') return Response.json({ result: app })
		if (method === 'apps.environments.list') return Response.json({ result: { items: [existing] } })
		return Response.json({ error: { type: 'forbidden', message: 'denied' } }, { status: 403 })
	}))
	expect(await loadKnownBuilderApp(client, app.id)).toEqual({ app, environments: [existing] })
	expect(calls.map((call) => call.method)).toEqual(['apps.get', 'apps.environments.list'])
	expect(currentBuilderEnvironment(existing)).toEqual({
		env: 'prod',
		namespaceId: 'prepared-prod',
		domain: 'shop.example.com',
		publicOrigin: 'https://public.example.com',
		triggerRef: 'refs/tags/v*',
	})
})

test('own-key revocation calls only issuer revocation, including already-revoked and failed results', async () => {
	for (
		const result of [{ ok: true, revoked: true }, { ok: true, revoked: false }, { ok: false, reason: 'not_allowed' }, {
			ok: false,
			reason: 'not_found',
		}]
	) {
		const calls: Call[] = []
		const client = createControlClient(transport(calls, () => Response.json({ result })))
		const error = await revokeBuilderConnection(client, 'credential-1')
		expect(error === null).toBe(result.ok)
		expect(calls).toEqual([{ method: 'builderPairing.revoke', input: { credentialId: 'credential-1' } }])
	}
})

test('consent and failures disclose breadth and lifetime without echoing proof or machine key', () => {
	const markup = renderToStaticMarkup(createElement(BuilderConsentReview, { app, environment: receipt.environment, keyLifetimeSeconds: 2592000 }))
	expect(markup).toContain('deleting the application and managing all its environments')
	expect(markup).toContain('30 days after approval')
	expect(markup).toContain('https://public.example.com')
	expect(markup).not.toContain(state.approvalVerifier)
	expect(markup).not.toContain('px_')
	for (const httpStatus of [401, 403, 409, 500]) {
		const message = builderRequestError(new ApiError({ type: 'error', httpStatus, message: `${state.approvalVerifier} px_secret` }), 'Retry later.')
		expect(message).not.toContain(state.approvalVerifier)
		expect(message).not.toContain('px_secret')
	}
})
