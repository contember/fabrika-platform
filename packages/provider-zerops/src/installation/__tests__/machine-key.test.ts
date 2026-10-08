import { describe, expect, test } from 'bun:test'
import { MACHINE_KEY_ISSUE_COMMAND, MACHINE_KEY_NEXT_STEP_TITLE, machineKeyNextStepLines } from '../machine-key'

/** The prefixes every credential this platform mints carries. None may reach a printed block. */
const KEY_PREFIXES = ['px_', 'rpc_', 'sk_'] as const

const ORIGIN = 'https://iam.example.test'

/** What a shell would take for a variable assignment, exported or not. */
const ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/

describe('the machine-key next step', () => {
	test('EXPORTS the origin, so the command it leads to inherits it', () => {
		const lines = machineKeyNextStepLines({ iamOrigin: ORIGIN, sidecarEnvironment: 'test' })

		// A bare `NAME=value` sets a shell variable the child process never sees.
		expect(lines).toContain(`export FABRIKA_IAM_RPC_URL=${ORIGIN}`)
		expect(lines.join('\n')).toContain('FABRIKA_IAM_RPC_KEY')
		expect(lines.join('\n')).toContain('FABRIKA_IAM_PROVISIONING_KEY')
		expect(lines.join('\n')).toContain(MACHINE_KEY_ISSUE_COMMAND)
		expect(MACHINE_KEY_ISSUE_COMMAND).toContain('--label=<name>')
		expect(MACHINE_KEY_ISSUE_COMMAND).toContain('--permissions=<a,b,c>')
	})

	test('pastes safely: one export, and every other line a comment', () => {
		for (const step of [{}, { iamOrigin: ORIGIN }, { iamOrigin: ORIGIN, sidecarEnvironment: 'test' }]) {
			const lines = machineKeyNextStepLines(step)

			expect(lines.filter((line) => ASSIGNMENT.test(line))).toEqual(
				'iamOrigin' in step ? [`export FABRIKA_IAM_RPC_URL=${ORIGIN}`] : [],
			)
			// The command line's `<name>` and `<seconds>` are shell redirections, so it is a comment too.
			for (const line of lines.filter((entry) => !ASSIGNMENT.test(entry))) {
				expect(line.startsWith('#')).toBe(true)
			}
		}
	})

	test('says where each key is READ FROM, and which copy the sidecar holds', () => {
		const named = machineKeyNextStepLines({ iamOrigin: ORIGIN, sidecarEnvironment: 'test' }).join('\n')
		expect(named).toContain("read from: the `iam` or `control` service's env, in the Zerops project")
		// A GitHub Environment secret cannot be read back; the service env is the copy an operator can get.
		expect(named).toContain('the copy anyone with the project can read')
		expect(named).toContain("the sidecar's `test` Environment holds the copy the pipeline uses")

		const anonymous = machineKeyNextStepLines({ iamOrigin: ORIGIN }).join('\n')
		expect(anonymous).toContain("the sidecar repository's Environment holds the copy the pipeline uses")
		expect(anonymous).not.toContain('`test`')
	})

	test('names where to read the origin instead of guessing one', () => {
		const lines = machineKeyNextStepLines().join('\n')

		expect(lines).not.toContain('export FABRIKA_IAM_RPC_URL=')
		expect(lines).toContain("read from: `control`'s own FABRIKA_IAM_ISSUER, in the Zerops project")
	})

	test('warns that a private hostname answers only inside the project', () => {
		expect(machineKeyNextStepLines({ iamOrigin: ORIGIN }).join('\n')).toContain('http://iam:3000')
	})

	test('is composed of an origin and NAMES, so no key prefix can appear in it', () => {
		const every = [
			MACHINE_KEY_NEXT_STEP_TITLE,
			...machineKeyNextStepLines(),
			...machineKeyNextStepLines({ iamOrigin: ORIGIN }),
			...machineKeyNextStepLines({ iamOrigin: ORIGIN, sidecarEnvironment: 'test' }),
		].join('\n')

		for (const prefix of KEY_PREFIXES) {
			expect(every).not.toContain(prefix)
		}
	})
})
