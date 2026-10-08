import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as appApi from '../index.js'

describe('@fabrika/app root exports', () => {
	test('exclude runtime adapter APIs', () => {
		expect('createCloudflareWorker' in appApi).toBe(false)
		expect('createBunHandler' in appApi).toBe(false)
	})
})

const transpiler = new Bun.Transpiler({ loader: 'ts' })

/** The Node and Bun modules reachable from `entry` through relative imports. */
function serverImports(entry: string, seen = new Set<string>()): string[] {
	if (seen.has(entry)) {
		return []
	}
	seen.add(entry)
	return transpiler.scanImports(readFileSync(entry, 'utf8')).flatMap(({ path }) => {
		if (/^(node:|bun$|bun:)/.test(path)) {
			return [path]
		}
		if (!path.startsWith('.')) {
			return []
		}
		const base = resolve(dirname(entry), path.replace(/\.js$/, ''))
		const file = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
		if (file === undefined) {
			throw new Error(`${entry} imports ${path}, which does not resolve`)
		}
		return serverImports(file, seen)
	})
}

describe('@fabrika/app/client', () => {
	test('imports no server runtime, so a browser bundle can hold it', () => {
		expect(serverImports(join(import.meta.dir, '..', 'client', 'index.ts'))).toEqual([])
		// The witness sees one when it is there.
		expect(serverImports(join(import.meta.dir, '..', 'implement', 'index.ts'))).toContain('node:async_hooks')
	})
})
