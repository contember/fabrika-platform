#!/usr/bin/env bun
// Container entrypoint: start the job-protocol HTTP server on the fixed runner port, backed by the
// real Bun spawner and a workspace dir for clones. This is what the Dockerfile's ENTRYPOINT runs.

import { RUNNER_PORT } from '@fabrika/provider-cloudflare/runner'
import { linuxBuildSandbox } from './sandbox'
import { createServer } from './server'
import { bunSpawner } from './spawn'

const workspace = process.env['FABRIKA_RUNNER_WORKSPACE'] ?? '/workspace'
const port = process.env['PORT'] !== undefined ? Number(process.env['PORT']) : RUNNER_PORT

// The build user the image creates (ADR-0086). Probed once: a runner that cannot drop to it refuses every run.
const sandbox = await linuxBuildSandbox({
	uid: Number(process.env['FABRIKA_BUILD_UID'] ?? '10001'),
	gid: Number(process.env['FABRIKA_BUILD_GID'] ?? '10001'),
	network: process.env['FABRIKA_RUNNER_BUILD_NETWORK'] === 'isolated' ? 'isolated' : 'auto',
})
console.info(
	sandbox.unavailable === null
		? `build sandbox ready (network ${sandbox.isolatesNetwork ? 'isolated' : 'open'})`
		: `build sandbox unavailable, every run is refused: ${sandbox.unavailable}`,
)

const server = createServer({ spawn: bunSpawner, workspace, sandbox })

Bun.serve({
	port,
	// The server engine handles the protocol; map every request through it.
	fetch: (request) => server.handle(request),
	// A long clone+install+deploy must not be cut short by Bun's default request timeout.
	idleTimeout: 255,
})

console.info(`runner listening on :${port} (workspace ${workspace})`)
