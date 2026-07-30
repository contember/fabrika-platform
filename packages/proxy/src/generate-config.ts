/**
 * Build-time CLI: `proxy.manifest.json` → `caddy.json`.
 *
 * Runs in the Zerops build phase (see `zerops.yaml`), so the config is baked into the artifact and a
 * gate change ships with the app's next deploy — the mechanism
 * `docs/backlog/08-distribute-gate-config-to-proxy.md` chose over pushing to Caddy's admin API.
 *
 *   bun run src/generate-config.ts [manifest] [out] [--auth-upstream host:port] [--listen :8080]
 */

import { parseProxyManifest } from '@fabrika/proxy-contract'
import { buildCaddyConfig, type CaddyBuildOptions } from './caddy'

interface Args {
	manifest: string
	out: string
	options: CaddyBuildOptions
}

function parseArgs(argv: string[]): Args {
	const positional: string[] = []
	const flags = new Map<string, string>()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === undefined) {
			continue
		}
		if (arg.startsWith('--')) {
			const value = argv[i + 1]
			if (value === undefined) {
				throw new Error(`missing value for ${arg}`)
			}
			flags.set(arg.slice(2), value)
			i++
			continue
		}
		positional.push(arg)
	}
	const options: CaddyBuildOptions = { authUpstream: flags.get('auth-upstream') ?? '127.0.0.1:9000' }
	const listen = flags.get('listen')
	if (listen !== undefined) {
		options.listen = listen.split(',')
	}
	return {
		manifest: positional[0] ?? './proxy.manifest.json',
		out: positional[1] ?? './caddy.json',
		options,
	}
}

const args = parseArgs(Bun.argv.slice(2))
const raw: unknown = await Bun.file(args.manifest).json()
const manifest = parseProxyManifest(raw)
if (manifest === null) {
	console.error(`invalid proxy manifest: ${args.manifest}`)
	process.exit(1)
}

await Bun.write(args.out, `${JSON.stringify(buildCaddyConfig(manifest, args.options), null, '\t')}\n`)
console.info(`wrote ${args.out} (${manifest.apps.length} app(s))`)
