import type { BuildSandbox, SandboxCommand } from '../../sandbox'

/**
 * A sandbox that runs each step as the test's own user, unchanged, and records what it was asked: the unit tests drive
 * the pipeline, `sandbox.test.ts` the argv, and the image smoke the user switch itself.
 */
export const passthroughSandbox = (calls: SandboxCommand[] = [], events: string[] = []): BuildSandbox => ({
	unavailable: null,
	isolatesNetwork: true,
	command: (spec) => {
		calls.push(spec)
		return { command: spec.command, args: [...spec.args], cwd: spec.cwd, env: { ...spec.env }, replaceEnv: true }
	},
	own: async (paths) => {
		events.push(`own ${paths.join(' ')}`)
	},
	reap: async () => {
		events.push('reap')
	},
})
