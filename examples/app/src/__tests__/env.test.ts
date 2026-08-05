import { describe, expect, test } from 'bun:test'
import { readIamIssuer } from '../env'

describe('readIamIssuer', () => {
	test('reads the issuer off the env', () => {
		expect(readIamIssuer({ FABRIKA_IAM_ISSUER: 'https://iam.example.com' })).toBe('https://iam.example.com')
	})

	test('requires an IAM issuer', () => {
		expect(() => readIamIssuer({})).toThrow('FABRIKA_IAM_ISSUER is required')
	})
})
