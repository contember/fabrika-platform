import { describe, expect, test } from 'bun:test'
import { assertCloudflareMcpAuthoringOff } from '../mcp-authoring'

describe('the MCP authoring switch on Cloudflare', () => {
	test('unset or off passes; on is refused as not supported yet; anything else is refused as malformed', () => {
		assertCloudflareMcpAuthoringOff({})
		assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'off' })
		assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: ' ' })
		expect(() => assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'on' })).toThrow(
			'FABRIKA_PLATFORM_MCP_AUTHORING=on: a Cloudflare installation does not support MCP authoring yet',
		)
		expect(() => assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'yes' })).toThrow('must be on or off')
	})
})
