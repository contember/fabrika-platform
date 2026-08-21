import { decodeZeropsSourceCredentialBundleV2, ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { LOCAL_KEYED_GITHUB_CONNECTION_IDS, localSourceCredentialFixture } from '../source-connection-fixture'

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGeAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQggU7n06NJtiTRuqt/1tIn
SD1Im36bZhuyc7EzDV1yjRmhRANCAAT2yfI2EiZYw/hBhjtJ8zobwh6+kZX5lJxV
NjpcKCfCXekInbtbJjAC43eQG8vgFgqf5zTAdD91RLdyHuoXBj0u
-----END PRIVATE KEY-----`

describe('local source connection fixture', () => {
	test('composes two independent v2 slots and no unkeyed credential', async () => {
		const env = await localSourceCredentialFixture('local-rpc-key', PRIVATE_KEY)
		expect(env.FABRIKA_SOURCE_RPC_KEY).toBe('local-rpc-key')
		expect(Object.keys(env).filter((name) => name.startsWith('GITHUB_APP_') && !name.startsWith(ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX)))
			.toEqual([])
		const slots = Object.entries(env).filter(([name]) => name.startsWith(ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX))
		expect(slots).toHaveLength(2)
		expect(slots.map(([, value]) => decodeZeropsSourceCredentialBundleV2(value).connectionId).sort()).toEqual(
			[...LOCAL_KEYED_GITHUB_CONNECTION_IDS].sort(),
		)
	})
})
