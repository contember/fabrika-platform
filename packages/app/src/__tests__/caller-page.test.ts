// Who calls, from the verified token alone: a handler reads the person's mailbox as `ctx.principal.email`, and every
// SPA mount answers `<prefix>/__fabrika-me.json` with the caller's label, mailbox and granted actions, under the mount's
// own access. Nothing asks IAM; the page shows and hides by it, and every endpoint still decides for itself.

import { parsePageCaller } from '@fabrika/app/client'
import { defineContract } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import { buildAccessClaims } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { APP_ID, bootApp, grant, ISSUER, resultOf, send, sign, token } from './fixtures/implement/harness'

const vocabulary = {
	app: 'notes',
	dimensions: { workspace: {} },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'settings.manage': 'Edit the settings' },
	roles: { editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['editor'] } } },
} as const

const Whoami = z.strictObject({ id: z.string(), label: z.string(), email: z.string() })

const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, { whoami: c.query({ output: Whoami, access: { member: true } }) }),
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
}))

const app = implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({
		api: { whoami: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label, email: ctx.principal.email }) },
	}),
})

const w1 = { type: 'workspace', value: 'w1' }
const w2 = { type: 'workspace', value: 'w2' }

/** A user token as IAM minted it before it carried the mailbox. */
async function tokenWithoutMailbox(): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return sign(buildAccessClaims({
		iss: ISSUER,
		app: APP_ID,
		subject: 'user-1',
		type: 'user',
		label: 'user@notes.test',
		permissions: [grant('notes.read')],
		issuedAt: now - 10,
		expiresAt: now + 300,
	}))
}

describe("a handler knows the caller's own address", () => {
	test("ctx.principal.email is the mailbox the token carries, beside the person's label", async () => {
		const sent = await send(bootApp(app), '/api/whoami', { token: await token('user', [grant('notes.read')]), body: {} })
		expect(resultOf(sent)).toEqual({ id: 'user-1', label: 'user@notes.test', email: 'user@notes.test' })
	})

	test('a person whose token carries no mailbox is refused before any handler', async () => {
		const sent = await send(bootApp(app), '/api/whoami', { token: await tokenWithoutMailbox(), body: {} })
		expect(sent.status).toBe(401)
	})
})

describe('the caller document of an SPA mount', () => {
	test("answers a person's label, mailbox and the actions it holds app-wide", async () => {
		const sent = await send(bootApp(app), '/app/__fabrika-me.json', { token: await token('user', [grant('notes.read'), grant('settings.manage')]) })
		expect(sent.status).toBe(200)
		expect(sent.headers.get('Cache-Control')).toBe('no-store')
		expect(sent.body).toEqual({
			label: 'user@notes.test',
			email: 'user@notes.test',
			actions: { app: ['notes.read', 'settings.manage'], scopes: [] },
		})
		expect(parsePageCaller(sent.body)).toEqual({
			label: 'user@notes.test',
			email: 'user@notes.test',
			actions: { app: ['notes.read', 'settings.manage'], scopes: [] },
		})
	})

	test('answers a member of two values each value with its own actions', async () => {
		const perms = [grant('notes.write', w2), grant('notes.read', w1), grant('notes.read', w2), grant('notes.read', w2)]
		const sent = await send(bootApp(app), '/app/__fabrika-me.json', { token: await token('user', perms) })
		expect(sent.body).toEqual({
			label: 'user@notes.test',
			email: 'user@notes.test',
			actions: {
				app: [],
				scopes: [
					{ type: 'workspace', value: 'w1', actions: ['notes.read'] },
					{ type: 'workspace', value: 'w2', actions: ['notes.read', 'notes.write'] },
				],
			},
		})
	})

	test("a pattern grant lists the contract's actions it covers", async () => {
		const sent = await send(bootApp(app), '/app/__fabrika-me.json', { token: await token('user', [grant('*'), grant('notes.*', w1)]) })
		expect(sent.body).toEqual({
			label: 'user@notes.test',
			email: 'user@notes.test',
			actions: {
				app: ['notes.read', 'notes.write', 'settings.manage'],
				scopes: [{ type: 'workspace', value: 'w1', actions: ['notes.read', 'notes.write'] }],
			},
		})
	})

	test('an anonymous caller is 401: at a member SPA, and at a public one, which no request reaches with a token', async () => {
		const booted = bootApp(app)
		expect((await send(booted, '/app/__fabrika-me.json')).status).toBe(401)
		expect((await send(booted, '/__fabrika-me.json')).status).toBe(401)
		expect((await send(booted, '/app/__fabrika-me.json', { token: await tokenWithoutMailbox() })).status).toBe(401)
		// Only the mount's own document: a deeper path is the asset server's.
		expect((await send(booted, '/app/x/__fabrika-me.json', { token: await token('user', [grant('notes.read')]) })).body).toBe(
			'dist/app /app/x/__fabrika-me.json',
		)
	})

	test('the test kit answers it for a test caller, behind the proxy decision of the mount', async () => {
		const kit = testKit(app)
		const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }], { email: 'Ann@Example.com' })
		const answer = await kit.browser(editor)('/app/__fabrika-me.json')
		expect(answer.status).toBe(200)
		expect(parsePageCaller(await answer.json())).toEqual({
			label: editor.label,
			email: 'ann@example.com',
			actions: { app: [], scopes: [{ type: 'workspace', value: 'w1', actions: ['notes.read', 'notes.write'] }] },
		})
		expect(editor.email).toBe('ann@example.com')
		expect((await kit.browser()('/__fabrika-me.json')).status).toBe(401)
	})
})

describe('the parser of the caller document', () => {
	test('refuses an answer that is not one', () => {
		const answer = { label: 'a', email: 'a@b.cz', actions: { app: [], scopes: [] } }
		expect(parsePageCaller(answer)).toEqual(answer)
		for (const broken of [null, {}, { ...answer, email: null }, { ...answer, extra: 1 }, { ...answer, actions: { app: [1], scopes: [] } }]) {
			expect(() => parsePageCaller(broken)).toThrow()
		}
	})
})
