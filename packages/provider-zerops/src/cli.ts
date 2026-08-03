#!/usr/bin/env bun
import { resolve } from 'node:path'
import { isZeropsAppConfig } from './authoring'
import { parseZeropsCliArgs } from './cli-args'
import { compileFabrikaManifest, manifestServiceHostnames } from './manifest'
import { runZeropsNamespaceCommand } from './namespace-command'
import type { ZeropsAppConfig } from './types'

const USAGE = `Zerops app tools

Usage:
  fabrika app build --provider=zerops --env=<env> [--config=<path>] [--output=<path>]
  fabrika namespace plan --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options]
  fabrika namespace create --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> [namespace options] [--control-url=<url>]
  fabrika namespace adopt --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id> [namespace options] [--control-url=<url>]
  fabrika namespace reconcile --provider=zerops --id=<id> [--control-url=<url>]

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
  --proxy-build-from-git=<url>   Public proxy source; or FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT.
  --control-url=<url>            Control origin; or FABRIKA_CONTROL_URL.
  -h, --help                     Show this help.

Mutating namespace commands read the Bearer credential from FABRIKA_CONTROL_TOKEN.
`

const property = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

const loadConfig = async (path: string): Promise<ZeropsAppConfig> => {
	const absolute = resolve(process.cwd(), path)
	const loaded: unknown = await import(absolute)
	const config = property(loaded, 'default')
	if (!isZeropsAppConfig(config)) {
		throw new Error(`Config at ${absolute} must default-export defineApp({ target: { platform: 'zerops', ... } })`)
	}
	return config
}

export const runZeropsCli = async (argv: readonly string[]): Promise<void> => {
	const args = parseZeropsCliArgs(argv)
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

if (import.meta.main) {
	await runZeropsCli(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	})
}
