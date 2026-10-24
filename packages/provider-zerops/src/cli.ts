#!/usr/bin/env bun
import type { AppCli } from '@fabrika/provider-contract/app-cli'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { isZeropsAppConfig } from './authoring'
import { parseZeropsCliArgs } from './cli-args'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type FabrikaManifest,
	manifestServiceHostnames,
	ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
} from './manifest'
import { zeropsNamespaceCli } from './namespace-cli'
import type { ZeropsAppConfig } from './types'

const USAGE = `Zerops app tools

Usage:
  fabrika app build --provider=zerops --env=<env> [--config=<path>] [--output=<path>]

Options:
  --env=<env>                    Environment.
  --config=<path>                App config (default: ./fabrika.config.ts).
  --output=<path>                Artifact path (default: ./fabrika.manifest.json).
  -h, --help                     Show this help.
`

const configModuleSchema = z.object({ default: z.unknown() })

const loadConfig = async (path: string): Promise<ZeropsAppConfig> => {
	const absolute = resolve(process.cwd(), path)
	const loaded: unknown = await import(absolute)
	const config = configModuleSchema.safeParse(loaded).data?.default
	if (!isZeropsAppConfig(config)) {
		throw new Error(`Config at ${absolute} must default-export defineApp({ target: { platform: 'zerops', ... } })`)
	}
	return config
}

export const readZeropsSourceDescriptor = async (root: string = process.cwd()) => {
	const path = resolve(root, 'zerops.yaml')
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			throw new Error(`Missing repository-root Zerops source descriptor: ${path}`)
		}
		if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
			throw new Error(`Repository-root Zerops source descriptor must not be a symlink: ${path}`)
		}
		throw error
	})
	try {
		const metadata = await file.stat()
		if (!metadata.isFile()) {
			throw new Error(`Repository-root Zerops source descriptor must be a regular file: ${path}`)
		}
		if (metadata.size > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES) {
			throw new Error(`Zerops source descriptor exceeds ${ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES} bytes: ${path}`)
		}
		const bytes = await file.readFile()
		let contents: string
		try {
			contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
		} catch {
			throw new Error(`Zerops source descriptor is not valid UTF-8: ${path}`)
		}
		return await createZeropsArtifactSourceDescriptor(contents)
	} finally {
		await file.close()
	}
}

export interface ZeropsManifestBuildOptions {
	/** App config path, resolved against the working directory like `--config`. */
	readonly config: string
	readonly env: string
}

const compileManifest = async (options: ZeropsManifestBuildOptions): Promise<FabrikaManifest> => {
	const config = await loadConfig(options.config)
	const sourceDescriptor = await readZeropsSourceDescriptor()
	return compileFabrikaManifest(config, options.env, sourceDescriptor)
}

const serializeManifest = (manifest: FabrikaManifest): string => `${JSON.stringify(manifest, null, '\t')}\n`

/** The exact text `build` writes to `fabrika.manifest.json`, produced in memory and written nowhere. */
export const buildZeropsManifestText = async (options: ZeropsManifestBuildOptions): Promise<string> =>
	serializeManifest(await compileManifest(options))

export const runZeropsCli = async (argv: readonly string[]): Promise<void> => {
	const args = parseZeropsCliArgs(argv)
	if (args.help || args.command === undefined) {
		console.info(USAGE)
		return
	}
	if (args.command !== 'build') {
		throw new Error(`Unknown command: ${args.command}\n${USAGE}`)
	}
	if (args.env === undefined || args.env === '') {
		throw new Error('`build` requires --env=<env>')
	}
	const manifest = await compileManifest({ config: args.config, env: args.env })
	const output = resolve(process.cwd(), args.output)
	await Bun.write(output, serializeManifest(manifest))
	console.info(`wrote ${output} (${manifestServiceHostnames(manifest).length} service(s))`)
}

/** What `fabrika app build`, `app register` and `fabrika namespace` run for an application on Zerops. */
export const appCli: AppCli = {
	provider: 'zerops',
	entryRuntime: 'bun',
	build: (argv) => runZeropsCli(['build', ...argv]),
	registrationManifest: buildZeropsManifestText,
	namespaces: zeropsNamespaceCli,
}

if (import.meta.main) {
	await runZeropsCli(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	})
}
