import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { AuditEventDto, PrincipalListItem } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { actorIdsToResolve, type AuditActor, auditActor, resolveActors } from '../access/lib/audit-actors'
import { ActorCell } from '../routes/access/audit'

const USER_ID = '01a13f67-253c-70ea-b4e3-fbb18b79a7fe'

function event(overrides: Partial<AuditEventDto>): AuditEventDto {
	return {
		id: 'event-1',
		requestId: 'request-1',
		principalId: USER_ID,
		principalLabel: USER_ID,
		credentialId: null,
		app: 'vozka',
		action: 'iam.admin.access',
		resourceType: 'admin',
		resourceId: null,
		diff: null,
		metadata: null,
		createdAt: 1_760_000_000,
		...overrides,
	}
}

function principal(id: string, label: string, type: PrincipalListItem['type'] = 'user'): PrincipalListItem {
	return { id, type, label, email: label.toLowerCase(), externalId: null, status: 'active', affiliation: 'internal', createdAt: 1_760_000_000 }
}

// The real route map, so a link resolves to the path the console serves.
const withRouter = (element: React.ReactElement): React.ReactElement =>
	createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'access/users/detail': '/access/users/:id', 'access/audit': '/access/audit' },
		}),
	}, element)

const cell = (actor: AuditActor): string => renderToStaticMarkup(withRouter(createElement(ActorCell, { actor })))

describe('audit actors', () => {
	test('looks up each user named only by id once, and nothing an audit row already names', () => {
		const events = [
			event({ id: 'a' }),
			event({ id: 'b' }),
			event({ id: 'c', principalId: 'service-1', principalLabel: 'deploy-bot' }),
			event({ id: 'd', principalId: 'service-2', principalLabel: 'link', credentialId: 'credential-1' }),
			event({ id: 'e', principalId: null, principalLabel: 'anonymous' }),
		]

		expect(actorIdsToResolve(events)).toEqual([USER_ID])
	})

	test('keeps the ids of principals that cannot be read', async () => {
		const resolved = await resolveActors([USER_ID, 'deleted-1'], async (principalId) => {
			if (principalId === USER_ID) return principal(USER_ID, 'Ada@Example.com')
			throw new Error('principal not found')
		})

		expect([...resolved.keys()]).toEqual([USER_ID])
		expect(auditActor(event({}), resolved)).toEqual({ kind: 'principal', principalId: USER_ID, label: 'Ada@Example.com', isUser: true })
		expect(auditActor(event({ principalId: 'deleted-1', principalLabel: 'deleted-1' }), resolved))
			.toEqual({ kind: 'principal', principalId: 'deleted-1', label: 'deleted-1', isUser: false })
	})

	test('shows a service by its key name and a credential by its id', () => {
		const resolved = new Map<string, PrincipalListItem>()
		expect(auditActor(event({ principalId: 'service-1', principalLabel: 'deploy-bot' }), resolved))
			.toEqual({ kind: 'principal', principalId: 'service-1', label: 'deploy-bot', isUser: false })
		expect(auditActor(event({ credentialId: 'credential-1' }), resolved)).toEqual({ kind: 'credential', credentialId: 'credential-1' })
		expect(auditActor(event({ principalId: null, principalLabel: 'anonymous' }), resolved)).toEqual({ kind: 'label', label: 'anonymous' })
	})

	test('a name narrows the log to its principal, as the rest of the row does', () => {
		const markup = cell({ kind: 'principal', principalId: USER_ID, label: 'Ada@Example.com', isUser: true })

		expect(markup).toContain(`href="/access/audit?principalId=${USER_ID}"`)
		expect(markup).toContain('>Ada@Example.com</span></a>')
		expect(markup).toContain(`(${USER_ID})`)
	})

	test('a person also keeps a way to their page, and a machine or an unread principal does not', () => {
		expect(cell({ kind: 'principal', principalId: USER_ID, label: 'Ada@Example.com', isUser: true })).toContain(`href="/access/users/${USER_ID}"`)
		const unread = cell({ kind: 'principal', principalId: USER_ID, label: USER_ID, isUser: false })
		expect(unread).not.toContain('/access/users/')
		expect(unread).toContain(`href="/access/audit?principalId=${USER_ID}"`)
	})
})
