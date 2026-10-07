import { z } from 'zod'

// Carry old and host-extended drafts intact; hydration owns validation of individual entries.
const carriedDraftSchema = z.object({}).passthrough()
const draftContentSchema = z.object({
	annotations: z.array(z.unknown()).catch([]),
	generalNote: z.string().catch(''),
	responses: z.array(z.unknown()).catch([]),
})
const responseContentSchema = z.tuple([
	z.unknown(),
	z.object({ note: z.unknown(), value: z.unknown() }),
])

interface RevisionState {
	revision: number
	hasFeedback: boolean
}

interface AnnotationStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

interface RemovableAnnotationStorage {
	removeItem(key: string): void
}

export type AnnotationDraftPhase = 'current' | 'next'

export function annotationDraftKey(
	sessionId: string,
	revision: number,
	phase: AnnotationDraftPhase = 'current',
): string {
	const base = `canvas:${sessionId}:rev:${revision}`
	return phase === 'next' ? `${base}:next-draft` : base
}

function handledKey(sessionId: string, revision: number): string {
	return `${annotationDraftKey(sessionId, revision)}:draft-handled`
}

export function clearPersistedDraft(
	storage: RemovableAnnotationStorage,
	sessionId: string,
	revision: number,
): void {
	try {
		storage.removeItem(annotationDraftKey(sessionId, revision))
		storage.removeItem(handledKey(sessionId, revision))
	} catch {}
}

function parseState(raw: string | null): object | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		const result = carriedDraftSchema.safeParse(value)
		return result.success ? result.data : null
	} catch {
		return null
	}
}

function hasResponseValue(entry: unknown): boolean {
	const parsed = responseContentSchema.safeParse(entry)
	if (!parsed.success) return false
	const { note, value } = parsed.data[1]
	if (typeof note === 'string' && note.trim().length > 0) return true

	if (typeof value === 'string') return value.trim().length > 0
	if (Array.isArray(value)) return value.length > 0
	return value !== null && value !== undefined
}

function hasDraftContent(state: object | null): boolean {
	if (!state) return false
	const { annotations, generalNote, responses } = draftContentSchema.parse(state)
	return annotations.length > 0 || generalNote.trim().length > 0 || responses.some(hasResponseValue)
}

/** Carry an unsent draft forward without crossing submitted revisions. */
export function carryUnsubmittedDraft(
	storage: AnnotationStorage,
	sessionId: string,
	targetRevision: number,
	revisions: RevisionState[],
): number | null {
	try {
		const targetKey = annotationDraftKey(sessionId, targetRevision)
		if (hasDraftContent(parseState(storage.getItem(targetKey)))) {
			storage.setItem(handledKey(sessionId, targetRevision), '1')
			return null
		}
		if (storage.getItem(handledKey(sessionId, targetRevision)) !== null) return null

		const previous = revisions
			.filter((revision) => revision.revision < targetRevision)
			.sort((left, right) => right.revision - left.revision)

		for (const revision of previous) {
			if (revision.hasFeedback) {
				const sourceKey = annotationDraftKey(sessionId, revision.revision, 'next')
				const source = parseState(storage.getItem(sourceKey))
				if (!hasDraftContent(source)) return null

				storage.setItem(
					targetKey,
					JSON.stringify({
						...source,
						feedbackEntries: [],
					}),
				)
				storage.setItem(handledKey(sessionId, targetRevision), '1')
				storage.removeItem(sourceKey)
				return revision.revision
			}

			const source = parseState(storage.getItem(annotationDraftKey(sessionId, revision.revision)))
			if (!hasDraftContent(source)) {
				if (storage.getItem(handledKey(sessionId, revision.revision)) !== null) return null
				continue
			}

			storage.setItem(
				targetKey,
				JSON.stringify({
					...source,
					feedbackEntries: [],
				}),
			)
			storage.setItem(handledKey(sessionId, targetRevision), '1')
			return revision.revision
		}
	} catch {}

	return null
}
