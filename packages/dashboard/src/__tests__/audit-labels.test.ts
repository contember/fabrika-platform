// Control's audit events read as what happened, in the console's words, on the overview and the audit pages.

import { describe, expect, test } from 'bun:test'
import { auditActionLabel, controlAuditSubject } from '../access/lib/audit-labels'

describe("Control's audit events", () => {
	test('each action Control audits has a label, not its code', () => {
		for (
			const action of [
				'app.create',
				'app.delete',
				'app.env.upsert',
				'app.env.delete',
				'app.secret.upsert',
				'app.secret.set',
				'app.var.upsert',
				'deploy.trigger',
				'access.approve',
				'access.protect',
				'data.backups.schedule',
				'namespace.republish',
				'source.connection.connected',
				'source.workspace.commit',
				'dev.bind',
			]
		) {
			expect(auditActionLabel(action)).not.toBe(action)
		}
		expect(auditActionLabel('app.secret.upsert')).toBe('Secret set')
		expect(auditActionLabel('access.protect')).toBe('Approval rules changed')
	})

	test('what an event did, where its metadata says', () => {
		expect(auditActionLabel('deploy.trigger', { appId: 'notes', env: 'prod', cancelled: true })).toBe('Deploy cancelled')
		expect(auditActionLabel('deploy.trigger', { appId: 'notes', env: 'prod', trigger: 'manual' })).toBe('Deploy started')
		expect(auditActionLabel('access.approve', { decision: 'reject' })).toBe('Change rejected')
		expect(auditActionLabel('access.approve', { decision: 'approve', partial: true })).toBe('Change approved by the first of two')
		expect(auditActionLabel('access.protect', { from: false, to: true })).toBe('Approval turned on')
		expect(auditActionLabel('access.protect', { from: true, to: true })).toBe('Approval rules changed')
		expect(auditActionLabel('data.backups.schedule', { daily: false })).toBe('Daily backups turned off')
		expect(auditActionLabel('apps.secrets.put', { state: 'failed' })).toBe('Approved request: secret set (failed)')
		// Metadata of another shape keeps the action's own label.
		expect(auditActionLabel('access.approve', 'not an object')).toBe('Approval decided')
	})

	test('an unknown action keeps its code, so it can still be found in the audit log', () => {
		expect(auditActionLabel('control.something.new')).toBe('control.something.new')
	})

	test("an approved request's execution says when it failed; another action with a `state` of its own does not", () => {
		expect(auditActionLabel('apps.secrets.put', { state: 'unknown' })).toBe('Approved request: secret set (outcome unknown)')
		expect(auditActionLabel('app.env.suspend', { mode: 'closed', operationId: 'op-1', state: 'failed' })).toBe('Environment taken offline')
	})

	test("the subject is the environment, secret or variable the event's id names, else the application and environment of its metadata", () => {
		const event = (resourceType: string, resourceId: string | null, metadata: unknown = null) => ({ resourceType, resourceId, metadata })
		expect(controlAuditSubject(event('app_env', 'notes/prod'))).toBe('notes / prod')
		expect(controlAuditSubject(event('app_secret', 'notes/prod/PAYMENT_API_KEY', { name: 'PAYMENT_API_KEY', env: 'prod' }))).toBe(
			'notes / prod · PAYMENT_API_KEY',
		)
		expect(controlAuditSubject(event('app_var', 'notes/*/LOG_LEVEL'))).toBe('notes / all environments · LOG_LEVEL')
		expect(controlAuditSubject(event('run', 'run-1', { appId: 'notes', env: 'prod', decision: 'approve' }))).toBe('notes / prod')
		expect(controlAuditSubject(event('app', 'notes'))).toBeNull()
		// One field of another type keeps the others.
		expect(controlAuditSubject(event('workspace', 'ws-1', { appId: 'notes', env: 'test', state: 'succeeded', partial: 'yes' }))).toBe('notes / test')
		// An id of another shape is not guessed at.
		expect(controlAuditSubject(event('app_secret', 'notes/prod'))).toBeNull()
		expect(controlAuditSubject(event('run', 'run-1', null))).toBeNull()
	})
})
