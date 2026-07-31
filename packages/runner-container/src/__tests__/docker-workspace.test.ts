import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

async function manifest(path: string): Promise<Record<string, unknown>> {
	const value: unknown = await Bun.file(path).json()
	if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`)
	return value
}

function stringArray(value: unknown, source: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${source} must be an array of strings`)
	return value
}

describe('runner image workspace', () => {
	test('contains and copies the complete first-party dependency closure', async () => {
		const imageManifest = await manifest(resolve(REPO_ROOT, 'packages/runner-container/docker/package.json'))
		const workspaces = new Set(stringArray(imageManifest['workspaces'], 'runner image workspaces'))
		const packagePaths = new Map<string, string>()
		for (const directory of await readdir(resolve(REPO_ROOT, 'packages'))) {
			const path = `packages/${directory}`
			const manifestPath = resolve(REPO_ROOT, path, 'package.json')
			if (!(await Bun.file(manifestPath).exists())) continue
			const packageManifest = await manifest(manifestPath)
			const name = packageManifest['name']
			if (typeof name === 'string') packagePaths.set(name, path)
		}

		for (const workspace of workspaces) {
			const packageManifest = await manifest(resolve(REPO_ROOT, workspace, 'package.json'))
			const dependencies = packageManifest['dependencies']
			if (!isRecord(dependencies)) continue
			for (const [name, range] of Object.entries(dependencies)) {
				if (range !== 'workspace:*') continue
				const dependencyPath = packagePaths.get(name)
				expect(dependencyPath, `${workspace} dependency ${name}`).toBeDefined()
				if (dependencyPath !== undefined) expect(workspaces.has(dependencyPath), `${workspace} dependency ${name}`).toBe(true)
			}
		}

		const dockerfile = await Bun.file(resolve(REPO_ROOT, 'packages/runner-container/Dockerfile')).text()
		const copiedSources = dockerfile
			.split('\n')
			.filter((line) => line.startsWith('COPY packages/'))
			.map((line) => line.split(' ')[1])
			.filter((source) => source !== undefined)
		for (const workspace of workspaces) {
			expect(
				copiedSources.some((source) => source === workspace || source.startsWith(`${workspace}/`)),
				`${workspace} must be copied into the runner image`,
			).toBe(true)
		}
	})
})
