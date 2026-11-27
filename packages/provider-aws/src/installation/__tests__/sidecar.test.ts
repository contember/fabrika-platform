// The sidecar's files: a workflow that reads no secret, takes the deployer role through GitHub's OIDC provider only
// after the install step, with the credentials action pinned by commit, in the installation's Environment, and runs the
// upgrade at the pinned tag's commit; a README and a comment that ask for a required reviewer; and `fabrika.ref`
// written once and kept a tag.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AWS_SIDECAR_FILES, type AwsSidecarValues, materializeAwsSidecar, readAwsPinnedTag, renderAwsSidecarWorkflow } from '../sidecar'

const VALUES: AwsSidecarValues = {
	repo: 'acme/fabrika-aws',
	accountId: '123456789012',
	region: 'eu-central-1',
	environment: 'production',
	roleArn: 'arn:aws:iam::123456789012:role/fabrika/platform/fabrika-platform-deployer',
	fabrikaRef: 'v0.9.0',
}

describe("the AWS sidecar's files", () => {
	test('the workflow takes the role by OIDC in the Environment, reads no secret, and upgrades at the pinned commit', async () => {
		const workflow = await renderAwsSidecarWorkflow(VALUES)
		expect(workflow).not.toContain('{{')
		expect(workflow).not.toContain('secrets.')
		expect(workflow).toContain('  id-token: write')
		expect(workflow).toContain('    environment: production')
		expect(workflow).toContain('role-to-assume: ${{ vars.FABRIKA_AWS_ROLE_ARN }}')
		expect(workflow).toContain('allowed-account-ids: ${{ vars.FABRIKA_AWS_ACCOUNT_ID }}')
		expect(workflow).toContain('FABRIKA_PLATFORM_COMMIT: ${{ steps.source.outputs.commit }}')
		expect(workflow).toContain('run: fabrika platform upgrade --provider=aws --yes')
		// The action that handles the credentials is pinned by commit, never by a tag that can move.
		expect(workflow).toMatch(/uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v\d+\.\d+\.\d+/)
		// The role is taken after the dependencies are installed, so no install script runs with it.
		expect(workflow.indexOf('bun install --frozen-lockfile')).toBeLessThan(workflow.indexOf('aws-actions/configure-aws-credentials'))
		expect(workflow).toContain('ADD A REQUIRED REVIEWER')
		const parsed: unknown = Bun.YAML.parse(workflow)
		expect(parsed).toMatchObject({ permissions: { contents: 'read', 'id-token': 'write' }, jobs: { upgrade: { environment: 'production' } } })
	})

	test('the files: the CLI rewrites its three, the pin is written once and must stay a tag', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fabrika-aws-sidecar-'))
		try {
			await materializeAwsSidecar(dir, VALUES)
			expect(await readAwsPinnedTag(dir)).toBe('v0.9.0')
			for (const file of AWS_SIDECAR_FILES) expect({ file, exists: await Bun.file(join(dir, file)).exists() }).toEqual({ file, exists: true })
			expect(await Bun.file(join(dir, 'README.md')).text()).toContain('**Add a required reviewer**')
			// A refresh for a newer tag keeps the operator's pin: bumping it is how they upgrade.
			await materializeAwsSidecar(dir, { ...VALUES, fabrikaRef: 'v0.10.0' })
			expect(await readAwsPinnedTag(dir)).toBe('v0.9.0')
			// A pin moved onto a branch is refused, as the workflow refuses it again at run time.
			await Bun.write(join(dir, 'fabrika.ref'), 'main\n')
			await expect(materializeAwsSidecar(dir, VALUES)).rejects.toThrow()
			await expect(materializeAwsSidecar(dir, { ...VALUES, fabrikaRef: 'main' })).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
