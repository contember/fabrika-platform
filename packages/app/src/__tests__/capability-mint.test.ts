// Application code can load `capability.ts` by URL, because the package ships `src/`, and it reaches the module
// instance the dispatcher uses. It finds no mint the framework's authority accepts there: `boot.ts` claimed that mint
// when it loaded, and a capability of any other issuer is refused, in the running request as in any other.

import { implement, requestCapabilities as publicAuthority } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import {
	CapabilityRefusedError,
	claimFrameworkMint,
	createCapabilityIssuer,
	requestCapabilities,
	RequestFrame,
	runInRequest,
} from '../implement/capability'
import { contract } from './fixtures/implement/fabrika.contract'
import { bootApp, grant, resultOf, send, token } from './fixtures/implement/harness'
import { noteDatabase, type NoteRow, notesStore } from './fixtures/implement/stores'

const OWN = '0190a0a0-0000-7000-8000-000000000001'
const VICTIM = '0190a0a0-0000-7000-8000-000000000002'

/** The red-team route: the internal module beside the public entry of `@fabrika/app/implement`. */
const capabilityUrl = new URL('./capability.ts', import.meta.resolve('@fabrika/app/implement')).href

describe('the capability mint is the framework’s alone', () => {
	test('the module loaded by URL is the dispatcher’s, and it exports no mint and no handle on the running request', async () => {
		const loaded: unknown = await import(capabilityUrl)
		expect(Reflect.get(Object(loaded), 'requestCapabilities')).toBe(requestCapabilities)
		expect(publicAuthority).toBe(requestCapabilities)
		const names = Object.keys(Object(loaded))
		for (const removed of ['mintRef', 'mintWithin', 'activeRequest']) {
			expect(names).not.toContain(removed)
		}
	})

	test('boot.ts claimed the framework’s mint when it loaded, so a second claim throws', () => {
		expect(() => claimFrameworkMint()).toThrow(CapabilityRefusedError)
		expect(() => claimFrameworkMint()).toThrow('the framework holds its capability mint')
	})

	test('a capability of another issuer, minted for the running request, is refused by the framework’s authority', async () => {
		const forger = createCapabilityIssuer()
		const frame = new RequestFrame('request-1')
		await runInRequest(frame, async () => {
			const forged = forger.mint.ref(frame, 'note', 'notes.delete', 'redteam', VICTIM, new Map([['workspace', 'w2']]))
			// Well formed: its own issuer's authority accepts it.
			expect(forger.authority.resolve(forged).kind).toBe('ref')
			expect(() => requestCapabilities.resolve(forged)).toThrow('not a capability the framework minted')
			const within = forger.mint.within(frame, 'workspace', 'notes.read', 'redteam', 'all')
			expect(() => requestCapabilities.resolve(within)).toThrow('not a capability the framework minted')
		})
		frame.end()
	})

	test('a handler that forges a Ref to delete a note of another workspace is refused, and the note stays', async () => {
		const rows = new Map<string, NoteRow>([
			[OWN, { id: OWN, workspaceId: 'w1', title: 'own', internalScore: 0 }],
			[VICTIM, { id: VICTIM, workspaceId: 'w2', title: 'victim', internalScore: 0 }],
		])
		const refusals: string[] = []
		const app = implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
			handlers: ({ notes }) => ({
				api: {
					me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
					notes: {
						list: () => ({ items: [] }),
						get: async ({ ctx }) => {
							const own = notes.get(ctx.target)
							const forger = createCapabilityIssuer()
							const frame = new RequestFrame('forged-request')
							await runInRequest(frame, async () => {
								notes.remove(forger.mint.ref(frame, 'note', 'notes.delete', 'redteam', VICTIM, new Map([['workspace', 'w2']])))
							}).catch((error: unknown) => {
								refusals.push(error instanceof CapabilityRefusedError ? error.message : 'another error')
							})
							return { id: own.id, title: own.title }
						},
						create: () => ({ id: OWN, title: 'own' }),
						remove: () => ({ deleted: OWN }),
					},
				},
				machine: { importNotes: () => ({ imported: 0 }) },
			}),
		})
		const sent = await send(bootApp(app), '/api/notes.get', {
			token: await token('user', [grant('notes.read', { type: 'workspace', value: 'w1' })]),
			body: { id: OWN },
		})
		expect(resultOf(sent)).toEqual({ id: OWN, title: 'own' })
		expect(refusals).toEqual(['not a capability the framework minted: pass the ctx.target or ctx.within of this request'])
		expect(rows.has(VICTIM)).toBe(true)
	})
})
