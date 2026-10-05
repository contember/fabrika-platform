import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import manifest from '../../package.json'

const packageRoot = resolve(import.meta.dir, '../..')
const src = join(packageRoot, 'src')
const scanner = new Bun.Transpiler({ loader: 'ts' })
const runtimePackages = ['@fabrika/platform-node', '@fabrika/provider-cloudflare', '@fabrika/dashboard']

function resolveLocal(file: string, specifier: string): string {
	const base = resolve(dirname(file), specifier)
	const sourceBase = base.replace(/\.js$/, '')
	const candidates = [`${sourceBase}.ts`, `${sourceBase}.tsx`, base, join(base, 'index.ts')]
	const found = candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile())
	if (found === undefined) throw new Error(`unresolved import ${specifier} from ${relative(src, file)}`)
	return found
}

test('shared Operations entrypoints reach no runtime-specific module', () => {
	const entries = Object.entries(manifest.exports)
		.filter(([name]) => name !== './platform-cf' && !name.startsWith('./node/'))
		.map(([, entry]) => resolve(packageRoot, entry.bun))
	const pending = [...entries, join(src, 'app.ts')]
	const visited = new Set<string>()
	const violations: string[] = []
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || visited.has(file)) continue
		visited.add(file)
		for (const { path: specifier } of scanner.scanImports(readFileSync(file, 'utf8'))) {
			const edge = `${relative(src, file)} -> ${specifier}`
			if (specifier.startsWith('.')) {
				const local = resolveLocal(file, specifier)
				const name = relative(src, local)
				if (name.startsWith('node/') || name === 'platform-cf.ts') violations.push(edge)
				pending.push(local)
			} else if (
				isBuiltin(specifier) || specifier === 'bun' || /^(bun|node|cloudflare):/.test(specifier)
				|| runtimePackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))
			) {
				violations.push(edge)
			}
		}
	}
	expect(violations).toEqual([])
	expect([...visited].map((file) => relative(src, file))).toEqual(expect.arrayContaining(['index.ts', 'app.ts', 'operator.ts', 'source-maps.ts']))
})
