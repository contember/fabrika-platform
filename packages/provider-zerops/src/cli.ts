#!/usr/bin/env bun
import { resolve } from 'node:path'
import { defineApp } from './authoring'
import { parseZeropsCliArgs } from './cli-args'
import { compileFabrikaManifest } from './manifest'
import type { ZeropsAppConfig } from './types'

const USAGE = `fabrika-zerops — Zerops provider tools

Usage:
  fabrika-zerops build --env=<env> [--config=<path>] [--output=<path>]

Options:
  --env=<env>       Environment compiled into the static artifact.
  --config=<path>   App config (default: ./fabrika.config.ts).
  --output=<path>   Artifact path (default: ./fabrika.manifest.json).
  -h, --help        Show this help.
`

const property = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

const isZeropsAppConfig = (value: unknown): value is ZeropsAppConfig => {
	const id = property(value, 'id')
	const target = property(value, 'target')
	return typeof id === 'string'
		&& property(target, 'platform') === 'zerops'
		&& typeof property(target, 'services') === 'function'
}

const loadConfig = async (path: string): Promise<ZeropsAppConfig> => {
	const absolute = resolve(process.cwd(), path)
	const loaded: unknown = await import(absolute)
	const config = property(loaded, 'default')
	if (!isZeropsAppConfig(config)) {
		throw new Error(`Config at ${absolute} must default-export defineApp({ target: { platform: 'zerops', ... } })`)
	}
	return defineApp(config)
}

const main = async (): Promise<void> => {
	const args = parseZeropsCliArgs(process.argv.slice(2))
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
	const config = await loadConfig(args.config)
	const manifest = compileFabrikaManifest(config, args.env)
	const output = resolve(process.cwd(), args.output)
	await Bun.write(output, `${JSON.stringify(manifest, null, '\t')}\n`)
	console.info(`wrote ${output} (${manifest.target.serviceHostnames.length} service(s))`)
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
