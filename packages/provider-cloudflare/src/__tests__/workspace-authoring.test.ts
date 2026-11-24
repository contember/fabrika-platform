import { describe, expect, test } from 'bun:test'
import { createCloudflareControlProvider } from '../control'
import { CLOUDFLARE_ISOLATED_BUILD, CLOUDFLARE_PROTECTED_FILES, CLOUDFLARE_STAGE_DEPLOY_REFUSAL, cloudflareAuthoring } from '../workspace-authoring'

const unused = (): Promise<never> => Promise.reject(new Error('unused'))
const provider = (isolatedBuild?: boolean) =>
	createCloudflareControlProvider({
		accountId: 'account',
		apiToken: 'token',
		runnerKey: 'runner',
		resolveSource: unused,
		prepareClone: unused,
		startRun: unused,
		cancelRun: () => Promise.resolve(),
		...(isolatedBuild === undefined ? {} : { isolatedBuild }),
	})

describe('MCP authoring on the Cloudflare control provider', () => {
	test('declares authoring, protecting the wrangler configuration files', () => {
		expect(provider().authoring?.protectedFiles).toEqual(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'])
		expect(CLOUDFLARE_PROTECTED_FILES).toEqual(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'])
	})

	test('refuses deploy_stage until the runner builds a workspace commit apart from the account token', () => {
		// The runner change that builds in a credential-free step flips `CLOUDFLARE_ISOLATED_BUILD`; the provider follows it.
		expect(provider().authoring).toEqual(cloudflareAuthoring(CLOUDFLARE_ISOLATED_BUILD))
		expect(provider(false).authoring?.stageDeployRefusal).toBe(CLOUDFLARE_STAGE_DEPLOY_REFUSAL)
		expect(CLOUDFLARE_STAGE_DEPLOY_REFUSAL).toContain('create_pull_request')
		expect(provider(true).authoring).toEqual({ protectedFiles: CLOUDFLARE_PROTECTED_FILES })
		expect(cloudflareAuthoring(false)).toEqual({ protectedFiles: CLOUDFLARE_PROTECTED_FILES, stageDeployRefusal: CLOUDFLARE_STAGE_DEPLOY_REFUSAL })
	})
})
