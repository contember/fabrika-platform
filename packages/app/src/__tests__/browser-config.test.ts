// Every SPA mount serves `<prefix>/__fabrika-config.json`: the browser's Operations DSN and the release, and nothing
// else of the environment. A member SPA's answer needs the member's token, a public SPA's none.

import { defineContract } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { notesApp } from './fixtures/implement/app'
import { bootApp, environment, frameworkEnvFor, grant, send, token } from './fixtures/implement/harness'

const DSN = 'https://0123456789abcdef0123456789abcdef@operations.test/42'
const RELEASE = 'fabrika/notes/prod/default/abc'
const OPERATIONS = { FABRIKA_OPERATIONS_DSN: ` ${DSN} `, FABRIKA_RELEASE: RELEASE }

const notes = notesApp(new Map())

/** A public site at `/` and a member SPA under `/app`, of the same application. */
const site = implement(
	defineContract({ app: 'notes', dimensions: {}, actions: { 'notes.read': 'Read notes' }, roles: {} }, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, { me: c.query({ output: z.strictObject({ id: z.string() }), access: { member: true } }) }),
		site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
		web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
	})),
	{ database: null, deps: () => ({}), handlers: () => ({ api: { me: ({ ctx }) => ({ id: ctx.principal.id }) } }) },
)

describe('the browser config of an SPA mount', () => {
	test('a member SPA answers the DSN and the release to its member, and only those two', async () => {
		const app = bootApp(notes, { environment: environment({ ...frameworkEnvFor(notes), ...OPERATIONS }) })
		const sent = await send(app, '/__fabrika-config.json', { token: await token('user', [grant('notes.read')]) })
		expect(sent.status).toBe(200)
		expect(sent.body).toEqual({ dsn: DSN, release: RELEASE })
		expect(sent.headers.get('Cache-Control')).toBe('no-store')
		expect((await send(app, '/__fabrika-config.json')).status).toBe(401)
		// Any other path of the mount is still the asset server's.
		expect((await send(app, '/x/__fabrika-config.json', { token: await token('user', [grant('notes.read')]) })).body).toBe(
			'dist/app /x/__fabrika-config.json',
		)
	})

	test('without a DSN or a release the values are null', async () => {
		const sent = await send(bootApp(notes), '/__fabrika-config.json', { token: await token('user', [grant('notes.read')]) })
		expect(sent.body).toEqual({ dsn: null, release: null })
	})

	test('a public SPA answers anyone; a member SPA beside it serves its own under its prefix', async () => {
		const app = bootApp(site, { environment: environment({ ...frameworkEnvFor(site), ...OPERATIONS }) })
		const anonymous = await send(app, '/__fabrika-config.json')
		expect(anonymous.status).toBe(200)
		expect(anonymous.body).toEqual({ dsn: DSN, release: RELEASE })
		expect((await send(app, '/app/__fabrika-config.json')).status).toBe(401)
		const member = await send(app, '/app/__fabrika-config.json', { token: await token('user', [grant('notes.read')]) })
		expect(member.body).toEqual({ dsn: DSN, release: RELEASE })
	})
})
