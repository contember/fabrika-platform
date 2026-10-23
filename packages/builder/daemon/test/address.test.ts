import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_URL, DAEMON_PORT, WS_URL } from '../../cli/src/config'
import { BUILDER_DAEMON_HOST, builderDaemonUrl } from '../../shared/urls'
import { type RunningDaemon, startDaemon } from '../src/index'
import { scratchDir } from './scratch'

let daemon: RunningDaemon
let directory: string

beforeAll(() => {
	directory = scratchDir('builder-address-')
	daemon = startDaemon({ port: 0, sessionsDir: join(directory, 'sessions') })
})

afterAll(() => {
	daemon.stop()
	rmSync(directory, { recursive: true, force: true })
})

test('the daemon binds the IPv4 loopback literal its clients address, never a name a resolver may map to ::1', async () => {
	expect(BUILDER_DAEMON_HOST).toBe('127.0.0.1')
	expect(daemon.server.hostname).toBe(BUILDER_DAEMON_HOST)
	expect(daemon.server.url.origin).toBe(builderDaemonUrl(daemon.port))

	const health = await fetch(`${builderDaemonUrl(daemon.port)}/health`)
	expect(health.status).toBe(200)
})

test('the CLI addresses the daemon through the same shared constant', () => {
	expect(BASE_URL).toBe(builderDaemonUrl(DAEMON_PORT))
	expect(WS_URL).toBe(builderDaemonUrl(DAEMON_PORT, 'ws'))
	expect(new URL(BASE_URL).hostname).toBe(BUILDER_DAEMON_HOST)
})
