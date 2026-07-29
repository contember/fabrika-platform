#!/usr/bin/env bun
import { resolve } from 'node:path'
import { defineApp } from './authoring'
import { parseZeropsCliArgs } from './cli-args'
import { compileFabrikaManifest, manifestServiceHostnames } from './manifest'
import { runZeropsNamespaceCommand } from './namespace-command'
import type { ZeropsAppConfig } from './types'

const USAGE = `fabrika-zerops — Zerops provider tools

Usage:
  fabrika-zerops build --env=<env> [--config=<path>] [--output=<path>]
  fabrika-zerops namespace plan --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options]
  fabrika-zerops namespace create --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options] [--control-url=<url>]
  fabrika-zerops namespace adopt --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id> [namespace options] [--control-url=<url>]
  fabrika-zerops namespace reconcile --id=<id> [--control-url=<url>]

Options:
  --env=<env>                    Environment.
  --config=<path>                App config (default: ./fabrika.config.ts).
  --output=<path>                Artifact path (default: ./fabrika.manifest.json).
  --id=<id>                      Namespace id.
  --preset=<cheap|mid|full>      Provider-owned namespace preset.
  --exclusive-app=<id>           App reserved by a full namespace.
  --project-id=<id>              Existing Zerops project id for adoption.
  --project-name=<name>          Zerops project name (default: namespace id).
  --core-package=<tier>          LIGHT or SERIOUS.
  --public-access=<mode>         custom-domain or zerops-subdomain.
  --postgres-type=<type>         Cheap-tier PostgreSQL type.
  --postgres-profile=<profile>   Cheap-tier PostgreSQL profile.
  --proxy-build-from-git=<url>   Public proxy source; or ZEROPS_PROXY_BUILD_FROM_GIT.
  --control-url=<url>            Control origin; or FABRIKA_CONTROL_URL.
  -h, --help                     Show this help.

Mutating namespace commands read the Bearer credential from FABRIKA_CONTROL_TOKEN.
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
	if (args.command === 'namespace') {
		await runZeropsNamespaceCommand(args, {
			source: process.env,
			fetch: globalThis.fetch,
			write: (value) => console.info(value.trimEnd()),
		})
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
	console.info(`wrote ${output} (${manifestServiceHostnames(manifest).length} service(s))`)
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
