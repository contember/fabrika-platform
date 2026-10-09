// `fabrika connect`: the snapshot is written from the description Control answers for the owner's approved export, and
// only from a description that is what it claims to be. Control here is a fake `fetch` that serves a compiled
// contract's description; the key is a credential, so no message may carry it.

import { compileContract, CONNECT_LIMITS, defineContract, exportDescription, snapshotNames, snapshotSource } from '@fabrika/app/contract'
import { type ExportDescription, exportDigest } from '@fabrika/auth-core'
import { checkApplication, formatFinding } from '@fabrika/check'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { type ConnectCommandDependencies, runConnectCommand } from '../connect'

const KEY = 'px_control_key_for_the_shop'
const ORIGIN = 'https://control.example.com'

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

/** Serves `answer` to a request that carries the Control key, and 403 to any other. */
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
	source: Record<string, string> = { FABRIKA_CONTROL_KEY: KEY, FABRIKA_CONTROL_URL: ORIGIN },
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

const target = ['catalog/products@1', '--consumer=shop', '--env=prod']
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
		expect(request?.url).toBe(`${ORIGIN}/api/rpc`)
		expect(request?.method).toBe('POST')
		const body: unknown = await request?.json()
		expect(body).toEqual({ method: 'connectors.describe', input: { consumer: 'shop', env: 'prod', app: 'catalog', export: 'products', version: 1 } })
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

	test('a refused key, an unreachable Control and a missing key never print the key', async () => {
		const root = appRoot()
		const refused = await failure(
			run(root, 'add', target, serving(catalog(z.int())).fetch, { FABRIKA_CONTROL_KEY: 'px_other', FABRIKA_CONTROL_URL: ORIGIN }),
		)
		expect(refused).toBe(`${ORIGIN} refused FABRIKA_CONTROL_KEY for catalog/products@1 (403); the key must hold deploy.read on shop`)
		const down = await failure(run(root, 'add', target, () => Promise.reject(new TypeError(`connect failed with ${KEY}`))))
		expect(down).toBe(`${ORIGIN} could not be reached for catalog/products@1`)
		expect(await failure(run(root, 'add', target, serving(catalog(z.int())).fetch, { FABRIKA_CONTROL_URL: ORIGIN }))).toContain(
			'FABRIKA_CONTROL_KEY must hold',
		)
		expect(`${refused}${down}`).not.toContain(KEY)
	})

	test('an export the owner environment did not approve for the consumer is a 404 that names the request', async () => {
		const root = appRoot()
		const fake = owner(() => Response.json({ error: { type: 'not_found' } }, { status: 404 }))
		expect(await failure(run(root, 'add', target, fake.fetch))).toBe('catalog@prod has approved no export products@1 for shop')
	})

	test("needs the consumer and the environment, and Control's https origin unless it is localhost", async () => {
		const root = appRoot()
		const fake = serving(catalog(z.int()))
		expect(await failure(run(root, 'add', ['catalog/products@1', '--env=prod'], fake.fetch))).toContain('needs --consumer=')
		expect(await failure(run(root, 'add', target, fake.fetch, { FABRIKA_CONTROL_KEY: KEY }))).toContain("needs Control's origin")
		for (const origin of ['http://control.example.com', `${ORIGIN}/api`, 'https://user:pass@control.example.com']) {
			expect(await failure(run(root, 'add', [...target, `--url=${origin}`], fake.fetch))).toContain("Control's origin must be an https origin")
		}
		expect(fake.requests).toEqual([])
		await run(root, 'add', [...target, '--url=http://control.fabrika.localhost:18080'], fake.fetch)
		expect(fake.requests[0]?.url).toBe('http://control.fabrika.localhost:18080/api/rpc')
	})
})

describe('fabrika connect add against an owner that misbehaves', () => {
	test('a description with a property named after the key is refused with a diagnostic that does not carry the key', async () => {
		const root = appRoot()
		const reflected = owner(() => Response.json({ result: { ...catalog(z.int()), [KEY]: true } }))
		const message = await failure(run(root, 'add', target, reflected.fetch))
		expect(message).not.toContain(KEY)
	})

	test('a description the parser refuses gets a fixed diagnostic: the field and the code, nothing it wrote', async () => {
		const root = appRoot()
		const reflected = owner(() => Response.json({ result: { ...catalog(z.int()), 'px_other_secret': true } }))
		expect(await failure(run(root, 'add', target, reflected.fetch))).toBe(
			`${ORIGIN} served no valid description of catalog/products@1: description: invalid at (root) (unrecognized_keys)`,
		)
	})

	test('a description that quotes the key is never written', async () => {
		const root = appRoot()
		const served = catalog(z.int())
		const renamed = { ...served, procedures: { [KEY]: served.procedures['get'] ?? { input: null, output: { type: 'null' } } } }
		const fake = serving({ ...renamed, digest: exportDigest(renamed) })
		const message = await failure(run(root, 'add', target, fake.fetch))
		expect(message).toBe(`${ORIGIN} answered catalog/products@1 with a description that contains FABRIKA_CONTROL_KEY; nothing was written`)
		expect(() => readFileSync(join(root, file))).toThrow()
	})

	test('a 307 is an error and is never followed', async () => {
		const root = appRoot()
		const fake = owner(() => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.com/' } }))
		expect(await failure(run(root, 'add', target, fake.fetch))).toContain('a redirect, which fabrika connect never follows')
		expect(fake.requests.map((request) => request.redirect)).toEqual(['manual'])
	})

	test('a description over the byte budget is refused and its stream cancelled', async () => {
		const root = appRoot()
		let cancelled = false
		let sent = 0
		const chunk = new Uint8Array(64 * 1024).fill(0x20)
		const fake = owner(() =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent >= 8 * 1024 * 1024) {
							controller.close()
							return
						}
						sent += chunk.byteLength
						controller.enqueue(chunk)
					},
					cancel() {
						cancelled = true
					},
				}),
				{ headers: { 'Content-Type': 'application/json' } },
			)
		)
		expect(await failure(run(root, 'add', target, fake.fetch))).toContain(`a description larger than ${CONNECT_LIMITS.maxDescriptionBytes} bytes`)
		expect(cancelled).toBe(true)
	})

	test('a description served as text/html is refused', async () => {
		const root = appRoot()
		const fake = owner(() => new Response(JSON.stringify({ result: catalog(z.int()) }), { headers: { 'Content-Type': 'text/html' } }))
		expect(await failure(run(root, 'add', target, fake.fetch))).toBe(`${ORIGIN} answered catalog/products@1 with no application/json body`)
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
