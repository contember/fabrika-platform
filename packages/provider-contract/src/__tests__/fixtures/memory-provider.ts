import type { ControlProviderConformanceHarness } from '../../conformance'
import type { ControlProvider } from '../../control'

/**
 * The smallest provider the suite admits: one external job per deploy. `cancelOnLeaseLoss` breaks the contract the
 * way a real provider could, stopping the job when its lease goes.
 */
export const memoryHarness = (options: { readonly cancelOnLeaseLoss?: boolean } = {}): ControlProviderConformanceHarness => ({
	create: (hooks) => {
		const mutations: string[] = []
		const stops: string[] = []
		const provider: ControlProvider = {
			id: 'memory',
			normalizeRegistration: (input) => input,
			deploy: async (input) => {
				await input.events.boundary()
				if (input.dryRun) {
					input.events.log('[dry-run] would start a job')
					return { state: 'succeeded' }
				}
				await input.events.externalId(`job-${input.runId}`, { started: true })
				mutations.push(`start:job-${input.runId}`)
				hooks.accepted()
				try {
					await input.events.boundary()
				} catch (error) {
					if (options.cancelOnLeaseLoss === true) stops.push(`cancel:job-${input.runId}`)
					throw error
				}
				return { state: 'succeeded' }
			},
			cancel: async (input) => {
				input.signal.throwIfAborted()
				stops.push(`cancel:${input.externalId}`)
				return { state: 'settled' }
			},
			reconcile: async (input) => {
				input.signal.throwIfAborted()
				return { state: 'running' }
			},
		}
		return {
			provider,
			input: {
				runId: 'run-1',
				app: { id: 'notes', source: { repoUrl: 'https://github.com/example/notes.git', ref: 'a'.repeat(40) } },
				environment: {
					appId: 'notes',
					env: 'prod',
					target: { provider: 'memory', version: 1, payload: {} },
					artifact: { provider: 'memory', version: 1, payload: {} },
				},
				secrets: {},
				vars: {},
				managedEnvironment: { FABRIKA_PROXY_SECRET: { value: 'p'.repeat(43), credential: true } },
			},
			credentials: [],
			mutations: () => mutations,
			stops: () => stops,
		}
	},
})
