import { describe, expect, test } from 'bun:test'
import { resolveOperationsIamProcessConfig } from '../node/runtime'

const RPC_KEY = 'rpc-key-with-at-least-thirty-two-characters'

describe('Operations IAM process configuration', () => {
	test('resolves the public and private IAM endpoints independently', () => {
		expect(
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_ISSUER: 'https://iam.example.test',
				FABRIKA_IAM_RPC_URL: 'http://iam:3000',
				FABRIKA_IAM_RPC_KEY: RPC_KEY,
			}),
		).toEqual({
			issuer: 'https://iam.example.test',
			rpcOrigin: 'http://iam:3000',
			rpcKey: RPC_KEY,
		})
	})

	test("reads the console's Operations RPC as an OAuth resource when the installation names one", () => {
		const base = { FABRIKA_IAM_ISSUER: 'https://iam.example.test', FABRIKA_IAM_RPC_URL: 'http://iam:3000', FABRIKA_IAM_RPC_KEY: RPC_KEY }
		const resource = 'https://console.example.test/operations/api/rpc'
		expect(resolveOperationsIamProcessConfig({ ...base, FABRIKA_OPERATIONS_OAUTH_RESOURCE: resource }).oauthResource).toBe(resource)
		expect(resolveOperationsIamProcessConfig({ ...base, FABRIKA_OPERATIONS_OAUTH_RESOURCE: ' ' }).oauthResource).toBeUndefined()
	})

	test('names the variable it needs when required IAM configuration is absent', () => {
		expect(() => resolveOperationsIamProcessConfig({})).toThrow('FABRIKA_IAM_ISSUER is required')
		expect(() =>
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_ISSUER: 'https://iam.example.test',
			})
		).toThrow('FABRIKA_IAM_RPC_URL is required')
		expect(() =>
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_ISSUER: 'https://iam.example.test',
				FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			})
		).toThrow('FABRIKA_IAM_RPC_KEY is required')
	})
})
