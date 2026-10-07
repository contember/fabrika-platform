import { providerEnvelopeSchema } from '@fabrika/control/api/provider-envelope'
import { z } from 'zod'

const text = z.string().min(1)
// Unrelated list entries remain ignorable, and provider-owned payloads stay opaque.
export const namespaceViewSchema = z.object({ id: z.unknown(), state: z.unknown(), lastErrorCode: z.unknown(), lastError: z.unknown() }).catch({})
export const namespacePlanSchema = z.object({ namespace: z.unknown() }).catch({})
export const environmentViewSchema = z.object({
	env: z.unknown(),
	domain: z.unknown(),
	publicOrigin: z.unknown(),
	triggerRef: z.unknown(),
	namespaceId: z.unknown(),
	target: z.unknown(),
	artifact: z.unknown(),
}).catch({})
export const runViewSchema = z.object({ status: z.unknown(), externalRunId: z.string().optional().catch(undefined) }).catch({})
export const completedRunSchema = z.object({ commitSha: text })
export const appSourceSchema = z.object({ id: text, repoUrl: text, workerDir: z.string() })
export const namespaceTargetViewSchema = z.object({ target: providerEnvelopeSchema })
export const activeOperationsConfigSchema = z.object({ dsn: text, ingestProjectId: text, serviceKey: text })
export const serviceViewSchema = z.object({ name: z.unknown(), id: z.unknown() }).catch({})
export const envViewSchema = z.object({ serviceStackId: z.unknown(), key: z.unknown(), content: z.unknown() }).catch({})
export const managedSnapshotSchema = z.object({ services: z.array(serviceViewSchema), serviceEnv: z.array(envViewSchema) })
export const iamSchemaResponseSchema = z.object({ actions: z.array(z.unknown()), scopes: z.array(z.unknown()) })
export const keyPrincipalSchema = z.object({ apiKey: text, principalId: text })
export const publicStatusSchema = z.object({ app: z.unknown() }).catch({})
const noteViewSchema = z.object({ title: z.unknown() }).catch({})
export const createdNoteSchema = z.object({ note: noteViewSchema }).catch({ note: {} })
export const notesListSchema = z.object({ notes: z.array(noteViewSchema) })
export const issueViewSchema = z.object({
	title: z.string().optional().catch(undefined),
	count: z.unknown(),
	id: z.unknown(),
	source: z.object({ appId: z.unknown(), environment: z.unknown(), serviceKey: z.unknown() }).catch({}),
}).catch({ source: {} })
export const issueListSchema = z.object({ items: z.array(issueViewSchema) })
export const storageRowsSchema = z.array(z.object({ id: z.unknown(), sourceId: z.unknown(), fingerprint: z.unknown() }).catch({}))
export const storageIdentitySchema = z.object({ sourceId: text, fingerprint: text })
export const errorResponseSchema = z.object({ error: z.string() })
