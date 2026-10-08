#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const SCHEMA_SOURCES: Record<string, string> = {
	'import-project-yml-json-schema.json': 'https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json',
	'zerops-yaml-json-schema.json': 'https://api.app-prg1.zerops.io/api/rest/public/settings/zerops-yaml-json-schema.json',
}
export type DriftResult = { file: string; status: 'unchanged' | 'changed' | 'unavailable' }
export const checkUpstreamSchemas = async (dependencies: {
	readPinned: (file: string) => Promise<string>
	fetch: (url: string) => Promise<Response>
}): Promise<DriftResult[]> => {
	const results: DriftResult[] = []
	for (const [file, url] of Object.entries(SCHEMA_SOURCES)) {
		const pinned: unknown = JSON.parse(await dependencies.readPinned(file))
		try {
			const response = await dependencies.fetch(url)
			if (!response.ok) {
				results.push({ file, status: 'unavailable' })
				continue
			}
			const upstream: unknown = await response.json()
			results.push({ file, status: isDeepStrictEqual(pinned, upstream) ? 'unchanged' : 'changed' })
		} catch {
			results.push({ file, status: 'unavailable' })
		}
	}
	return results
}
export const driftExitCode = (results: readonly DriftResult[]): number =>
	results.some((result) => result.status === 'unavailable') ? 2 : results.some((result) => result.status === 'changed') ? 1 : 0

if (import.meta.main) {
	const args = process.argv.slice(2)
	if (args.some((arg) => !['--help', '--json', '--quiet', '-q'].includes(arg))) {
		console.error('Unknown argument. Use --help for usage.')
		process.exitCode = 2
	} else if (args.includes('--help')) {
		console.info(
			'Usage: bun schemas/check.ts [--json | --quiet]\nCompare pinned Zerops schemas with upstream, without writing files. No credentials or stdin required.\n--json: emit an array of {file,status}; --quiet/-q: print only changed or unavailable filenames.\nExit codes: 0 unchanged, 1 drift, 2 unavailable or invalid invocation. Each request times out after 30 seconds.',
		)
	} else {
		try {
			const results = await checkUpstreamSchemas({
				readPinned: (file) => readFile(resolve(import.meta.dir, file), 'utf8'),
				fetch: (url) => fetch(url, { signal: AbortSignal.timeout(30_000) }),
			})
			if (args.includes('--json')) console.info(JSON.stringify(results))
			else if (args.includes('--quiet') || args.includes('-q')) {
				for (const result of results) if (result.status !== 'unchanged') console.info(result.file)
			} else {
				for (const result of results) console.info(`${result.file}: ${result.status}`)
			}
			process.exitCode = driftExitCode(results)
		} catch {
			console.error('Could not read the pinned Zerops schema documents.')
			process.exitCode = 2
		}
	}
}
