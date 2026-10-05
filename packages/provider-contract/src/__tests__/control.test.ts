import { describe, expect, test } from 'bun:test'
import { ProviderNamespaceError } from '..'

describe('ProviderNamespaceError', () => {
	test('carries a stable code and the upstream detail beside a catchable Error', () => {
		const error = new ProviderNamespaceError('zerops: project import failed (403)', 'insufficientPermissions', false, 'token may not create projects')

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('ProviderNamespaceError')
		expect(error.message).toBe('zerops: project import failed (403)')
		expect(error.code).toBe('insufficientPermissions')
		expect(error.retryable).toBe(false)
		expect(error.detail).toBe('token may not create projects')
	})

	test('leaves detail absent when the upstream said nothing beyond its code', () => {
		const error = new ProviderNamespaceError('namespace provisioning was cancelled', 'namespaceCancelled', true)

		expect(error.detail).toBeUndefined()
		expect(error.retryable).toBe(true)
	})
})
