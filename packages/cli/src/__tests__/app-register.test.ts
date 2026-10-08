import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runCli } from '..'
import { registerCompiledManifest, runControlCli } from '../control.js'

const CONTROL_ENV = { FABRIKA_CONTROL_URL: 'https://control.example', FABRIKA_CONTROL_KEY: 'px_test' } as const
const REGISTERED = { result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } }
const authoringUrl = pathToFileURL(resolve(import.meta.dir, '../../../provider-zerops/src/authoring.ts')).href

const realFetch = globalThis.fetch
const realCwd = process.cwd()
const realInfo = console.info
const roots: string[] = []
const savedEnv = new Map<string, string | undefined>()

afterEach(async () => {
	globalThis.fetch = realFetch
	console.info = realInfo
	process.chdir(realCwd)
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	savedEnv.clear()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Record each request body exactly as it went on the wire, and answer with one RPC envelope. */
const captureRawBodies = (answer: unknown, status = 200): string[] => {
	const bodies: string[] = []
	globalThis.fetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			bodies.push(typeof init?.body === 'string' ? init.body : '')
			return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
		},
		{ preconnect: realFetch.preconnect },
	)
	return bodies
}

const silenceStdout = (): void => {
	console.info = () => {}
}

/** A Zerops app repository root with its config and, optionally, its descriptor, made the working directory. */
const appRepository = async (options: { descriptor: boolean }): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-app-register-'))
	roots.push(root)
	await writeFile(
		join(root, 'fabrika.config.ts'),
		`import { defineApp } from ${
			JSON.stringify(authoringUrl)
		}\nexport default defineApp({ id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }] } })\n`,
	)
	if (options.descriptor) {
		await writeFile(join(root, 'zerops.yaml'), 'zerops:\r\n  - setup: notes\r\n')
	}
	process.chdir(root)
	return root
}

/** `runCli` reads the process environment, as the real command does. */
const useControlEnv = (): void => {
	for (const [name, value] of Object.entries(CONTROL_ENV)) {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
		process.env[name] = value
	}
}

const registrationFlags = ['--app=notes', '--repo=https://github.com/acme/notes', '--env=prod', '--namespace=notes-prod', '--domain=notes.example']

describe('app register', () => {
	for (
		const [label, installation] of [
			['resolved private (installation omitted)', []],
			['public (--installation-id=none)', ['--installation-id=none']],
			['explicit installation', ['--installation-id=154387356']],
		] as const
	) {
		test(`sends the byte-identical request to registering the built file: ${label}`, async () => {
			const root = await appRepository({ descriptor: true })
			useControlEnv()
			silenceStdout()
			const flags = [...registrationFlags, ...installation]

			await runCli(['app', 'build', '--env=prod'])
			const manifestPath = join(root, 'fabrika.manifest.json')
			const fromDisk = captureRawBodies(REGISTERED)
			await runControlCli('register', [...flags, `--manifest=${manifestPath}`], 'zerops', CONTROL_ENV)
			await rm(manifestPath)

			const inMemory = captureRawBodies(REGISTERED)
			await runCli(['app', 'register', ...flags])

			expect(fromDisk).toHaveLength(1)
			expect(fromDisk[0]).toContain('setup: notes')
			expect(inMemory).toEqual(fromDisk)
			expect((await readdir(root)).sort()).toEqual(['fabrika.config.ts', 'zerops.yaml'])
		})
	}

	test('a compile failure names the compile phase, registers nothing and writes nothing', async () => {
		const root = await appRepository({ descriptor: false })
		useControlEnv()
		const bodies = captureRawBodies(REGISTERED)

		await expect(runCli(['app', 'register', ...registrationFlags])).rejects.toThrow(
			/^Compile phase failed; nothing was registered\. Missing repository-root Zerops source descriptor/,
		)
		expect(bodies).toEqual([])
		expect((await readdir(root)).sort()).toEqual(['fabrika.config.ts'])
	})

	test('a Control refusal names the register phase, keeps the RPC error type and writes nothing', async () => {
		const root = await appRepository({ descriptor: true })
		useControlEnv()
		captureRawBodies({ error: { type: 'conflict', message: 'app notes already exists' } }, 409)

		await expect(runCli(['app', 'register', ...registrationFlags])).rejects.toThrow(
			'Register phase failed after a successful compile; no manifest file was written. conflict: app notes already exists',
		)
		expect((await readdir(root)).sort()).toEqual(['fabrika.config.ts', 'zerops.yaml'])
	})

	test('checks inputs and the environment-only credential before compiling', async () => {
		let compiled = 0
		const compile = async (): Promise<string> => {
			compiled += 1
			return '{"manifestVersion":2}\n'
		}
		await expect(registerCompiledManifest(registrationFlags, 'zerops', compile, { FABRIKA_CONTROL_URL: 'https://control.example' }))
			.rejects.toThrow('FABRIKA_CONTROL_KEY is required (environment only')
		await expect(registerCompiledManifest(['--app=notes', '--env=prod'], 'zerops', compile, CONTROL_ENV)).rejects.toThrow('--repo is required')
		await expect(registerCompiledManifest([...registrationFlags, '--manifest=old.json'], 'zerops', compile, CONTROL_ENV)).rejects.toThrow(
			'takes no --manifest',
		)
		await expect(registerCompiledManifest([...registrationFlags, '--output=out.json'], 'zerops', compile, CONTROL_ENV)).rejects.toThrow(
			'takes no --output',
		)
		expect(compiled).toBe(0)
	})
})
