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

const RSS = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>News</title></channel></rss>\n'
const DUMP = '<?xml version="1.0"?>\n<products/>\n'

const app = defineApp(vocabulary, tables)

const feeds = app.group({ callers: ['human'] }, (r) => ({
	publish: r.mutation({
		input: z.strictObject({ feed: z.string(), type: z.string() }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'feeds.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const feed = await ctx.files.put('feed', new TextEncoder().encode(input.feed), { type: input.type, name: 'feed.xml' })
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

async function publish(feed: string, type = 'application/rss+xml'): Promise<Response> {
	return await publisher('/api/feeds.publish', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ feed, type }),
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

describe('serving the files of an inline kind', () => {
	test('a feed reader gets the feed inline at its public URL, under the sandbox CSP and nosniff', async () => {
		const response = await publish(RSS)
		expect(response.status).toBe(200)
		const { id } = z.strictObject({ result: z.strictObject({ id: z.string() }) }).parse(await response.json()).result

		const feed = await kit.fetch(`/feed.xml?id=${id}`)
		expect(feed.status).toBe(200)
		expect(feed.headers.get('Content-Type')).toBe('application/rss+xml')
		expect(feed.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''feed.xml")
		expect(feed.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(feed.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
		expect(await feed.text()).toBe(RSS)

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
		expect((await publish('{"items": []}')).status).toBe(415)
		expect((await publish('<html><script>alert(1)</script></html>', 'text/html')).status).toBe(415)
		expect((await publish('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')).status).toBe(415)
	})
})
