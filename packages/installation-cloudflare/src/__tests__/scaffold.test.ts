import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INITIAL_SCAFFOLD_COMMIT_MESSAGE, materializePlatformScaffold, REFRESH_SCAFFOLD_COMMIT_MESSAGE } from '../scaffold'

const GENERATED_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml']
const FORBIDDEN_GENERATED_REFERENCES = [
	'contember/vozka',
	'contember/propustka',
	'vozka.ref',
	'propustka.ref',
	'packages/admin-ui',
	'packages/worker',
	'packages/engine/src/cli.ts',
	'bunx oblaka oblaka.ts --env=prod',
]

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-cli-scaffold-'))
	try {
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function snapshot(dir: string): Promise<Record<string, string>> {
	const entries = await Promise.all(
		GENERATED_FILES.map(async (path) => [path, await Bun.file(join(dir, path)).text()] satisfies [string, string]),
	)
	return Object.fromEntries(entries)
}

describe('platform scaffold', () => {
	test('scaffold pushes cannot deploy before init configures the Environment', () => {
		expect(INITIAL_SCAFFOLD_COMMIT_MESSAGE).toEndWith('[skip ci]')
		expect(REFRESH_SCAFFOLD_COMMIT_MESSAGE).toEndWith('[skip ci]')
	})

	test('fresh creation renders one repository checkout and one source pin offline', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'mangoweb')

			const files = await snapshot(dir)
			expect(files['fabrika.ref']).toBe('main\n')
			expect(files['README.md']).toContain('# fabrika-platform (mangoweb)')
			expect(files['.github/workflows/platform.yml']).toContain('repository: contember/fabrika-platform')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/iam')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/operations')
			expect(files['.github/workflows/platform.yml']).toContain(
				'fabrika app deploy --provider=cloudflare --env=prod --config=fabrika.config.ts',
			)
			expect(files['.github/workflows/platform.yml']).toContain('fabrika platform deploy --provider=cloudflare')
			expect(files['.github/workflows/platform.yml']).toContain('--runner-config=packages/runner-cloudflare/fabrika-runner.config.ts')
			expect(files['.github/workflows/platform.yml']).toContain('--worker-config=packages/control/fabrika.config.ts')
			const workflow = files['.github/workflows/platform.yml'] ?? ''
			expect(workflow).not.toContain('build_runner_image')
			expect(workflow).not.toContain('--build-runner-image')
			expect(workflow).toContain('id: platform')
			expect(workflow).toContain("steps.platform.outcome || 'not run'")
			expect(files['README.md']).toContain('Both paths rebuild the account-owned runner image')
			expect(workflow.indexOf('name: Deploy IAM')).toBeLessThan(workflow.indexOf('name: Deploy Operations'))
			expect(workflow.indexOf('name: Deploy Operations')).toBeLessThan(workflow.indexOf('name: Deploy fabrika runner + control plane'))
			const iamStep = workflow.slice(workflow.indexOf('name: Deploy IAM'), workflow.indexOf('name: Deploy Operations'))
			expect(iamStep).toContain('FABRIKA_IAM_SIGNING_KEYS: ${{ secrets.FABRIKA_IAM_SIGNING_KEYS }}')
			expect(iamStep).toContain('FABRIKA_IAM_PROVISIONING_KEY: ${{ secrets.FABRIKA_IAM_PROVISIONING_KEY }}')
			expect(iamStep).toContain('FABRIKA_IAM_OIDC_ENABLED: ${{ vars.FABRIKA_IAM_OIDC_ENABLED }}')
			expect(iamStep).toContain('FABRIKA_IAM_PASSWORD_ENABLED: ${{ vars.FABRIKA_IAM_PASSWORD_ENABLED }}')
			expect(iamStep).toContain('FABRIKA_EMAIL_PROVIDER: ${{ vars.FABRIKA_EMAIL_PROVIDER }}')
			expect(iamStep).toContain('FABRIKA_EMAIL_RESEND_API_KEY: ${{ secrets.FABRIKA_EMAIL_RESEND_API_KEY }}')
			const operationsStep = workflow.slice(
				workflow.indexOf('name: Deploy Operations'),
				workflow.indexOf('name: Deploy fabrika runner + control plane'),
			)
			expect(operationsStep).toContain('FABRIKA_IAM_ISSUER: ${{ vars.FABRIKA_IAM_ISSUER }}')
			expect(workflow).toContain('FABRIKA_CONTROL_VAULT_KEY: ${{ secrets.FABRIKA_CONTROL_VAULT_KEY }}')
			expect(workflow).toContain('FABRIKA_CONTROL_DOMAIN: ${{ vars.FABRIKA_CONTROL_DOMAIN }}')
			expect(workflow).toContain('FABRIKA_CONTROL_BOOTSTRAP_ADMINS: ${{ vars.FABRIKA_CONTROL_BOOTSTRAP_ADMINS }}')
			expect(workflow).not.toContain('PROPUSTKA_')
			expect(workflow).not.toContain('VOZKA_')

			const generated = Object.values(files).join('\n')
			for (const forbidden of FORBIDDEN_GENERATED_REFERENCES) {
				expect(generated).not.toContain(forbidden)
			}
		})
	})

	test('unchanged refresh is byte-identical and preserves the operator pin', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'mangoweb')
			await Bun.write(join(dir, 'fabrika.ref'), 'v1.2.3\n')
			const before = await snapshot(dir)

			await materializePlatformScaffold(dir, 'mangoweb')

			expect(await snapshot(dir)).toEqual(before)
		})
	})

	test('legacy two-ref scaffolds stop with explicit migration guidance', async () => {
		await withTempDir(async (dir) => {
			await Bun.write(join(dir, 'vozka.ref'), 'old-vozka\n')
			await Bun.write(join(dir, 'propustka.ref'), 'old-propustka\n')

			await expect(materializePlatformScaffold(dir, 'mangoweb')).rejects.toThrow(
				'Choose the matching contember/fabrika-platform commit or tag',
			)
			expect(await Bun.file(join(dir, 'vozka.ref')).text()).toBe('old-vozka\n')
			expect(await Bun.file(join(dir, 'propustka.ref')).text()).toBe('old-propustka\n')
			expect(await Bun.file(join(dir, 'README.md')).exists()).toBe(false)
			expect(await Bun.file(join(dir, 'fabrika.ref')).exists()).toBe(false)
		})
	})
})
