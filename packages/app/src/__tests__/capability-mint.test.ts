// Application code can load `capability.ts` by URL, because the package ships `src/`, and it reaches the module
// instance the dispatcher uses. It finds no mint a runtime's stores accept there: every `boot` makes an issuer of its
// own, binds its stores to that issuer's authority and holds the mint in its closure. A mint application code makes,
// or a second runtime it boots with keys of its own, mints capabilities the real stores refuse.

import { buildAccessClaims, type Jwks } from '@fabrika/auth-core'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CapabilityRefusedError, createCapabilityIssuer, RequestFrame, runInRequest } from '../implement/capability'
import { implement } from '../implement/implement'
import { contract } from './fixtures/implement/fabrika.contract'
import { APP_ID, bootApp, grant, ISSUER, resultOf, send, token } from './fixtures/implement/harness'
import { noteDatabase, type NoteRow, type NotesStore, notesStore } from './fixtures/implement/stores'

const OWN = '0190a0a0-0000-7000-8000-000000000001'
const VICTIM = '0190a0a0-0000-7000-8000-000000000002'
const REFUSED = 'not a capability the framework minted: pass the ctx.target or ctx.within of this request'

/** The red-team route: the internal module beside the public entry of `@fabrika/app/implement`. */
const capabilityUrl = new URL('./capability.ts', import.meta.resolve('@fabrika/app/implement')).href

function rowsOf(): Map<string, NoteRow> {
	return new Map([
		[OWN, { id: OWN, workspaceId: 'w1', title: 'own', internalScore: 0 }],
		[VICTIM, { id: VICTIM, workspaceId: 'w2', title: 'victim', internalScore: 0 }],
	])
}

/** The application as it is served: its store, bound to the authority its runtime handed `deps`. */
function servedApp(rows: Map<string, NoteRow>, served: { notes?: NotesStore; authority?: CapabilityAuthority }) {
	return implement(contract, {
		database: noteDatabase(rows),
		deps: (_env, { capabilities }) => {
			served.notes = notesStore(capabilities, rows)
			served.authority = capabilities
			return served.notes
		},
		handlers: (notes) => ({
			api: {
				me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
				notes: {
					list: () => ({ items: [] }),
					get: ({ ctx }) => {
						const note = notes.get(ctx.target)
						return { id: note.id, title: note.title }
					},
					create: () => ({ id: OWN, title: 'own' }),
					remove: ({ ctx }) => {
						notes.remove(ctx.target)
						return { deleted: ctx.target.value }
					},
				},
			},
			machine: { importNotes: () => ({ imported: 0 }) },
		}),
	})
}

describe('no mint application code reaches is accepted by a runtime’s stores', () => {
	test('the module loaded by URL is the dispatcher’s, and it exports no mint and no handle on the running request', async () => {
		const loaded: unknown = await import(capabilityUrl)
		expect(Reflect.get(Object(loaded), 'createCapabilityIssuer')).toBe(createCapabilityIssuer)
		const names = Object.keys(Object(loaded))
		for (const removed of ['mintRef', 'mintWithin', 'activeRequest', 'requestCapabilities', 'claimFrameworkMint']) {
			expect(names).not.toContain(removed)
		}
	})

	test('a capability of another issuer, minted for the running request, is refused by an authority', async () => {
		const runtime = createCapabilityIssuer()
		const forger = createCapabilityIssuer()
		const frame = new RequestFrame('request-1')
		await runInRequest(frame, async () => {
			const forged = forger.mint.ref(frame, 'note', 'notes.delete', 'redteam', VICTIM, new Map([['workspace', 'w2']]))
			// Well formed: its own issuer's authority accepts it.
			expect(forger.authority.resolve(forged).kind).toBe('ref')
			expect(() => runtime.authority.resolve(forged)).toThrow(REFUSED)
			const within = forger.mint.within(frame, 'workspace', 'notes.read', 'redteam', 'all')
			expect(() => runtime.authority.resolve(within)).toThrow(REFUSED)
		})
		frame.end()
	})

	test('a handler that forges a Ref to delete a note of another workspace is refused, and the note stays', async () => {
		const rows = rowsOf()
		const refusals: string[] = []
		const app = implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => notesStore(capabilities, rows),
			handlers: (notes) => ({
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
		expect(refusals).toEqual([REFUSED])
		expect(rows.has(VICTIM)).toBe(true)
	})

	test('application code that boots a second runtime with IAM keys of its own gets capabilities the real stores refuse', async () => {
		const rows = rowsOf()
		const served: { notes?: NotesStore; authority?: CapabilityAuthority } = {}
		bootApp(servedApp(rows, served))
		const real = served.notes
		if (real === undefined) {
			throw new Error('the served application did not boot')
		}

		// The forger's own IAM: a key pair it generated, and a token granting itself notes.delete everywhere.
		const { publicKey, privateKey } = await generateKeyPair('ES256')
		const jwk = await exportJWK(publicKey)
		const jwks: Jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'k1', alg: 'ES256', use: 'sig' }] }
		const now = Math.floor(Date.now() / 1000)
		const claims = buildAccessClaims({
			iss: ISSUER,
			app: APP_ID,
			subject: 'forger',
			type: 'user',
			label: 'forger',
			email: 'forger@notes.test',
			permissions: [grant('notes.delete')],
			issuedAt: now - 10,
			expiresAt: now + 300,
		})
		const forged = await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(privateKey)

		const outcomes: string[] = []
		const second = implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => capabilities,
			handlers: (own) => ({
				api: {
					me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
					notes: {
						list: () => ({ items: [] }),
						get: () => ({ id: OWN, title: 'own' }),
						create: () => ({ id: OWN, title: 'own' }),
						remove: ({ ctx }) => {
							// Authentic for the second runtime ...
							outcomes.push(own.resolve(ctx.target).kind)
							// ... and refused by the store of the runtime that serves the application.
							try {
								real.remove(ctx.target)
							} catch (error) {
								outcomes.push(error instanceof CapabilityRefusedError ? error.message : 'another error')
							}
							return { deleted: ctx.target.value }
						},
					},
				},
				machine: { importNotes: () => ({ imported: 0 }) },
			}),
		})
		// The public `boot`, through the harness, with the forger's keys in place of IAM's.
		const runtime = bootApp(second, { iam: { getJwks: () => Promise.resolve(jwks) } })
		const sent = await send(runtime, '/api/notes.remove', { token: forged, body: { id: VICTIM } })
		expect(resultOf(sent)).toEqual({ deleted: VICTIM })
		expect(outcomes).toEqual(['ref', REFUSED])
		expect(rows.has(VICTIM)).toBe(true)
	})
})
