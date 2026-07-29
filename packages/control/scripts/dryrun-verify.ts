#!/usr/bin/env bun
/**
 * Offline full-path proof that fabrika can deploy itself. Run the neutral executor in dry-run against
 * fabrika's own provider config, substituting only the Oblaka provisioner. Everything else is the real
 * fabrika config. NO Cloudflare, NO propustka, NO real creds. Proves the plan builds and every step walks
 * in plan-only mode.
 *
 *   bun run scripts/dryrun-verify.ts
 */
import { deploy } from '@fabrika/engine'
import {
	cloudflareArtifact,
	type CloudflareCollaborators,
	createCloudflareProvider,
	defaultCloudflareCollaborators,
} from '@fabrika/provider-cloudflare'
import type { RuntimeProviderRun } from '@fabrika/provider-contract'
import { resolve } from 'node:path'

// fabrika.config's `access` declaration throws without VOZKA_DOMAIN (eager, like propustka/poplach) —
// set it before importing the config. This is the dry-run/offline stand-in for the real deploy var.
process.env['VOZKA_DOMAIN'] = process.env['VOZKA_DOMAIN'] ?? 'vozka.stage.example.com'

const { default: config } = await import('../fabrika.config')

// Substitute ONLY the oblaka provisioner; the rest of the driver runs for real (in dry-run mode).
const collaborators: CloudflareCollaborators = {
	...defaultCloudflareCollaborators,
	provision: (input) => {
		console.log(`  [fake-oblaka] materialized vozka graph for ${input.env}, dryRun=${input.dryRun}`)
		return Promise.resolve({
			wranglerConfigs: [{ path: 'wrangler.jsonc', config: { name: `${input.env}-vozka` }, content: '{}' }],
			wranglerConfig: { name: `${input.env}-vozka` },
		})
	},
}

const provider = createCloudflareProvider(collaborators)
const cwd = resolve(import.meta.dir, '..')
const run: RuntimeProviderRun = {
	appId: config.id,
	env: 'stage',
	...(process.env['VOZKA_DOMAIN'] === undefined
		? {}
		: { domain: process.env['VOZKA_DOMAIN'] }),
	target: provider.encodeTarget({
		accountId: 'dummy-acc',
		apiToken: 'dummy-tok',
		propustkaUrl: 'https://iam.example.com',
		adminKey: 'px_dummy-admin',
	}),
	artifact: provider.encodeArtifact(cloudflareArtifact(resolve(cwd, 'fabrika.config.ts'))),
	// The runtime worker secrets fabrika.config declares in pipeline.secrets — dummy values offline.
	secrets: {
		VOZKA_VAULT_KEY: 'dummy-vault-key',
		GITHUB_APP_PRIVATE_KEY: 'dummy-pem',
		GITHUB_WEBHOOK_SECRET: 'dummy-hmac',
		CLOUDFLARE_API_TOKEN: 'dummy-tok',
		PROPUSTKA_PROVISIONING_KEY: 'px_dummy-admin',
	},
	vars: {},
	cwd,
	dryRun: true,
	signal: new AbortController().signal,
	events: {
		log: (line) => console.log(line),
		externalId: async () => {},
	},
}

const result = await deploy(provider.runtime, run)
console.log('\n=== RESULT ===')
console.log('overall:', result.status)
for (const s of result.steps) {
	console.log(' ', s.status.padEnd(10), s.spec.id)
}
process.exit(result.status === 'failed' ? 1 : 0)
