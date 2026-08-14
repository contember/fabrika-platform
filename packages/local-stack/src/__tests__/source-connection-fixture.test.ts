import {
	decodeZeropsSourceCredentialBundle,
	decodeZeropsSourceCredentialBundleV2,
	ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { LOCAL_KEYED_GITHUB_CONNECTION_IDS, LOCAL_LEGACY_GITHUB_APP_ID, localSourceCredentialFixture } from '../source-connection-fixture'

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGeAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQggU7n06NJtiTRuqt/1tIn
SD1Im36bZhuyc7EzDV1yjRmhRANCAAT2yfI2EiZYw/hBhjtJ8zobwh6+kZX5lJxV
NjpcKCfCXekInbtbJjAC43eQG8vgFgqf5zTAdD91RLdyHuoXBj0u
-----END PRIVATE KEY-----`

describe('local source connection fixture', () => {
	test('composes one legacy snapshot and two independent v2 slots', async () => {
		const env = await localSourceCredentialFixture('local-rpc-key', PRIVATE_KEY)
		expect(env.FABRIKA_SOURCE_RPC_KEY).toBe('local-rpc-key')
		const legacy = decodeZeropsSourceCredentialBundle(env.GITHUB_APP_CREDENTIALS)
		expect(legacy.githubAppId).toBe(LOCAL_LEGACY_GITHUB_APP_ID)
		const slots = Object.entries(env).filter(([name]) => name.startsWith(ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX))
		expect(slots).toHaveLength(2)
		expect(slots.map(([, value]) => decodeZeropsSourceCredentialBundleV2(value).connectionId).sort()).toEqual(
			[...LOCAL_KEYED_GITHUB_CONNECTION_IDS].sort(),
		)
	})
})
