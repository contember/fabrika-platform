import { z } from 'zod'

export const importRequestSchema = z.object({ yaml: z.string() })
export const triggerRequestSchema = z.object({ buildFromGit: z.string() })
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
