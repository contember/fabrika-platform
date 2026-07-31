import { assertAppRuntimeConformance } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { type HandlerDeps, notesApp } from '../app'
import type { NotesStore } from '../notes'

const unusedNotes: NotesStore = {
	list: () => Promise.reject(new Error('notes access was not expected')),
	create: () => Promise.reject(new Error('notes access was not expected')),
	remove: () => Promise.reject(new Error('notes access was not expected')),
}

function env(): HandlerDeps {
	return {
		readCaller: () => Promise.resolve(null),
		notes: unusedNotes,
	}
}

describe('Zerops reference app runtime conformance', () => {
	test('keeps the public health route portable across adapters', async () => {
		const response = await assertAppRuntimeConformance({
			app: notesApp,
			createEnv: env,
			createRequest: () => new Request('https://notes.test/healthz'),
		})

		expect(response.status).toBe(200)
		expect(response.body).toBe('{"status":"ok"}')
	})
})
