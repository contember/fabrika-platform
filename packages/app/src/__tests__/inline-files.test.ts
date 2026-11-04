// A file kind declared `inline: true` is shown, not downloaded: a feed a machine reads at a public URL. Its row is
// `response: 'inline-file'`, every other file row stays an attachment, and an inline kind admits only inert images and
// XML documents. Through the test kit, so the production proxy decision sits in front of boot. On the SQLite test
// database, so it never skips.

import { compileContract, defineApp, defineContract, defineVocabulary, file, parseContractArtifact } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

interface FeedsTable {
	id: string
	feed: string
	dump: string
}

const columns: TypedColumnList<{ feeds: FeedsTable }> = {
	feeds: { columns: ['id', 'feed', 'dump'], foreignKeys: [], timestamps: [] },
}

const vocabulary = defineVocabulary({
	app: 'feeds',
	dimensions: {},
	actions: { 'feeds.read': 'Read feeds', 'feeds.write': 'Publish feeds' },
	roles: { publisher: { grants: ['feeds.read', 'feeds.write'] } },
})

const tables = defineTables(vocabulary, columns)({
	feeds: {
		scope: { app: 'one feed per application' },
		actions: { read: 'feeds.read', insert: 'feeds.write' },
		insert: ['feed', 'dump'],
		files: { feed: 'feed', dump: 'dump' },
	},
})

const DUMP = '<?xml version="1.0"?>\n<products/>\n'

const escapeXml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// The application renders every file of the inline kind itself; the caller sends only data. The non-RSS formats are
// renderings the kind must refuse to store.
const RENDERINGS = {
	rss: (title: string) => ({
		body: `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escapeXml(title)}</title></channel></rss>\n`,
		type: 'application/rss+xml',
	}),
	json: (title: string) => ({ body: JSON.stringify({ title }), type: 'application/rss+xml' }),
	html: (title: string) => ({ body: `<html><title>${escapeXml(title)}</title></html>`, type: 'text/html' }),
	svg: (title: string) => ({ body: `<svg xmlns="http://www.w3.org/2000/svg"><title>${escapeXml(title)}</title></svg>`, type: 'image/svg+xml' }),
}

const app = defineApp(vocabulary, tables)

const feeds = app.group({ callers: ['human'] }, (r) => ({
	publish: r.mutation({
		input: z.strictObject({ title: z.string(), format: z.enum(['rss', 'json', 'html', 'svg']) }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'feeds.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const rendered = RENDERINGS[input.format](input.title)
		const feed = await ctx.files.put('feed', new TextEncoder().encode(rendered.body), { type: rendered.type, name: 'feed.xml' })
		const dump = await ctx.files.put('dump', new TextEncoder().encode(DUMP), { type: 'application/xml', name: 'products.xml' })
		const { id } = await ctx.db.app.feeds.insert({ feed, dump })
		return { id }
	}),
	dump: r.query({
		input: z.strictObject({ id: z.string() }),
		output: file('dump'),
		access: { action: 'feeds.read', app: true },
	}).handle(async ({ input, ctx }) => (await ctx.db.app.feeds.get(input.id)).dump),
}))

const published = app.group({}, (r) => ({
	feed: r.query({
		input: z.strictObject({ id: z.string() }),
		output: file('feed'),
		access: { public: true },
		actions: ['feeds.read'],
		http: { path: '/feed.xml' },
	}).handle(async ({ input, ctx }) => (await ctx.db.app('feeds.read').feeds.get(input.id)).feed),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { feeds, published }),
	files: {
		feed: c.files({ types: ['application/rss+xml', 'application/atom+xml'], maxBytes: 65536, inline: true }),
		dump: c.files({ types: ['application/xml'], maxBytes: 65536 }),
	},
}))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-inline-files-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261104120000_feeds.sql'),
	`CREATE TABLE feeds (
	id TEXT PRIMARY KEY,
	feed TEXT NOT NULL REFERENCES fabrika_files (id),
	dump TEXT NOT NULL REFERENCES fabrika_files (id)
) STRICT;
CREATE INDEX feeds_feed ON feeds (feed);
CREATE INDEX feeds_dump ON feeds (dump);
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'inline-files.test.ts' })
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database, files: new MemoryFileObjects() })
const publisher = kit.browser(kit.testCaller([{ action: 'feeds.read' }, { action: 'feeds.write' }]))

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

async function publish(title: string, format: keyof typeof RENDERINGS = 'rss'): Promise<Response> {
	return await publisher('/api/feeds.publish', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, format }),
	})
}

describe('the artifact of an inline file kind', () => {
	const artifact = compileContract(contract, tables)

	test('records inline on the kind, and inline-file on the row that answers it; every other file row stays file', () => {
		expect(artifact.fileKinds?.['feed']).toEqual({ types: ['application/atom+xml', 'application/rss+xml'], maxBytes: 65536, inline: true })
		expect(artifact.fileKinds?.['dump']).toEqual({ types: ['application/xml'], maxBytes: 65536 })
		expect(artifact.endpoints.find((row) => row.id === 'api.published.feed')).toMatchObject({
			method: 'GET',
			path: '/feed.xml',
			response: 'inline-file',
		})
		expect(artifact.endpoints.find((row) => row.id === 'api.feeds.dump')).toMatchObject({ response: 'file' })
		// The proxy reads the same profile from its table.
		const table = contractProxyTable(artifact)
		expect(table.endpoints.find((row) => row.id === 'api.published.feed')).toMatchObject({ response: 'inline-file' })
		expect(table.endpoints.find((row) => row.id === 'api.feeds.dump')).toMatchObject({ response: 'file' })
	})

	test('the artifact parser refuses a row whose profile disagrees with its kind, and an inline kind with SVG', () => {
		expect(() => parseContractArtifact(artifact)).not.toThrow()
		const downloaded = {
			...artifact,
			endpoints: artifact.endpoints.map((row) => row.id === 'api.published.feed' ? { ...row, response: 'file' as const } : row),
		}
		expect(() => parseContractArtifact(downloaded)).toThrow("'api.published.feed' is inline-file exactly when its file kind is inline")
		const shown = {
			...artifact,
			endpoints: artifact.endpoints.map((row) => row.id === 'api.feeds.dump' ? { ...row, response: 'inline-file' as const } : row),
		}
		expect(() => parseContractArtifact(shown)).toThrow("'api.feeds.dump' is inline-file exactly when its file kind is inline")
		const drawing = { ...artifact, fileKinds: { ...artifact.fileKinds, feed: { types: ['image/svg+xml'], maxBytes: 1024, inline: true as const } } }
		expect(() => parseContractArtifact(drawing)).toThrow('an inline kind admits only inert images and XML documents')
	})

	const withKind = (kind: { readonly types: readonly [string, ...string[]]; readonly inline?: boolean }) =>
		defineContract({ app: 'feeds', dimensions: {}, actions: { 'feeds.read': 'Read' }, roles: {} }, (c) => ({
			files: { feed: c.files({ maxBytes: 1024, ...kind }) },
			health: c.health('/healthz'),
		}))

	test('admits only inert images and XML documents, so nothing a browser runs or renders as a page is shown', () => {
		for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'application/json']) {
			expect(() => compileContract(withKind({ types: ['application/xml', type], inline: true }), {})).toThrow(
				`files 'feed': is served inline and admits '${type}', which a browser could run or render as a page`,
			)
			expect(() => compileContract(withKind({ types: ['application/xml', type] }), {})).not.toThrow('is served inline')
		}
		expect(compileContract(withKind({ types: ['image/png', 'text/xml'], inline: true }), {}).fileKinds?.['feed']?.inline).toBe(true)
	})

	test('carries inline only when declared, so the artifact of every other kind is what it was before', () => {
		for (const inline of [false, undefined]) {
			const artifact = compileContract(withKind({ types: ['application/xml'], ...(inline === undefined ? {} : { inline }) }), {})
			expect(Object.keys(artifact.fileKinds?.['feed'] ?? {})).not.toContain('inline')
		}
	})
})

describe('an inline file kind takes no upload', () => {
	const kinds = {
		feed: { types: ['application/rss+xml'], maxBytes: 65536, inline: true },
		dump: { types: ['application/xml'], maxBytes: 65536 },
	} as const
	const forms = ['field', 'optional', 'array'] as const
	// The same upload mutation, once into the inline kind and once into the kind of downloads, per form of a file field.
	const uploading = (kind: 'feed' | 'dump', form: (typeof forms)[number]) =>
		app.contract((c) => ({
			api: c.rpc('/api', {
				uploads: app.group({ callers: ['human'] }, (r) => ({
					upload: form === 'field'
						? r.mutation({ input: z.strictObject({ document: file(kind) }), output: z.strictObject({}), access: { action: 'feeds.write', app: true } })
							.handle(() => ({}))
						: form === 'optional'
						? r.mutation({
							input: z.strictObject({ document: z.optional(file(kind)) }),
							output: z.strictObject({}),
							access: { action: 'feeds.write', app: true },
						}).handle(() => ({}))
						: r.mutation({
							input: z.strictObject({ documents: z.array(file(kind)).max(2) }),
							output: z.strictObject({}),
							access: { action: 'feeds.write', app: true },
						}).handle(() => ({})),
				})),
			}),
			files: { feed: c.files(kinds.feed), dump: c.files(kinds.dump) },
		}))
	const refusal = "procedure 'api.uploads.upload': takes a file of the inline kind 'feed' in its input, which only the application writes"

	test('the build refuses a procedure that uploads into an inline kind, in every form of a file field', () => {
		for (const form of forms) {
			expect(() => compileContract(uploading('feed', form), tables)).toThrow(refusal)
			expect(compileContract(uploading('dump', form), tables).endpoints.map((row) => row.id)).toContain('api.uploads.upload')
		}
	})

	test('the build refuses it in a contract declared without an implementation too', () => {
		const declared = (kind: 'feed' | 'dump') =>
			defineContract(vocabulary, (c) => ({
				api: c.rpc('/api', { callers: ['human'] }, {
					uploads: {
						upload: c.mutation({
							input: z.strictObject({ document: file(kind) }),
							output: z.strictObject({}),
							access: { action: 'feeds.write', app: true },
						}),
					},
				}),
				files: { feed: c.files(kinds.feed), dump: c.files(kinds.dump) },
			}))
		expect(() => compileContract(declared('feed'), {})).toThrow(refusal)
		expect(() => compileContract(declared('dump'), {})).not.toThrow()
	})

	test('the artifact parser refuses a row that takes a file of an inline kind, at any depth of its input', () => {
		const artifact = compileContract(uploading('dump', 'field'), tables)
		expect(() => parseContractArtifact(artifact)).not.toThrow()
		const message = "'api.uploads.upload' takes a file of the inline kind 'dump', which only the application writes"
		const shownDumps = {
			...artifact,
			fileKinds: { ...artifact.fileKinds, dump: { ...kinds.dump, types: [...kinds.dump.types], inline: true as const } },
		}
		expect(() => parseContractArtifact(shownDumps)).toThrow(message)
		const nested = {
			...artifact,
			endpoints: artifact.endpoints.map((row) =>
				row.id === 'api.uploads.upload'
					? {
						...row,
						input: {
							type: 'object' as const,
							fields: { wrapped: { type: 'array' as const, items: { type: 'file' as const, kind: 'feed' }, minItems: null, maxItems: 2 } },
						},
					}
					: row
			),
		}
		expect(() => parseContractArtifact(nested)).toThrow("'api.uploads.upload' takes a file of the inline kind 'feed'")
	})
})

describe('serving the files of an inline kind', () => {
	test('a feed reader gets the feed inline at its public URL, under the sandbox CSP and nosniff', async () => {
		const response = await publish('News & <updates>')
		expect(response.status).toBe(200)
		const { id } = z.strictObject({ result: z.strictObject({ id: z.string() }) }).parse(await response.json()).result

		const feed = await kit.fetch(`/feed.xml?id=${id}`)
		expect(feed.status).toBe(200)
		expect(feed.headers.get('Content-Type')).toBe('application/rss+xml')
		expect(feed.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''feed.xml")
		expect(feed.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(feed.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
		expect(await feed.text()).toBe(RENDERINGS.rss('News & <updates>').body)

		// An XML file of a kind that does not declare inline stays a download.
		const dump = await publisher(`/api/feeds.dump?id=${id}`)
		expect(dump.status).toBe(200)
		expect(dump.headers.get('Content-Type')).toBe('application/xml')
		expect(dump.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''products.xml")
		expect(dump.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
	})

	test('a refusal of the inline row still carries the file treatment', async () => {
		const missing = await kit.fetch('/feed.xml?id=none')
		expect(missing.status).toBe(404)
		expect(missing.headers.get('Content-Disposition')).toStartWith('attachment')
		expect(missing.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
	})

	test('stores only bytes that are XML, and only the types the kind admits', async () => {
		expect((await publish('News', 'json')).status).toBe(415)
		expect((await publish('News', 'html')).status).toBe(415)
		expect((await publish('News', 'svg')).status).toBe(415)
	})
})
