// The two entrypoints must not be able to load each other's runtime. This test proves it rather than
// trusting it.
//
// Why it needs proving: nothing in the type system stops someone adding `import { X } from
// 'cloudflare:workers'` to a file that `src/node/server.ts` reaches, or reaching for `node:fs` inside
// `src/app.ts`. Both compile. Both typecheck. The first one fails at Bun startup with an
// unresolvable module; the second fails on Workers — and neither failure shows up in any other test
// here, because the suite runs under Bun with `cloudflare:workers` mocked out.
//
// So this walks the import graph from each entrypoint, following FIRST-PARTY relative imports only,
// and asserts what each closure is allowed to name. External packages are judged by their specifier
// (`@fabrika/platform-node` is Bun-only by construction and is listed as such); their own internals
// are not this package's business.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..')

/** Every module specifier that appears in `source` — static, type-only, side-effect and dynamic alike. */
function specifiersOf(source: string): string[] {
	const found: string[] = []
	// `import … from 'x'`, `export … from 'x'`, bare `import 'x'`, and `import('x')`.
	const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1]
			if (specifier !== undefined) {
				found.push(specifier)
			}
		}
	}
	return found
}

/** Resolve a relative specifier to a real file under `src/`, or null when it does not name one. */
function resolveLocal(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) {
		return null
	}
	const base = resolve(dirname(fromFile), specifier)
	for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
		try {
			readFileSync(candidate, 'utf8')
			return candidate
		} catch {
			// Not this shape; try the next.
		}
	}
	throw new Error(`unresolvable local import '${specifier}' in ${relative(SRC, fromFile)}`)
}

interface Graph {
	/** Every first-party file reachable from the entry, including the entry itself. */
	files: string[]
	/** Every EXTERNAL specifier named anywhere in that closure. */
	externals: Set<string>
}

function walk(entry: string): Graph {
	const seen = new Set<string>()
	const externals = new Set<string>()
	const queue = [resolve(SRC, entry)]
	while (queue.length > 0) {
		const file = queue.pop()
		if (file === undefined || seen.has(file)) {
			continue
		}
		seen.add(file)
		for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
			const local = resolveLocal(file, specifier)
			if (local === null) {
				externals.add(specifier)
			} else if (!seen.has(local)) {
				queue.push(local)
			}
		}
	}
	return { files: [...seen].map((f) => relative(SRC, f)).sort(), externals }
}

/** Specifiers only a Cloudflare Worker can resolve. */
const CLOUDFLARE_ONLY = (specifier: string): boolean => specifier === 'cloudflare:workers' || specifier.startsWith('cloudflare:')

/** Specifiers only a Bun/Node process can resolve (or that pull one in). */
const PROCESS_ONLY = (specifier: string): boolean =>
	specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier === '@fabrika/platform-node'

describe('entrypoint isolation', () => {
	test('the Worker entrypoint reaches no Bun/Node-only module', () => {
		const graph = walk('index.ts')
		expect([...graph.externals].filter(PROCESS_ONLY)).toEqual([])
		// Not vacuous: it really did walk the graph, and it really is the Cloudflare side.
		expect(graph.files).toContain('index.ts')
		expect(graph.files).toContain('rpc.ts')
		expect(graph.files).toContain('app.ts')
		expect(graph.files).toContain('db.ts')
		expect([...graph.externals]).toContain('cloudflare:workers')
	})

	test('the Bun entrypoint reaches no Cloudflare-only module', () => {
		const graph = walk('node/server.ts')
		expect([...graph.externals].filter(CLOUDFLARE_ONLY)).toEqual([])
		// …and in particular it must never pull in `index.ts`, the only file that imports the Worker API.
		expect(graph.files).not.toContain('index.ts')
		// Not vacuous: it walked the graph, it is the process side, and it shares the route/RPC layer.
		expect(graph.files).toContain('node/server.ts')
		expect(graph.files).toContain('rpc.ts')
		expect(graph.files).toContain('app.ts')
		expect(graph.files).toContain('db.ts')
		expect([...graph.externals]).toContain('@fabrika/platform-node')
	})

	test('the cron command and the migration runner stay on the process side too', () => {
		for (const entry of ['node/prune.ts', 'node/migrate.ts']) {
			const graph = walk(entry)
			expect([...graph.externals].filter(CLOUDFLARE_ONLY)).toEqual([])
			expect(graph.files).not.toContain('index.ts')
		}
		// The cron work itself is shared — `scheduled()` on Workers calls the same function.
		expect(walk('node/prune.ts').files).toContain('cron.ts')
		expect(walk('index.ts').files).toContain('cron.ts')
	})

	test('the SHARED layer names neither runtime', () => {
		// The layer both entrypoints sit on. If any of these ever needs a runtime-specific import, the
		// dependency belongs behind a port in `env.ts`, not inlined here.
		for (const entry of ['app.ts', 'rpc.ts', 'cron.ts', 'rpc-http.ts', 'db.ts', 'services.ts']) {
			const graph = walk(entry)
			expect([...graph.externals].filter(CLOUDFLARE_ONLY)).toEqual([])
			expect([...graph.externals].filter(PROCESS_ONLY)).toEqual([])
		}
	})
})
