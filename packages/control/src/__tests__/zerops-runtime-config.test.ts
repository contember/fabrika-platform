import { describe, expect, test } from 'bun:test'
import { controlServiceDigest } from '../../fabrika.service'
import { createRuntime, readIamRpcProcessConfig } from '../zerops/runtime'

describe('the Node IAM RPC process configuration', () => {
	test('uses the private RPC origin independently of the public issuer', () => {
		expect(readIamRpcProcessConfig({
			FABRIKA_IAM_ISSUER: 'https://iam.example.test',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'rpc-key-with-at-least-thirty-two-characters',
		})).toEqual({
			origin: 'http://iam:3000',
			key: 'rpc-key-with-at-least-thirty-two-characters',
		})
	})

	test('does not fall back to the public issuer', () => {
		expect(() =>
			readIamRpcProcessConfig({
				FABRIKA_IAM_ISSUER: 'https://iam.example.test',
				FABRIKA_IAM_RPC_KEY: 'rpc-key-with-at-least-thirty-two-characters',
			})
		).toThrow('FABRIKA_IAM_RPC_URL is required')
	})
})

describe("the installation's mail transport at boot", () => {
	test('an invalid FABRIKA_EMAIL_* fails the boot naming the variable, never its value, before the pool opens', () => {
		const source = {
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://control@127.0.0.1:1/control',
			FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: false }),
			ENVIRONMENT: 'stage',
			FABRIKA_CONTROL_DOMAIN: 'control.example.test',
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-private-key',
		}
		let message = ''
		try {
			createRuntime(source)
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).toContain('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing')
		expect(message).not.toContain('se-private-key')
		expect(() => createRuntime({ ...source, FABRIKA_EMAIL_PROVIDER: 'postmark' })).toThrow('FABRIKA_EMAIL_PROVIDER must be none or one of')
	})
})
