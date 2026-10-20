import { normalizeZeropsSourceRepository, ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '@fabrika/provider-zerops'
import { z } from 'zod'

export const LOCAL_SOURCE_FIXTURE_DIRECTORY = 'source-fixtures'
export const LOCAL_SOURCE_MANIFEST_FILE = 'manifest.json'
export const LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE = 'platform.tar.gz'
export const LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE = 'application.tar.gz'
export const LOCAL_SOURCE_AGENT_CHANGE_ARCHIVE_FILE = 'agent-change.tar.gz'
/** The files of the agent change commit, which Control reads one by one and the composed Notes container can run. */
export const LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY = 'agent-change'
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
	/** A second commit of the application repository, on top of `application`: an agent's change to Notes. */
	agentChange: localSourceFixtureSchema,
	/** The Notes example as each tag of `LOCAL_SOURCE_RELEASE_TAGS` holds it: ADR-0062's compatibility suite. */
	release055: localSourceFixtureSchema,
	release048: localSourceFixtureSchema,
}).strict()

/**
 * Where the application repository's `main` points, as a push leaves it: `triggerByScopedWebhook` writes it before it
 * sends the push event, and the GitHub double reads it. Without it `main` is the pinned application commit.
 */
export const LOCAL_SOURCE_BRANCH_HEAD_FILE = 'github-branch-head.json'

export const localSourceBranchHeadSchema = z.object({ version: z.literal(1), commitSha: gitObjectIdSchema }).strict()

export type LocalSourceBranchHead = z.infer<typeof localSourceBranchHeadSchema>

/**
 * The released framework minors of the window an application fixture is recorded for, each at its newest patch: an
 * application on that release, unchanged, deployed against this platform (`local:compat`). Each is a commit of the
 * application repository of its own.
 */
export const LOCAL_SOURCE_RELEASE_TAGS = { release055: 'v0.5.5', release048: 'v0.4.8' } as const

export type LocalSourceReleaseKind = keyof typeof LOCAL_SOURCE_RELEASE_TAGS

export const LOCAL_SOURCE_RELEASE_KINDS: readonly LocalSourceReleaseKind[] = ['release055', 'release048']

export type LocalSourceFixtureKind = 'platform' | 'application' | 'agentChange' | LocalSourceReleaseKind

export const LOCAL_SOURCE_FIXTURE_KINDS: readonly LocalSourceFixtureKind[] = ['platform', 'application', 'agentChange', ...LOCAL_SOURCE_RELEASE_KINDS]

export const LOCAL_SOURCE_ARCHIVE_FILES: Readonly<Record<LocalSourceFixtureKind, string>> = {
	platform: LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	application: LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	agentChange: LOCAL_SOURCE_AGENT_CHANGE_ARCHIVE_FILE,
	release055: `release-${LOCAL_SOURCE_RELEASE_TAGS.release055}.tar.gz`,
	release048: `release-${LOCAL_SOURCE_RELEASE_TAGS.release048}.tar.gz`,
}

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
