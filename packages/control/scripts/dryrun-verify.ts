#!/usr/bin/env bun
/**
 * Offline full-path proof that fabrika can deploy itself. Run the Cloudflare deployer in dry-run against
 * fabrika's own provider config, substituting only the Oblaka provisioner. Everything else is the real
 * fabrika config. NO Cloudflare, NO IAM service, NO real creds. Proves the plan builds and every step walks
 * in plan-only mode.
 *
 *   bun run scripts/dryrun-verify.ts
 */
import { type CloudflareCollaborators, createCloudflareDeployer, defaultCloudflareCollaborators } from '@fabrika/provider-cloudflare'
import { resolve } from 'node:path'

const domain = process.env['FABRIKA_CONTROL_DOMAIN'] ?? 'control.stage.example.com'
process.env['FABRIKA_CONTROL_DOMAIN'] = domain

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

// `allow`: this script deploys fabrika's OWN config, the one caller permitted to name a platform resource.
const deploy = createCloudflareDeployer({ accountId: 'dummy-acc', apiToken: 'dummy-tok', collaborators, platformResources: 'allow' })
const cwd = resolve(import.meta.dir, '..')
const result = await deploy({
	appId: config.id,
	env: 'stage',
	domain,
	cwd,
	configPath: resolve(cwd, 'fabrika.config.ts'),
	// The runtime worker secrets fabrika.config declares in pipeline.secrets — dummy values offline.
	secrets: {
		FABRIKA_CONTROL_VAULT_KEY: 'dummy-vault-key',
		CLOUDFLARE_API_TOKEN: 'dummy-tok',
		FABRIKA_IAM_PROVISIONING_KEY: 'px_dummy-admin',
		FABRIKA_RUNNER_KEY: 'dummy-runner-key',
		OPERATIONS_SYNC_KEY: 'offline-dry-run-operations-sync-key',
	},
	vars: {},
	managedEnvironment: {},
	dryRun: true,
	signal: new AbortController().signal,
	log: (line) => console.log(line),
})
console.log('\n=== RESULT ===')
console.log('overall:', result.status)
for (const s of result.steps) {
	console.log(' ', s.status.padEnd(10), s.id)
}
process.exit(result.status === 'failed' ? 1 : 0)
