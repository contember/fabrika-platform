import { describe, expect, test } from 'bun:test'
import { readNotesEnv } from '../env'

const completeEnv = {
	PORT: '3000',
	NOTES_DATABASE_URL: 'postgres://notes.test/notes',
	FABRIKA_IAM_ISSUER: 'https://iam.test',
	NOTES_APP_ID: 'notes',
	FABRIKA_OPERATIONS_DSN: 'https://0123456789abcdef0123456789abcdef@operations.test/123',
	FABRIKA_RELEASE: 'release-123',
}

describe('notes runtime configuration', () => {
	test('reads the two managed Operations values', () => {
		expect(readNotesEnv(completeEnv)).toEqual({
			port: 3000,
			databaseUrl: 'postgres://notes.test/notes',
			iamIssuer: 'https://iam.test',
			appId: 'notes',
			operationsDsn: completeEnv.FABRIKA_OPERATIONS_DSN,
			release: completeEnv.FABRIKA_RELEASE,
		})
	})

	test('refuses to boot without either managed value', () => {
		expect(() => readNotesEnv({ ...completeEnv, FABRIKA_OPERATIONS_DSN: undefined })).toThrow('FABRIKA_OPERATIONS_DSN is required')
		expect(() => readNotesEnv({ ...completeEnv, FABRIKA_RELEASE: undefined })).toThrow('FABRIKA_RELEASE is required')
	})
})
