/**
 * Control does not branch on `ENVIRONMENT` today, and that is precisely why it must not drift: on
 * `fabrika-test` it carried `local` while serving a public `.zerops.app` host (backlog 59), so the next
 * `=== 'local'` branch anyone adds would inherit an installation already claiming to be a laptop.
 *
 * The fact this root states is the console's own public origin (`FABRIKA_CONTROL_DOMAIN`, read through
 * `controlPublicOrigin` so a bare host and a full origin mean the same thing).
 */

import { EnvironmentNameError } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createRuntime } from '../node/runtime'

const base = { FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:pw@127.0.0.1:1/none' }

describe('the control plane environment name', () => {
	test('a console served on a PUBLIC host refuses to boot as `local`', () => {
		// The live spelling is a bare host; `controlPublicOrigin` assumes https for it.
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'local', FABRIKA_CONTROL_DOMAIN: 'proxy-abcd-8080.prg1.zerops.app' }))
			.toThrow(EnvironmentNameError)
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'local', FABRIKA_CONTROL_DOMAIN: 'https://control.example.com' }))
			.toThrow(EnvironmentNameError)
	})

	test('the local stack passes the gate — its console lives on `control.fabrika.localhost`', () => {
		// It still fails on the NEXT missing variable (this fixture configures no bucket and no IAM
		// transport); what must not happen is that it fails on the environment name.
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'local', FABRIKA_CONTROL_DOMAIN: 'http://control.fabrika.localhost:18080' }))
			.not.toThrow(EnvironmentNameError)
	})

	test('a named installation on the same public host passes — the rule is about `local` alone', () => {
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'stage', FABRIKA_CONTROL_DOMAIN: 'proxy-abcd-8080.prg1.zerops.app' }))
			.not.toThrow(EnvironmentNameError)
	})

	test('a composition that states no public origin is not refused — no signal is never a guess', () => {
		expect(() => createRuntime({ ...base, ENVIRONMENT: 'local' })).not.toThrow(EnvironmentNameError)
	})
})
