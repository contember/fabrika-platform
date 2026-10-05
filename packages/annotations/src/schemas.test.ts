import { expect, test } from 'bun:test'
import type { z } from 'zod'
import { annotationSchema, annotationStateSchema, localUploadResponseSchema, sharedUploadResponseSchema } from './schemas'

test('draft recovery retains valid annotations, nested extensions and remote identity', () => {
	const annotation = {
		id: 'remote:review:note',
		snippet: 'selected text',
		note: 'keep this',
		createdAt: 'legacy timestamp',
		source: 'remote',
		author: { id: 'reviewer', name: 'Reviewer', color: 'blue' },
		attachments: [{ url: '/asset', mime: 'image/png', width: 20 }],
		context: { before: '', after: '', hierarchy: [], locator: 'stable' },
		custom: { retained: true },
	} satisfies z.input<typeof annotationSchema>
	expect(annotationStateSchema.parse({ annotations: [null, annotation, { id: 4 }], generalNote: 'draft', extension: 1 })).toEqual({
		annotations: [annotation],
		generalNote: 'draft',
		extension: 1,
	})
	expect(annotationStateSchema.parse({ generalNote: 'old note-only draft' })).toEqual({ annotations: [], generalNote: 'old note-only draft' })
	expect(annotationStateSchema.safeParse([]).success).toBe(false)
})

test('upload responses accept their host shape and reject non-string attachment paths', () => {
	expect(localUploadResponseSchema.parse({ path: '/tmp/image.png', size: 40 })).toEqual({ path: '/tmp/image.png' })
	expect(sharedUploadResponseSchema.parse({ url: '/s/share/uploads/image.png' })).toEqual({ url: '/s/share/uploads/image.png' })
	for (const value of [null, [], {}, { path: 7, url: {} }]) {
		expect(localUploadResponseSchema.safeParse(value).success).toBe(false)
		expect(sharedUploadResponseSchema.safeParse(value).success).toBe(false)
	}
})
