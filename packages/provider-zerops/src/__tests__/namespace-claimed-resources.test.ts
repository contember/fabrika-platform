import type { ProviderDeploymentNamespace } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { type ZeropsApi, ZeropsApiError } from '../api'
import { createZeropsArtifactSourceDescriptor } from '../manifest'
import { claimedResources } from '../namespace/claims'
import { envelope } from '../namespace/codec'

const PROJECT_ID = 'project-1'

const namespace = async (projectId: string | undefined): Promise<ProviderDeploymentNamespace> => ({
	id: 'dev',
	env: 'dev',
	target: envelope({
		proxySource: {
			repository: { owner: 'example', name: 'platform' },
			commitSha: 'a'.repeat(40),
			descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
		},
		...(projectId === undefined ? {} : { projectId }),
	}),
})

/** A project whose services are `live`; `project` is what reading the project answers instead, when set. */
const api = (live: readonly string[], project?: ZeropsApiError): Pick<ZeropsApi, 'getProject' | 'findService'> & { reads: string[] } => {
	const reads: string[] = []
	return {
		reads,
		getProject: async ({ projectId }) => {
			reads.push(`project:${projectId}`)
			if (project !== undefined) throw project
			return { id: projectId, name: 'fabrika-dev-dev' }
		},
		findService: async ({ projectId, hostname }) => {
			reads.push(`service:${projectId}/${hostname}`)
			return live.includes(hostname) ? { id: `id-${hostname}`, name: hostname } : null
		},
	}
}

const check = async (zerops: Pick<ZeropsApi, 'getProject' | 'findService'>, projectId: string | undefined, resourceKeys: readonly string[]) =>
	claimedResources(zerops, { namespace: await namespace(projectId), resourceKeys, signal: new AbortController().signal })

describe('claimed resources of a Zerops namespace', () => {
	test('a claimed service the project still has exists; one it does not is gone', async () => {
		const zerops = api(['notesapi'])
		expect(await check(zerops, PROJECT_ID, ['service:notesapi', 'service:notesfiles'])).toEqual([
			{ resourceKey: 'service:notesapi', exists: true },
			{ resourceKey: 'service:notesfiles', exists: false },
		])
		expect(zerops.reads).toEqual(['project:project-1', 'service:project-1/notesapi', 'service:project-1/notesfiles'])
	})

	test('a deleted project (projectNotFound) makes every claimed service gone without reading one', async () => {
		const zerops = api(['notesapi'], new ZeropsApiError('zerops: get project failed (400) — projectNotFound', 400, 'projectNotFound'))
		expect(await check(zerops, PROJECT_ID, ['service:notesapi'])).toEqual([{ resourceKey: 'service:notesapi', exists: false }])
		expect(zerops.reads).toEqual(['project:project-1'])
	})

	test('a project the token holds no grant on is not gone: the check fails and names the platform code', async () => {
		const forbidden = new ZeropsApiError('zerops: get project failed (403) — insufficientPermissions', 403, 'insufficientPermissions')
		const failure = await check(api([], forbidden), PROJECT_ID, ['service:notesapi']).then(() => null, (error: unknown) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(failure instanceof ProviderNamespaceError ? failure.code : null).toBe('insufficientPermissions')
	})

	test('a namespace that recorded no project, or a key that names no service, cannot be checked', async () => {
		await expect(check(api([]), undefined, ['service:notesapi'])).rejects.toThrow('records no project')
		await expect(check(api([]), PROJECT_ID, ['bucket:files'])).rejects.toThrow('cannot tell whether claimed resource `bucket:files` exists')
	})
})
