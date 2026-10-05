import { z } from 'zod'

const text = z.string().min(1)
export const browserIdentitySchema = z.object({
	role: text.pipe(z.enum(['admin', 'operations-notes'])),
	principalId: text,
	label: text,
	session: text,
	expiresAt: z.number(),
})
const releaseSchema = z.object({ name: text, runId: text, uploadBearer: text })
export const browserFixtureSourceSchema = z.object({
	appId: text,
	environment: text,
	serviceKey: text,
	displayName: text,
	credentialId: text,
	publicKey: text,
	ingestProjectId: text,
	release: releaseSchema,
})
export const browserFixturesSchema = z.object({
	version: z.literal(1),
	visible: browserFixtureSourceSchema,
	hidden: browserFixtureSourceSchema,
})
export const catalogIngestSchema = z.object({
	ingest: z.array(z.object({
		coordinate: z.object({ appId: text, environment: text, serviceKey: text }),
		credentialId: text,
		ingestProjectId: text,
	})),
})

export function parseBrowserIdentity(value: unknown): z.infer<typeof browserIdentitySchema> {
	const parsed = browserIdentitySchema.safeParse(value)
	if (parsed.success) return parsed.data
	const issue = parsed.error.issues[0]
	if (issue?.path[0] === 'role' && issue.code === 'invalid_enum_value') throw new Error('browser identity has an invalid role')
	throw new Error(`browser fixture is missing ${issue?.path[0] ?? 'role'}`)
}

export function parseBrowserFixtures(value: unknown): z.infer<typeof browserFixturesSchema> {
	const parsed = browserFixturesSchema.safeParse(value)
	if (parsed.success) return parsed.data
	const path = parsed.error.issues[0]?.path ?? []
	if (path.length === 0 || path[0] === 'version') throw new Error('browser fixtures have an unsupported version')
	if (path.length === 1) throw new Error('browser fixture source is invalid')
	throw new Error(`browser fixture is missing ${path.at(-1) === 'release' ? 'name' : path.at(-1)}`)
}
