// The sidecar's files: a workflow that reads no secret, takes the deployer role through GitHub's OIDC provider in the
// installation's Environment, and runs the upgrade at the pinned tag's commit. Every step of its job could request the
// token, so every action is pinned by commit, no expression reaches a script, no dependency's script runs, and the pin
// is checked to be a tag. A README and a comment ask for a required reviewer; `fabrika.ref` is written once and kept
// a tag.

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error('not a mapping')
	return value
}

interface Step {
	readonly id: unknown
	readonly uses: unknown
	readonly run: unknown
}

/** The upgrade job's steps. */
function stepsOf(workflow: unknown): Step[] {
	const steps = record(record(record(workflow)['jobs'])['upgrade'])['steps']
	if (!Array.isArray(steps)) throw new Error('the upgrade job has no steps')
	return steps.map((step: unknown) => {
		const fields = record(step)
		return { id: fields['id'], uses: fields['uses'], run: fields['run'] }
	})
}

describe("the AWS sidecar's files", () => {
	test('the workflow takes the role by OIDC in the Environment, reads no secret, and upgrades at the pinned commit', async () => {
		const workflow = await renderAwsSidecarWorkflow(VALUES)
		// Every placeholder replaced; GitHub's own `${{ … }}` expressions stay.
		expect(workflow).not.toMatch(/(?<!\$)\{\{/)
		expect(workflow).not.toContain('secrets.')
		expect(workflow).toContain('  id-token: write')
		expect(workflow).toContain('    environment: production')
		expect(workflow).toContain('role-to-assume: ${{ vars.FABRIKA_AWS_ROLE_ARN }}')
		expect(workflow).toContain('allowed-account-ids: ${{ vars.FABRIKA_AWS_ACCOUNT_ID }}')
		expect(workflow).toContain('FABRIKA_PLATFORM_COMMIT: ${{ steps.source.outputs.commit }}')
		expect(workflow).toContain('run: fabrika platform upgrade --provider=aws --yes')
		expect(workflow).toContain('ADD A REQUIRED REVIEWER')
		// The job alone holds the token's permission; the workflow grants nothing another job could inherit.
		const parsed: unknown = Bun.YAML.parse(workflow)
		expect(parsed).toMatchObject({
			permissions: {},
			jobs: { upgrade: { environment: 'production', permissions: { contents: 'read', 'id-token': 'write' } } },
		})
		expect(Object.keys(record(record(parsed)['permissions']))).toEqual([])
	})

	test('every step can take the role, so every action is pinned by commit and no expression reaches a shell', async () => {
		const workflow = await renderAwsSidecarWorkflow(VALUES)
		const steps = stepsOf(Bun.YAML.parse(workflow))
		const actions = steps.flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []))
		expect(actions.map((uses) => uses.split('@')[0])).toEqual(['actions/checkout', 'oven-sh/setup-bun', 'aws-actions/configure-aws-credentials'])
		for (const uses of actions) expect(uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
		// The version each commit is, beside it.
		expect(workflow.match(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/gm)).toHaveLength(actions.length)
		// A value from the repository (the pin, a step's output) reaches a script only through `env:`.
		const scripts = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []))
		expect(scripts.length).toBeGreaterThan(0)
		for (const script of scripts) expect(script).not.toContain('${{')
		// No dependency's script runs: the lockfile is frozen and scripts are off.
		expect(scripts).toContain('bun install --frozen-lockfile --ignore-scripts')
	})

	test("the pin's check at run time admits a release tag and nothing a shell would read as more", async () => {
		const workflow = await renderAwsSidecarWorkflow(VALUES)
		const resolve = stepsOf(Bun.YAML.parse(workflow)).find((step) => step.id === 'ref')
		const pattern = typeof resolve?.run === 'string' ? /grep -Eq '([^']+)'/.exec(resolve.run)?.[1] : undefined
		expect(pattern).toBeDefined()
		// POSIX ERE and JavaScript read this pattern alike: anchors, classes, groups and `?` only.
		const tag = new RegExp(pattern ?? '^$')
		for (const ref of ['v0.9.0', 'v1.2.3-rc.1', 'v1.2.3+build.5']) expect({ ref, admitted: tag.test(ref) }).toEqual({ ref, admitted: true })
		for (const ref of ['main', 'v1', 'v1";curl${IFS}x|sh;"', 'v1.2.3$(id)', 'v01.2.3']) {
			expect({ ref, admitted: tag.test(ref) }).toEqual({ ref, admitted: false })
		}
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
