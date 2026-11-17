import { z } from 'zod'

export const importRequestSchema = z.object({ yaml: z.string() })
export const triggerRequestSchema = z.object({ buildFromGit: z.string() })
export const reservationRequestSchema = z.object({ name: z.string().optional() })
/**
 * A profile, or a custom autoscaling of which the double reads the minimum RAM only. Like the platform it replaces the
 * whole custom object: a key it does not read leaves the minimum inherited.
 */
export const autoscalingRequestSchema = z.union([
	z.object({ autoscalingProfileId: z.string().min(1) }),
	z.object({
		customAutoscaling: z.object({
			verticalAutoscaling: z.object({ minResource: z.object({ memoryGBytes: z.number().positive().nullish() }).nullish() }).nullish(),
		}),
	}),
])
/** A user tag, as the platform admits one (verified live 2026-11-17); anything else is 400 `backupTagNameFormat`. */
export const BACKUP_TAG = /^[A-Za-z0-9:_-]{1,24}$/
export const backupRequestSchema = z.object({ tags: z.array(z.string()).nullish() })
export const buildRequestSchema = z.object({ zeropsYaml: z.string(), zeropsYamlSetup: z.string().optional() })
const descriptorSchema = z.object({
	zerops: z.array(z.object({
		setup: z.string(),
		run: z.object({
			ports: z.array(z.object({ httpSupport: z.boolean().optional() })).optional(),
			envVariables: z.record(z.string()).optional(),
		}).optional(),
	})),
})

export function readDescriptorRuntime(yaml: string, setup?: string): { hasHttpPorts: boolean; runEnvVariables: Record<string, string> } {
	const descriptor = descriptorSchema.parse(Bun.YAML.parse(yaml))
	const selected = setup === undefined ? descriptor.zerops[0] : descriptor.zerops.find((entry) => entry.setup === setup)
	return {
		hasHttpPorts: selected?.run?.ports?.some((port) => port.httpSupport === true) ?? false,
		runEnvVariables: selected?.run?.envVariables ?? {},
	}
}
export const userDataRequestSchema = z.object({
	key: z.string().optional().catch(undefined),
	content: z.string().optional().catch(undefined),
	sensitive: z.boolean().optional().catch(undefined),
}).catch({})
export const integrationTokenRequestSchema = z.object({
	name: z.string().optional().catch(undefined),
	projects: z.array(z.unknown()).optional().catch(undefined),
	roleCode: z.unknown(),
}).catch({})

export function parseImportRequest(value: unknown): string {
	const parsed = importRequestSchema.safeParse(value)
	if (!parsed.success) throw new Error('invalid state field yaml')
	return parsed.data.yaml
}
