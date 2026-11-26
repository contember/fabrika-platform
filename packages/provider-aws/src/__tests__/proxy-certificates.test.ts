// A namespace proxy's certificates over a fake ACM: one requested per routed host and recorded as ACM answers it, read
// again on the next pass with the record the operator adds, a certificate deleted out of band requested anew, a failed
// one left for the operator, a departed host's kept; and what the namespace's presentation says of each.

import { contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderDeploymentNamespace, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { Certificate } from '../aws/acm'
import { awsAppArtifactCodec, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec, type AwsProxyCertificate } from '../codecs'
import { awsNamespaceTargetEnvelope, awsProxyCertificatePresentation } from '../namespace'
import { awsProxyHosts, ensureAwsProxyCertificates } from '../proxy-certificates'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const PROXY_SOURCE = { repository: { owner: 'contember', name: 'fabrika-platform' }, commitSha: '0123456789abcdef0123456789abcdef01234567' }
const PINNED: AwsNamespaceTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	stackName: 'fabrika-ns-6-shared-prod',
	sizing: 'cheap',
	proxyRepository: 'contember/fabrika-platform',
	proxyCommitSha: PROXY_SOURCE.commitSha,
}
const namespaceOf = (target: AwsNamespaceTarget): ProviderDeploymentNamespace => ({
	id: 'shared',
	env: 'prod',
	target: awsNamespaceTargetEnvelope(target),
})
const decoded = (namespace: ProviderDeploymentNamespace): AwsNamespaceTarget => awsNamespaceTargetCodec.decode(namespace.target.payload)

const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }
const access: ProviderApprovedAccess = { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.9.1' }
const member = (appId: string, domain: string | undefined, approved = true): ProviderNamespaceMember => ({
	appId,
	env: 'prod',
	...(domain === undefined ? {} : { domain }),
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	...(approved ? { access } : {}),
	proxySecret: `${appId}-proxy-secret`,
})
const RECORD = { name: '_3f2a9c.notes.example.com.', value: '_7b1d.abcdefgh.acm-validations.aws.' }

/** ACM, and the namespace's checkpoints, in memory. */
class Fake {
	readonly certificates = new Map<string, Certificate>()
	readonly requests: { readonly host: string; readonly token: string }[] = []
	readonly checkpoints: ProviderDeploymentNamespace[] = []
	readonly clients = {
		acm: {
			requestCertificate: async ({ host, token }: { readonly host: string; readonly token: string }) => {
				const index = this.requests.findIndex((request) => request.token === token)
				const number = index === -1 ? this.requests.length + 1 : index + 1
				if (index === -1) this.requests.push({ host, token })
				const arn = `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
				if (index === -1) this.certificates.set(arn, { arn, host, status: 'PENDING_VALIDATION', validation: null, inUseBy: [] })
				return arn
			},
			describeCertificate: async (arn: string) => this.certificates.get(arn) ?? null,
		},
	}
	readonly events = {
		checkpoint: async (namespace: ProviderDeploymentNamespace) => {
			this.checkpoints.push(namespace)
		},
		boundary: async () => {},
	}

	run(namespace: ProviderDeploymentNamespace, members: readonly ProviderNamespaceMember[]): Promise<ProviderDeploymentNamespace> {
		return ensureAwsProxyCertificates({
			namespace,
			members,
			installation,
			proxySource: PROXY_SOURCE,
			clients: this.clients,
			events: this.events,
			signal: new AbortController().signal,
		})
	}

	set(arn: string, change: Partial<Certificate>): void {
		const certificate = this.certificates.get(arn)
		if (certificate !== undefined) this.certificates.set(arn, { ...certificate, ...change })
	}
}

const ARN_1 = 'arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-000000000001'
const ARN_2 = 'arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-000000000002'

describe('ensureAwsProxyCertificates', () => {
	test('the routed hosts are the approved members, sorted; an approved member without a domain is refused as the manifest refuses it', () => {
		expect(awsProxyHosts([member('notes', 'notes.example.com'), member('crm', 'crm.example.com'), member('draft', 'draft.example.com', false)]))
			.toEqual(['crm.example.com', 'notes.example.com'])
		expect(() => awsProxyHosts([member('bare', undefined)])).toThrow('has no domain')
	})

	test('requests one certificate per host, tagged with the namespace, and records it as soon as ACM answered', async () => {
		const fake = new Fake()
		const namespace = await fake.run(namespaceOf(PINNED), [member('notes', 'notes.example.com')])
		expect(fake.requests).toHaveLength(1)
		expect(fake.requests[0]?.host).toBe('notes.example.com')
		expect(fake.requests[0]?.token).toMatch(/^[0-9a-f]{32}$/)
		expect(decoded(namespace).proxyCertificates).toEqual([{ host: 'notes.example.com', arn: ARN_1, status: 'PENDING_VALIDATION' }])
		// Checkpointed before the function returned.
		expect(fake.checkpoints.map(decoded).at(-1)?.proxyCertificates).toEqual(decoded(namespace).proxyCertificates)
	})

	test('the next pass reads the record the operator adds, then the issue, and requests nothing more', async () => {
		const fake = new Fake()
		const members = [member('notes', 'notes.example.com')]
		const requested = await fake.run(namespaceOf(PINNED), members)
		fake.set(ARN_1, { validation: RECORD })
		const pending = await fake.run(requested, members)
		expect(decoded(pending).proxyCertificates).toEqual([{
			host: 'notes.example.com',
			arn: ARN_1,
			status: 'PENDING_VALIDATION',
			validationName: RECORD.name,
			validationValue: RECORD.value,
		}])
		fake.set(ARN_1, { status: 'ISSUED' })
		const issued = await fake.run(pending, members)
		expect(decoded(issued).proxyCertificates?.[0]?.status).toBe('ISSUED')
		expect(fake.requests).toHaveLength(1)
		// Nothing changed: nothing is recorded.
		const checkpoints = fake.checkpoints.length
		await fake.run(issued, members)
		expect(fake.checkpoints).toHaveLength(checkpoints)
	})

	test('a certificate ACM no longer knows is requested anew under a token of its own', async () => {
		const fake = new Fake()
		const members = [member('notes', 'notes.example.com')]
		const requested = await fake.run(namespaceOf(PINNED), members)
		fake.certificates.delete(ARN_1)
		const again = await fake.run(requested, members)
		expect(fake.requests).toHaveLength(2)
		expect(fake.requests[1]?.token).not.toBe(fake.requests[0]?.token)
		expect(decoded(again).proxyCertificates).toEqual([{ host: 'notes.example.com', arn: ARN_2, status: 'PENDING_VALIDATION' }])
		// The entry was replaced in one checkpoint, never dropped first.
		expect(fake.checkpoints.map(decoded).every((target) => target.proxyCertificates?.length === 1)).toBe(true)
	})

	test('a lost answer repeated asks with the same token, so ACM answers the same certificate', async () => {
		const fake = new Fake()
		const members = [member('notes', 'notes.example.com')]
		await fake.run(namespaceOf(PINNED), members)
		// The answer never reached the target: the next pass starts from the target without it.
		const repeated = await fake.run(namespaceOf(PINNED), members)
		expect(fake.requests).toHaveLength(1)
		expect(decoded(repeated).proxyCertificates?.[0]?.arn).toBe(ARN_1)
	})

	test('a failed certificate stays recorded for the operator, and a departed host keeps its own', async () => {
		const fake = new Fake()
		const requested = await fake.run(namespaceOf(PINNED), [member('notes', 'notes.example.com'), member('crm', 'crm.example.com')])
		const crm = decoded(requested).proxyCertificates?.find((certificate) => certificate.host === 'crm.example.com')
		fake.set(crm?.arn ?? '', { status: 'VALIDATION_TIMED_OUT' })
		// The notes member left; the crm certificate timed out.
		const later = await fake.run(requested, [member('crm', 'crm.example.com')])
		expect(fake.requests).toHaveLength(2)
		expect(decoded(later).proxyCertificates?.map((certificate) => [certificate.host, certificate.status, certificate.departed])).toEqual([
			['crm.example.com', 'VALIDATION_TIMED_OUT', undefined],
			['notes.example.com', 'PENDING_VALIDATION', true],
		])
		// Nothing here deletes: the operator does, and the pass after forgets the entry.
		const notes = decoded(later).proxyCertificates?.find((certificate) => certificate.host === 'notes.example.com')
		fake.certificates.delete(notes?.arn ?? '')
		const forgotten = await fake.run(later, [member('crm', 'crm.example.com')])
		expect(decoded(forgotten).proxyCertificates?.map((certificate) => certificate.host)).toEqual(['crm.example.com'])
		// A host that comes back while its certificate lives is current again, under the same certificate.
		const back = await fake.run(later, [member('crm', 'crm.example.com'), member('notes', 'notes.example.com')])
		expect(decoded(back).proxyCertificates?.find((certificate) => certificate.host === 'notes.example.com')?.departed).toBeUndefined()
	})

	test('a certificate recorded for a host that reads back as another is refused', async () => {
		const fake = new Fake()
		const members = [member('notes', 'notes.example.com')]
		const requested = await fake.run(namespaceOf(PINNED), members)
		fake.set(ARN_1, { host: 'evil.example.com' })
		await expect(fake.run(requested, members)).rejects.toThrow("another host's")
	})

	test('a host over the cap waits for a place, the pass still runs, and a departed one deleted makes room', async () => {
		const fake = new Fake()
		const members = Array.from(
			{ length: 26 },
			(_, index) => member(`app${String(index).padStart(2, '0')}`, `app${String(index).padStart(2, '0')}.example.com`),
		)
		const capped = await fake.run(namespaceOf(PINNED), members)
		expect(fake.requests).toHaveLength(25)
		expect(decoded(capped).proxyCertificates?.some((certificate) => certificate.host === 'app25.example.com')).toBe(false)
		// app00 leaves and its certificate is deleted by the operator: app25 gets the place on the next pass.
		const [, ...staying] = members
		const left = await fake.run(capped, staying)
		const departed = decoded(left).proxyCertificates?.find((certificate) => certificate.host === 'app00.example.com')
		expect(departed?.departed).toBe(true)
		expect(fake.requests).toHaveLength(25)
		fake.certificates.delete(departed?.arn ?? '')
		const roomy = await fake.run(left, staying)
		expect(fake.requests).toHaveLength(26)
		expect(decoded(roomy).proxyCertificates?.map((certificate) => certificate.host)).toContain('app25.example.com')
	})
})

describe('awsProxyCertificatePresentation', () => {
	test('a fact per certificate, the record to add for a pending one, and the way out of a failed one', () => {
		const presented = awsProxyCertificatePresentation({
			...PINNED,
			proxyCertificates: [
				{ host: 'a.example.com', arn: ARN_1, status: 'PENDING_VALIDATION' },
				{ host: 'b.example.com', arn: ARN_2, status: 'PENDING_VALIDATION', validationName: RECORD.name, validationValue: RECORD.value },
				{ host: 'c.example.com', arn: ARN_1.replace('001', '003'), status: 'ISSUED' },
				{ host: 'd.example.com', arn: ARN_1.replace('001', '004'), status: 'FAILED' },
				{ host: 'e.example.com', arn: ARN_1.replace('001', '005'), status: 'ISSUED', departed: true },
			],
		})
		expect(presented.facts.map((fact) => [fact.label, fact.resource])).toEqual([
			['Certificate for a.example.com', true],
			['Certificate for b.example.com', true],
			// The record stays shown: renewal validates with it.
			['DNS record for b.example.com', undefined],
			['Certificate for c.example.com', true],
			['Certificate for d.example.com', true],
			['Certificate for e.example.com', true],
		])
		expect(presented.instructions).toEqual([
			'The certificate for a.example.com was just requested: reconcile the namespace in a minute to read the DNS record it needs.',
			`The certificate of b.example.com needs the DNS record ${RECORD.name} CNAME ${RECORD.value}: add it and keep it in place (Certificate Manager renews with it), and reconcile the namespace once it is in place.`,
			`The certificate for d.example.com is FAILED: delete ${
				ARN_1.replace('001', '004')
			} in Certificate Manager, then reconcile the namespace to request a new one.`,
			`The host e.example.com is no member's any more: delete its certificate ${
				ARN_1.replace('001', '005')
			} in Certificate Manager once it is off the listener, and its DNS record; the next reconcile forgets it.`,
		])
	})

	test('at the cap, the presentation says a new host waits for a departed one to be deleted', () => {
		const full: AwsProxyCertificate[] = Array.from({ length: 25 }, (_, index) => ({
			host: `h${index}.example.com`,
			arn: `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
			status: 'ISSUED',
		}))
		expect(awsProxyCertificatePresentation({ ...PINNED, proxyCertificates: full }).instructions.at(-1)).toContain("the listener's quota")
	})
})
