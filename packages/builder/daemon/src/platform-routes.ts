import type { Route } from '@fabrika/daemon-kit'
import { z } from 'zod'
import { type BuilderPlatformStatus, parseConnectProjectInput, parsePreviewProjectInput, parseRegisterProjectInput } from '../../shared'
import type { BuilderPlatform } from './platform'
import { boundedJson } from './platform-remote'
import { PlatformError } from './platform-storage'

const emptyActionSchema = z.object({}).strict()

export function createPlatformRoutes(platform: BuilderPlatform): Route[] {
	return ['register', 'platform', 'connect', 'disconnect', 'deploy', 'preview'].map((action) => ({
		method: action === 'platform' ? 'GET' : 'POST',
		pattern: new URLPattern({ pathname: `/api/project/:id/${action}` }),
		handler: async (req, _url, match) => {
			try {
				const id = match.pathname.groups['id']
				if (!id) throw new PlatformError('Missing project ID')
				if (action === 'platform') return Response.json(platform.status(id), { headers: { 'cache-control': 'no-store' } })
				const body = await boundedJson(new Response(req.body))
				let status: BuilderPlatformStatus
				switch (action) {
					case 'register':
						status = platform.register(id, parseRegisterProjectInput(body).projectRoot)
						break
					case 'connect':
						status = await platform.connect(id, parseConnectProjectInput(body).controlOrigin)
						break
					case 'preview':
						status = platform.preview(id, parsePreviewProjectInput(body).url)
						break
					default:
						if (!emptyActionSchema.safeParse(body).success) throw new PlatformError('Action expects an empty JSON object')
						status = action === 'deploy' ? platform.deploy(id) : platform.disconnect(id)
				}
				return Response.json(status, { headers: { 'cache-control': 'no-store' } })
			} catch (error) {
				return Response.json({
					error: {
						code: 'builder_platform',
						message: error instanceof PlatformError ? error.message : 'Invalid project request or unavailable local storage',
					},
				}, { status: 400, headers: { 'cache-control': 'no-store' } })
			}
		},
	}))
}
