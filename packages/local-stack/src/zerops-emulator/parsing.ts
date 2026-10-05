import { z } from 'zod'
import { emptySnapshot, type EmulatorSnapshot, type ImportDocument, type RoleCode, type TokenGrantRecord } from './model'
import { PlatformRefusal } from './protocol'
import { grantSchema, parseSnapshot, roleCodeSchema } from './snapshot'

const importServiceSchema = z.object({
	hostname: z.string().min(1),
	type: z.string().optional().catch(undefined),
	profile: z.string().optional().catch(undefined),
	override: z.boolean().optional().catch(undefined),
	startWithoutCode: z.boolean().optional().catch(undefined),
	zeropsSetup: z.string().optional().catch(undefined),
	buildFromGit: z.string().optional().catch(undefined),
}).transform(({ hostname, type, profile, override, startWithoutCode, zeropsSetup, buildFromGit }) => ({
	hostname,
	...(type === undefined ? {} : { type }),
	...(profile === undefined ? {} : { profile }),
	...(override === undefined ? {} : { override }),
	...(startWithoutCode === undefined ? {} : { startWithoutCode }),
	...(zeropsSetup === undefined ? {} : { zeropsSetup }),
	...(buildFromGit === undefined ? {} : { buildFromGit }),
}))
const importProjectSchema = z.object({
	name: z.string().min(1),
	corePackage: z.string().optional().catch(undefined),
	description: z.string().optional().catch(undefined),
	tags: z.array(z.string()).optional().catch(undefined),
}).transform(({ name, corePackage, description, tags }) => ({
	name,
	...(corePackage === undefined ? {} : { corePackage }),
	...(description === undefined ? {} : { description }),
	...(tags === undefined ? {} : { tags }),
}))
const importDocumentSchema = z.object({ services: z.array(z.unknown()).min(1), project: z.unknown() })

export const parseImportDocument = (yaml: string): ImportDocument => {
	const document = importDocumentSchema.safeParse(Bun.YAML.parse(yaml))
	if (!document.success) throw new Error('import must declare at least one service')
	const services = document.data.services.map((entry) => {
		const parsed = importServiceSchema.safeParse(entry)
		if (!parsed.success) throw new Error('every imported service must have a hostname')
		const service = parsed.data
		if (service.zeropsSetup !== undefined && service.buildFromGit === undefined) {
			throw new PlatformRefusal(400, 'projectImportInvalidParameter', 'parameter is required for use of pipelineConfig')
		}
		return service
	})
	if (document.data.project === undefined) return { services }
	const project = importProjectSchema.safeParse(document.data.project)
	if (!project.success) throw new Error('an imported project must have a name')
	return { project: project.data, services }
}

export const readSnapshot = async (path: string | undefined): Promise<EmulatorSnapshot> => {
	if (path === undefined || !(await Bun.file(path).exists())) return emptySnapshot()
	return parseSnapshot(await Bun.file(path).json())
}

export const asRoleCode = (value: unknown, context: string): RoleCode => {
	const parsed = roleCodeSchema.safeParse(value)
	if (!parsed.success) throw new Error(`unknown roleCode in ${context}`)
	return parsed.data
}

export const readGrant = (value: unknown): TokenGrantRecord => {
	const parsed = grantSchema.safeParse(value)
	if (parsed.success) return parsed.data
	const issue = parsed.error.issues[0]
	throw new Error(issue?.code === 'custom' ? issue.message : 'invalid state field projectId')
}
