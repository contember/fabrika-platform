import { z } from 'zod'

const operationsConfigSchema = z.object({ dsn: z.string(), release: z.string() })

export const parseOperationsConfig = (value: unknown): z.infer<typeof operationsConfigSchema> => {
	const result = operationsConfigSchema.safeParse(value)
	if (!result.success) throw new Error('Operations SDK configuration is invalid')
	return result.data
}
