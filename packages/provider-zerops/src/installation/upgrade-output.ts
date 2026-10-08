import { z } from 'zod'

const refs = z.array(z.unknown())
const tagRef = z.object({ ref: z.string() })
const runs = z.array(z.unknown())
const run = z.object({
	databaseId: z.union([z.number(), z.string()]).transform(String),
	url: z.string().min(1),
	status: z.string().min(1).catch('unknown'),
})
const readJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}
export const carriesTag = (raw: string, tag: string): boolean => {
	const parsed = refs.safeParse(readJson(raw))
	return parsed.success && parsed.data.some((entry) => {
		const parsedRef = tagRef.safeParse(entry)
		return parsedRef.success && parsedRef.data.ref === `refs/tags/${tag}`
	})
}
export const firstRun = (raw: string): { id: string; url: string; status: string } | undefined => {
	const parsed = runs.safeParse(readJson(raw))
	if (!parsed.success) return undefined
	const first = run.safeParse(parsed.data[0])
	if (!first.success) return undefined
	return { id: first.data.databaseId, url: first.data.url, status: first.data.status }
}
