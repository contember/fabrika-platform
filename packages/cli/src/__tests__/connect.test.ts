// `fabrika connect`: the snapshot is written from the description the owner serves to the edge key, and only from a
// description that is what it claims to be. The owner here is a fake `fetch` that serves a compiled contract's
// description; the key is a credential, so no message may carry it.

import { compileContract, defineContract, exportDescription, snapshotNames, snapshotSource } from '@fabrika/app/contract'
import type { ExportDescription } from '@fabrika/auth-core'
import { checkApplication, formatFinding } from '@fabrika/check'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { type ConnectCommandDependencies, runConnectCommand } from '../connect'

const KEY = 'px_edge_key_for_the_shop'
const ORIGIN = 'https://catalog.example.com'

function catalog(price: z.ZodType): ExportDescription {
	const contract = defineContract({
		app: 'catalog',
		dimensions: { catalog: {} },
		actions: { 'catalog.product.read': 'Read the products' },
		roles: { reader: { grants: ['catalog.product.read'] } },
	}, (c) => ({
		exports: {
			products: c.export({
				version: 1,
				consumers: ['shop'],
				audience: 'any consumer user',
				procedures: {
					get: c.query({
						input: z.strictObject({ sku: z.string() }),
						output: z.strictObject({ sku: z.string(), price }),
						access: { action: 'catalog.product.read', over: 'catalog' },
					}),
				},
			}),
		},
	}))
	const description = exportDescription(compileContract(contract, {}), 'products')
	if (description === null) {
		throw new Error('the fixture exports no products')
	}
	return description
}

const roots: string[] = []
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function appRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-connect-cli-'))
	roots.push(root)
	return root
}

interface Owner {
	readonly requests: Request[]
	readonly fetch: ConnectCommandDependencies['fetch']
}

/** Serves `answer` to a request that carries the edge key, and 403 to any other. */
function owner(answer: () => Response): Owner {
	const requests: Request[] = []
	return {
		requests,
		fetch: (request) => {
			requests.push(request)
			return Promise.resolve(request.headers.get('Authorization') === `Bearer ${KEY}` ? answer() : new Response('forbidden', { status: 403 }))
		},
	}
}

const serving = (description: ExportDescription) => owner(() => Response.json({ result: description }))

async function run(
	root: string,
	command: string,
	argv: readonly string[],
	fetchOwner: ConnectCommandDependencies['fetch'],
	source: Record<string, string> = { FABRIKA_CONNECT_KEY: KEY },
): Promise<{ readonly out: string; readonly notes: string }> {
	const out: string[] = []
	const notes: string[] = []
	await runConnectCommand(command, argv, { cwd: root, source, fetch: fetchOwner, write: (line) => out.push(line), note: (line) => notes.push(line) })
	return { out: out.join(''), notes: notes.join('') }
}

async function failure(work: Promise<unknown>): Promise<string> {
	try {
		await work
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('the command did not fail')
}

const target = ['catalog/products@1', `--origin=${ORIGIN}`]
const file = snapshotNames('catalog', 'products', 1).file

describe('fabrika connect add', () => {
	test('writes the snapshot of the served description, which the checker reads as a literal', async () => {
		const root = appRoot()
		const served = catalog(z.int())
		const fake = serving(served)
		const { out, notes } = await run(root, 'add', target, fake.fetch)
		expect(out).toBe(`${file}\n`)
		expect(readFileSync(join(root, file), 'utf8')).toBe(snapshotSource(served))
		expect(notes).toContain("import { catalogProductsV1Digest } from './fabrika/connect/catalog.products.v1'")
		const [request] = fake.requests
		expect(request?.url).toBe(`${ORIGIN}/__fabrika/connect/products.v1`)
		expect(request?.method).toBe('POST')
		const findings = await checkApplication({ root, files: new Map([[file, readFileSync(join(root, file), 'utf8')]]) })
		expect(findings.map(formatFinding)).toEqual([])
	})

	test('refuses an existing snapshot', async () => {
		const root = appRoot()
		await run(root, 'add', target, serving(catalog(z.int())).fetch)
		expect(await failure(run(root, 'add', target, serving(catalog(z.int())).fetch))).toBe(
			`connect add: ${file} exists; run fabrika connect pull to rewrite it`,
		)
	})

	test('a description whose digest is not its content, or of another export, is refused and nothing is written', async () => {
		const root = appRoot()
		const tampered = { ...catalog(z.int()), digest: catalog(z.string()).digest }
		expect(await failure(run(root, 'add', target, serving(tampered).fetch))).toContain('served no valid description of catalog/products@1')
		const other = catalog(z.int())
		const renamed = owner(() => Response.json({ result: { ...other, app: 'warehouse' } }))
		expect(await failure(run(root, 'add', target, renamed.fetch))).toContain('served no valid description')
		expect(() => readFileSync(join(root, file))).toThrow()
	})

	test('a refused key, an unreachable owner and a missing key never print the key', async () => {
		const root = appRoot()
		const refused = await failure(run(root, 'add', target, serving(catalog(z.int())).fetch, { FABRIKA_CONNECT_KEY: 'px_other' }))
		expect(refused).toBe(`${ORIGIN} refused FABRIKA_CONNECT_KEY for catalog/products@1 (403); the key must hold the export's actions`)
		const down = await failure(run(root, 'add', target, () => Promise.reject(new TypeError(`connect failed with ${KEY}`))))
		expect(down).toBe(`${ORIGIN} could not be reached for catalog/products@1`)
		expect(await failure(run(root, 'add', target, serving(catalog(z.int())).fetch, {}))).toContain('FABRIKA_CONNECT_KEY must hold')
		expect(`${refused}${down}`).not.toContain(KEY)
	})

	test('a plain-http origin is refused except on localhost, and so is one with a path', async () => {
		const root = appRoot()
		const fake = serving(catalog(z.int()))
		for (const origin of ['http://catalog.example.com', `${ORIGIN}/api`, 'https://user:pass@catalog.example.com']) {
			expect(await failure(run(root, 'add', ['catalog/products@1', `--origin=${origin}`], fake.fetch))).toContain('--origin must be an https origin')
		}
		expect(fake.requests).toEqual([])
		await run(root, 'add', ['catalog/products@1', '--origin=http://catalog.localhost:8080'], fake.fetch)
		expect(fake.requests[0]?.url).toBe('http://catalog.localhost:8080/__fabrika/connect/products.v1')
	})
})

describe('fabrika connect pull', () => {
	test('rewrites the snapshot and says whether the export changed', async () => {
		const root = appRoot()
		await run(root, 'add', target, serving(catalog(z.int())).fetch)
		expect((await run(root, 'pull', target, serving(catalog(z.int())).fetch)).notes).toContain('the export is unchanged')
		const changed = catalog(z.string())
		const { out, notes } = await run(root, 'pull', target, serving(changed).fetch)
		expect(out).toBe(`${file}\n`)
		expect(notes).toContain(`its digest is now ${changed.digest}`)
		expect(readFileSync(join(root, file), 'utf8')).toBe(snapshotSource(changed))
	})

	test('refuses a snapshot that was never added', async () => {
		const root = appRoot()
		writeFileSync(join(root, 'unrelated.ts'), '')
		expect(await failure(run(root, 'pull', target, serving(catalog(z.int())).fetch))).toBe(
			`connect pull: ${file} does not exist; run fabrika connect add first`,
		)
	})
})
