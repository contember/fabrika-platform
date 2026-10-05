import { normalizeZeropsSourceRepository, ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '@fabrika/provider-zerops'
import { z } from 'zod'

export const LOCAL_SOURCE_FIXTURE_DIRECTORY = 'source-fixtures'
export const LOCAL_SOURCE_MANIFEST_FILE = 'manifest.json'
export const LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE = 'platform.tar.gz'
export const LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE = 'application.tar.gz'
export const LOCAL_SOURCE_PLATFORM_REPOSITORY_URL = 'https://github.com/fabrika-local/platform-fixture'
export const LOCAL_SOURCE_APPLICATION_REPOSITORY_URL = 'https://github.com/fabrika-local/application-fixture'
export const LOCAL_SOURCE_PLATFORM_REPOSITORY = normalizeZeropsSourceRepository(LOCAL_SOURCE_PLATFORM_REPOSITORY_URL)
export const LOCAL_SOURCE_APPLICATION_REPOSITORY = normalizeZeropsSourceRepository(LOCAL_SOURCE_APPLICATION_REPOSITORY_URL)
export const LOCAL_SOURCE_UPLOAD_URL = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload'
export const LOCAL_SOURCE_EMULATOR_ORIGIN = 'http://zerops-emulator:3000'
export const LOCAL_SOURCE_UPLOAD_PATH = '/__local/source-upload'
export const LOCAL_SOURCE_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024
export const LOCAL_SOURCE_MAX_EXPANDED_BYTES = 4 * 1024 * 1024
export const LOCAL_SOURCE_MAX_TREE_ENTRIES = 128
export const LOCAL_SOURCE_MAX_MANIFEST_BYTES = 1024 * 1024

const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const appVersionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const treeEntrySchema = z.object({
	path: z.string().min(1).max(1024),
	sha: gitObjectIdSchema,
}).and(z.discriminatedUnion('type', [
	z.object({ type: z.literal('tree'), mode: z.literal('040000') }),
	z.object({ type: z.literal('blob'), mode: z.enum(['100644', '100755', '120000']) }),
]))

export const localSourceFixtureSchema = z.object({
	commitSha: gitObjectIdSchema,
	treeSha: gitObjectIdSchema,
	tree: z.array(treeEntrySchema).max(LOCAL_SOURCE_MAX_TREE_ENTRIES),
	descriptorContents: z.string().refine(value => new TextEncoder().encode(value).byteLength <= ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES),
	descriptorSha256: sha256Schema,
	archiveBytes: z.number().int().positive().max(LOCAL_SOURCE_MAX_COMPRESSED_BYTES),
	archiveSha256: sha256Schema,
}).strict()

export const localSourceManifestSchema = z.object({
	version: z.literal(1),
	platform: localSourceFixtureSchema,
	application: localSourceFixtureSchema,
}).strict()

export type LocalSourceFixture = z.infer<typeof localSourceFixtureSchema>
export type LocalSourceManifest = z.infer<typeof localSourceManifestSchema>

export const localSourceUploadCapabilitySchema = z.object({
	appVersionId: appVersionIdSchema,
	capability: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type LocalSourceUploadCapability = z.infer<typeof localSourceUploadCapabilitySchema>

export const localSourceUploadReceiptSchema = z.object({
	compressedBytes: z.number().int().positive().max(LOCAL_SOURCE_MAX_COMPRESSED_BYTES),
	compressedSha256: sha256Schema,
}).strict()

export type LocalSourceUploadReceipt = z.infer<typeof localSourceUploadReceiptSchema>

// Persist the capability digest, never its bearer value; deletion leaves this grant inert but usable for a late PUT.
export const localSourceUploadGrantSchema = z.object({
	appVersionId: appVersionIdSchema,
	capabilitySha256: sha256Schema,
	deleted: z.boolean(),
	receipt: localSourceUploadReceiptSchema.optional(),
}).strict()

export type LocalSourceUploadGrant = z.infer<typeof localSourceUploadGrantSchema>

export function localSourceUploadSearch(input: LocalSourceUploadCapability): string {
	const parsed = localSourceUploadCapabilitySchema.parse(input)
	return `?${new URLSearchParams({ localVersion: '1', appVersionId: parsed.appVersionId, capability: parsed.capability })}`
}

export function parseLocalSourceUploadSearch(search: string): LocalSourceUploadCapability {
	if (search.length > 256) throw new Error('invalid local source upload capability')
	const parameters = new URLSearchParams(search)
	const parsed = localSourceUploadCapabilitySchema.safeParse({
		appVersionId: parameters.get('appVersionId'),
		capability: parameters.get('capability'),
	})
	if (!parsed.success || search !== localSourceUploadSearch(parsed.data)) throw new Error('invalid local source upload capability')
	return parsed.data
}
