import { describe, expect, test } from 'bun:test'
import { readS3Options } from './s3'

const complete = {
	FABRIKA_TEST_S3_BUCKET: 'test',
	FABRIKA_TEST_S3_ACCESS_KEY_ID: 'access',
	FABRIKA_TEST_S3_SECRET_ACCESS_KEY: 'secret',
}

describe('readS3Options', () => {
	test('skips when no required variable is configured', () => {
		expect(readS3Options({})).toBeNull()
	})

	test('accepts complete credentials without a custom endpoint', () => {
		expect(readS3Options(complete)).toEqual({
			bucket: 'test',
			accessKeyId: 'access',
			secretAccessKey: 'secret',
			virtualHostedStyle: false,
			region: 'auto',
		})
	})

	test('reports every missing variable in a partial configuration', () => {
		expect(() => readS3Options({ FABRIKA_TEST_S3_BUCKET: 'test' })).toThrow(
			'FABRIKA_TEST_S3_ACCESS_KEY_ID, FABRIKA_TEST_S3_SECRET_ACCESS_KEY',
		)
	})
})
