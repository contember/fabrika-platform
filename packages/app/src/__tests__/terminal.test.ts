// A terminal (ADR-0067) from the application's side: the vocabulary declares the identification page, which a public
// SPA mount must serve and which reaches IAM's schema; a token of a person asserted at a terminal names it as
// `ctx.principal.terminal`; and `ctx.terminals` asks IAM with the request's credential, mapping its answers.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { BootError, serve } from '@fabrika/app/implement'
import { appSchemaSchema } from '@fabrika/auth'
import {
	type AssertIdentityInput,
	buildAccessClaims,
	type CancelIdentificationInput,
	canonicalArtifactJson,
	type IamTerminalRpc,
	type InspectIdentificationInput,
	MAX_TERMINAL_IDENTIFY_PATH_LENGTH,
	terminalIdentifyProblem,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract, ContractError, parseContractArtifact, schemaFromContract } from '../contract'
import { ServerFault } from '../implement/faults'
import { terminalIdentification } from '../implement/terminals'
import { APP_ID, bootApp, errorType, grant, ISSUER, resultOf, send, sign, token } from './fixtures/implement/harness'

const base = {
	app: 'notes',
	dimensions: { workspace: {} },
	actions: { 'attendance.record': 'Record attendance' },
	roles: { clerk: { grants: ['attendance.record'] } },
} as const

const Whoami = z.strictObject({ id: z.string(), terminal: z.nullable(z.strictObject({ id: z.string(), label: z.string() })) })
const Identify = z.strictObject({ id: z.string(), principalId: z.string() })
const Identified = z.strictObject({ terminal: z.nullable(z.string()), callbackUrl: z.nullable(z.string()), refused: z.nullable(z.string()) })

function kioskContract(identify: `/${string}`, page: 'public' | 'member' = 'public') {
	const app = defineApp(defineVocabulary({ ...base, terminal: { identify } }))
	const kiosk = app.group({ callers: ['human'] }, (r) => ({
		whoami: r.query({ output: Whoami, access: { action: 'attendance.record', app: true } })
			.handle(({ ctx }) => ({ id: ctx.principal.id, terminal: ctx.principal.terminal ?? null })),
		identify: r.mutation({ input: Identify, output: Identified, access: { action: 'attendance.record', app: true } })
			.handle(async ({ input, ctx }) => {
				const open = await ctx.terminals.inspect(input.id)
				const asserted = await ctx.terminals.assert(input.id, input.principalId)
				await ctx.terminals.cancel(input.id)
				return {
					terminal: open?.terminal.label ?? null,
					callbackUrl: asserted.ok ? asserted.callbackUrl : null,
					refused: asserted.ok ? null : asserted.reason,
				}
			}),
	}))
	return app.contract((c) => ({
		api: c.rpc('/api', { kiosk }),
		identify: c.spa('/identify', { dir: 'dist/identify', access: page === 'public' ? { public: true } : { member: true } }),
		web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	}))
}

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) return error.problems
		throw error
	}
	throw new Error('the contract compiled')
}

/** IAM's identification operations, recording each call and answering what the test sets. */
function fakeTerminals(answers: Partial<IamTerminalRpc> = {}) {
	const calls: (InspectIdentificationInput | AssertIdentityInput | CancelIdentificationInput)[] = []
	const rpc: IamTerminalRpc = {
		inspectIdentification: (input) => {
			calls.push(input)
			return answers.inspectIdentification?.(input)
				?? Promise.resolve({ ok: true, terminal: { id: 'terminal-1', label: 'Entrance' }, expiresAt: 2_000_000_000 })
		},
		assertIdentity: (input) => {
			calls.push(input)
			return answers.assertIdentity?.(input) ?? Promise.resolve({ ok: true, callbackUrl: 'https://notes.test/__fabrika/auth/callback?code=c1' })
		},
		cancelIdentification: (input) => {
			calls.push(input)
			return answers.cancelIdentification?.(input) ?? Promise.resolve({ ok: true })
		},
	}
	return { rpc, calls }
}

describe('the identification page a contract declares', () => {
	test('a canonical absolute path outside /__fabrika is one; anything else is refused with the reason', () => {
		for (const path of ['/identify', '/kiosk/identify', '/identify/', '/a-b_c.d~e']) {
			expect(terminalIdentifyProblem(path)).toBeNull()
		}
		for (
			const path of [
				'',
				'identify',
				'//evil.test/identify',
				'https://evil.test/identify',
				'/identify?x=1',
				'/identify#top',
				'/id entify',
				'/a/../b',
				'/a//b',
				'/a\\b',
				'/a%2fb',
				'/__fabrika',
				'/__fabrika/auth/signout',
				`/${'a'.repeat(MAX_TERMINAL_IDENTIFY_PATH_LENGTH)}`,
			]
		) {
			expect(terminalIdentifyProblem(path)).not.toBeNull()
		}
	})

	test('compiles into the artifact and the IAM schema, which IAM parses back', () => {
		const artifact = compileContract(kioskContract('/identify'), {})
		expect(artifact.terminal).toEqual({ identify: '/identify' })
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact))).terminal).toEqual({ identify: '/identify' })
		const schema = schemaFromContract(artifact)
		expect(schema.terminal).toEqual({ identify: '/identify' })
		expect(appSchemaSchema.parse(JSON.parse(JSON.stringify(schema))).terminal).toEqual({ identify: '/identify' })
		// The digest covers it.
		const { terminal: _terminal, ...without } = artifact
		expect(canonicalArtifactJson(without)).not.toBe(canonicalArtifactJson(artifact))
	})

	test('a path that is not one is refused by the build, the artifact parser and IAM', () => {
		expect(problemsOf(() => compileContract(kioskContract('/identify?x=1'), {}))).toEqual([
			"terminal.identify: '/identify?x=1' carries a query, a fragment, whitespace or a control character; IAM appends the query itself",
		])
		expect(problemsOf(() => compileContract(kioskContract('/__fabrika/identify'), {}))).toEqual([
			"terminal.identify: '/__fabrika/identify' lies under /__fabrika, which the platform owns",
		])
		const artifact = compileContract(kioskContract('/identify'), {})
		expect(() => parseContractArtifact({ ...artifact, terminal: { identify: '//evil.test' } })).toThrow()
		expect(() => parseContractArtifact({ ...artifact, terminal: { identify: '/identify', extra: true } })).toThrow()
		const schema = schemaFromContract(artifact)
		expect(appSchemaSchema.safeParse({ ...schema, terminal: { identify: 'https://evil.test/' } }).success).toBe(false)
	})

	test('a page no public SPA mount serves is refused: the proxy would bounce the terminal back to sign-in', () => {
		expect(problemsOf(() => compileContract(kioskContract('/identify', 'member'), {}))).toEqual([
			"terminal.identify: '/identify' is served by 'identify.prefix' (spa); serve it from an spa mount with access: { public: true }",
		])
		expect(problemsOf(() => compileContract(kioskContract('/kiosk'), {}))).toEqual([
			"terminal.identify: '/kiosk' is served by 'web' (spa); serve it from an spa mount with access: { public: true }",
		])
		expect(compileContract(kioskContract('/identify/pin'), {}).terminal).toEqual({ identify: '/identify/pin' })
	})
})

/** A person's session token as IAM mints it after an application asserted them at a terminal. */
async function terminalToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return sign(buildAccessClaims({
		iss: ISSUER,
		app: APP_ID,
		subject: 'user-1',
		type: 'user',
		label: 'user@notes.test',
		email: 'user@notes.test',
		session: true,
		terminal: { id: 'terminal-1', label: 'Entrance' },
		permissions: [{ action: 'attendance.record', scope: null, source: 'terminal' }],
		issuedAt: now - 10,
		expiresAt: now + 300,
	}))
}

describe('a person signed in on a terminal', () => {
	const app = serve(kioskContract('/identify'), { database: null })

	test('ctx.principal.terminal names the terminal the token carries', async () => {
		const booted = bootApp(app, { terminals: fakeTerminals().rpc })
		const sent = await send(booted, '/api/kiosk.whoami', { token: await terminalToken(), body: {} })
		expect(resultOf(sent)).toEqual({ id: 'user-1', terminal: { id: 'terminal-1', label: 'Entrance' } })
	})

	test('a personal sign-in has no terminal', async () => {
		const booted = bootApp(app, { terminals: fakeTerminals().rpc })
		const sent = await send(booted, '/api/kiosk.whoami', { token: await token('user', [grant('attendance.record')]), body: {} })
		expect(resultOf(sent)).toEqual({ id: 'user-1', terminal: null })
	})
})

describe('ctx.terminals', () => {
	const app = serve(kioskContract('/identify'), { database: null })

	test("asks IAM with the request's credential and the application's id, and answers IAM's word", async () => {
		const iam = fakeTerminals()
		const credential = await token('user', [grant('attendance.record')])
		const sent = await send(bootApp(app, { terminals: iam.rpc }), '/api/kiosk.identify', {
			token: credential,
			body: { id: 'ident-1', principalId: 'person-7' },
		})
		expect(resultOf(sent)).toEqual({ terminal: 'Entrance', callbackUrl: 'https://notes.test/__fabrika/auth/callback?code=c1', refused: null })
		expect(iam.calls.map(({ requestId: _requestId, ...call }) => call)).toEqual([
			{ app: APP_ID, credential, id: 'ident-1' },
			{ app: APP_ID, credential, id: 'ident-1', principalId: 'person-7' },
			{ app: APP_ID, credential, id: 'ident-1' },
		])
		expect(new Set(iam.calls.map((call) => call.requestId)).size).toBe(1)
	})

	test("IAM's refusals the handler acts on are its answer; an id IAM never issues is not sent", async () => {
		const iam = fakeTerminals({
			inspectIdentification: () => Promise.resolve({ ok: false, reason: 'not_found' }),
			assertIdentity: () => Promise.resolve({ ok: false, reason: 'invalid_principal' }),
			cancelIdentification: () => Promise.resolve({ ok: false, reason: 'not_found' }),
		})
		const credential = await token('user', [grant('attendance.record')])
		const booted = bootApp(app, { terminals: iam.rpc })
		const refused = await send(booted, '/api/kiosk.identify', { token: credential, body: { id: 'ident-1', principalId: 'external-1' } })
		expect(resultOf(refused)).toEqual({ terminal: null, callbackUrl: null, refused: 'invalid_principal' })
		const before = iam.calls.length
		const unknown = await send(booted, '/api/kiosk.identify', { token: credential, body: { id: 'x'.repeat(201), principalId: 'person-7' } })
		expect(resultOf(unknown)).toEqual({ terminal: null, callbackUrl: null, refused: 'not_found' })
		expect(iam.calls.length).toBe(before)
	})

	test("IAM out of reach is a 503, and IAM refusing the application's own credential a 500", async () => {
		const credential = await token('user', [grant('attendance.record')])
		const down = fakeTerminals({ inspectIdentification: () => Promise.reject(new Error('connection refused')) })
		const unreachable = await send(bootApp(app, { terminals: down.rpc }), '/api/kiosk.identify', {
			token: credential,
			body: { id: 'ident-1', principalId: 'person-7' },
		})
		expect(unreachable.status).toBe(503)
		const refusing = fakeTerminals({ inspectIdentification: () => Promise.resolve({ ok: false, reason: 'invalid_token' }) })
		const refused = await send(bootApp(app, { terminals: refusing.rpc }), '/api/kiosk.identify', {
			token: credential,
			body: { id: 'ident-1', principalId: 'person-7' },
		})
		expect(refused.status).toBe(500)
		expect(errorType(refused)).toBe('internal')
	})

	test('a contract that declares a terminal does not boot without an IAM transport for it', () => {
		expect(() => bootApp(app)).toThrow(BootError)
		expect(() => bootApp(app)).toThrow(/declares a terminal, and the runtime adapter supplies no IAM transport/)
	})

	test('maps every answer without a runtime: the reasons a handler cannot change are server faults', async () => {
		const caller = { app: APP_ID, credential: 'token', requestId: 'r1' }
		const refusing = terminalIdentification(fakeTerminals({ assertIdentity: () => Promise.resolve({ ok: false, reason: 'not_allowed' }) }).rpc, caller)
		const fault = await refusing.assert('ident-1', 'person-7').catch((error: unknown) => error)
		expect(fault).toBeInstanceOf(ServerFault)
		expect(fault instanceof ServerFault ? fault.reason : null).toBe('terminal_refused')
		const open = await terminalIdentification(fakeTerminals().rpc, caller).inspect('ident-1')
		expect(open).toEqual({ terminal: { id: 'terminal-1', label: 'Entrance' }, expiresAt: 2_000_000_000 })
		expect(await terminalIdentification(fakeTerminals().rpc, caller).inspect('')).toBeNull()
	})
})
