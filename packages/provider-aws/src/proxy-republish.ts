// A namespace proxy's republish (the AWS idea's checklist, step 10): the steps of `proxy-attempt.ts` and
// `proxy-service.ts` driven to the namespace's current members, each resumable from what its target records.
//
// One pass reads the target and does the one step it says is next:
// - an image of the current manifest is recorded and nothing newer is in flight: set the service to it
//   (`ensureAwsProxyService`) and follow its rollout (`followAwsProxyRollout`); once the deployment of the revision
//   completed, the secrets it no longer names are deleted and the republish is settled;
// - a build of the current manifest is in flight: follow it (`followAwsProxyBuild`); built, the next pass sets the service;
// - otherwise: start a build of the current manifest (`startAwsProxyBuild`), replacing an attempt of an older one.
//
// `wait: 'started'` returns unsettled once a build of the current manifest is in flight, and Control hands the namespace
// to a reconcile job; `wait: 'active'` follows the build, polling, until the service is set or `AWS_PROXY_WAIT_MS` ran
// out. The namespace's `reconcile` republishes the same way whenever there are members or a recorded image (a reconcile
// is how Control publishes a change it could not while the namespace was busy), and fails retryably
// (`awsProxyPending`) when the wait runs out, so a later reconcile takes it up again.
//
// A rollout the circuit breaker rolled back fails with `awsProxyRollout`, not retryable: the same revision would fail
// again, and a new image or secret (a new fingerprint) is what sets the service anew.
//
// Every pass first requests the certificates of hosts that have none and reads the recorded ones again
// (`ensureAwsProxyCertificates`); nothing waits for one, because validation waits on the operator's DNS.
//
// Then the namespace's hosts stack is brought to the hosts the installation's listener may serve for it
// (`ensureAwsProxyHosts`): one whose certificate is issued and that no other rule routes. That step never fails the
// pass: its failure is recorded and shown, so the proxy's build and rollout below always run.

import {
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	ProviderNamespaceError,
	type ProviderNamespaceEvents,
	type ProviderNamespaceMember,
} from '@fabrika/provider-contract'
import type { CloudFormationClient } from './aws/cloudformation'
import { type ElbClient } from './aws/elb'
import type { AwsCredentialSource } from './aws/transport'
import type { AwsAppTarget } from './codecs'
import type { AwsInstallationNetwork } from './environment-stack'
import {
	type AwsInstallationBalancer,
	type AwsProxySource,
	awsTrustedProxies,
	checkNamespaceTarget,
	namespaceFailure,
	readNamespaceOutputs,
} from './namespace'
import {
	type AwsProxyBuildClients,
	awsProxyBuildCurrent,
	type AwsProxyBuildFollowClients,
	awsProxyImageCurrent,
	awsProxyManifestFile,
	type AwsProxySourceUpload,
	followAwsProxyBuild,
	sha256Hex,
	startAwsProxyBuild,
} from './proxy-attempt'
import { type AwsProxyCertificateClients, ensureAwsProxyCertificates } from './proxy-certificates'
import { ensureAwsProxyHosts } from './proxy-hosts'
import {
	type AwsProxyIam,
	type AwsProxyRolloutClients,
	type AwsProxyServiceClients,
	ensureAwsProxyService,
	followAwsProxyRollout,
} from './proxy-service'

/** How often a proxy build is read while a republish waits for it. */
export const AWS_PROXY_POLL_MS = 10_000
/** How long a republish or a reconcile waits for a proxy build before it answers unsettled: a build's usual length. */
export const AWS_PROXY_WAIT_MS = 15 * 60_000

/** Every call a republish makes. */
export type AwsProxyClients =
	& Omit<AwsProxyBuildClients, 'credentials'>
	& AwsProxyBuildFollowClients
	& AwsProxyServiceClients
	& AwsProxyCertificateClients
	& {
		readonly codeBuild: AwsProxyBuildClients['codeBuild'] & AwsProxyBuildFollowClients['codeBuild']
		readonly ecs: AwsProxyServiceClients['ecs'] & AwsProxyRolloutClients['ecs']
		readonly ssm: AwsProxyBuildClients['ssm'] & AwsProxyServiceClients['ssm'] & AwsProxyRolloutClients['ssm']
		// The hosts stack's calls (`ensureAwsProxyHosts`), and the listener's rules it reads.
		readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
		readonly elb: Pick<ElbClient, 'describeRules'>
	}

/** What a namespace's proxy is republished with: Control's configuration and calls. */
export interface AwsProxyRuntime {
	readonly iam: AwsProxyIam
	readonly clients: AwsProxyClients
	/** The credentials a build's presigned read is signed with, read anew for each republish: they must outlive the URL. */
	readonly credentials: () => AwsCredentialSource
	readonly source: AwsProxySourceUpload
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly now?: () => number
	readonly pollIntervalMs?: number
	readonly waitMs?: number
}

export interface AwsProxyRepublishInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly members: readonly ProviderNamespaceMember[]
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
	readonly wait: 'started' | 'active'
}

export interface AwsProxyRepublishContext {
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	readonly network: AwsInstallationNetwork
	readonly balancer: AwsInstallationBalancer
	readonly runtime: AwsProxyRuntime
}

/** Republishes the namespace's proxy toward its members; settled once the service is set to their manifest's image. */
export async function republishAwsProxy(
	context: AwsProxyRepublishContext,
	input: AwsProxyRepublishInput,
): Promise<{ readonly namespace: ProviderDeploymentNamespace; readonly settled: boolean }> {
	const { installation, proxySource, runtime } = context
	const now = runtime.now ?? Date.now
	const giveUpAt = now() + (input.wait === 'active' ? (runtime.waitMs ?? AWS_PROXY_WAIT_MS) : 0)
	const manifestSha256 = await sha256Hex(awsProxyManifestFile(input.namespace.id, input.members))
	// Behind the balancer, the client is the address it forwards: Caddy trusts the header from the balancer's own subnets
	// alone, never from a range a task runs in (`AwsInstallationBalancer.balancerSubnetCidrs`). Sorted, so the same
	// subnets in another order are the same ranges and rebuild no proxy.
	const trustedProxies = awsTrustedProxies(context.balancer)
	const common = { installation, proxySource, events: input.events, signal: input.signal }
	// The hosts' certificates first: their DNS validation is the operator's, and the longer they have the better. Nothing
	// here waits for one.
	let namespace = await ensureAwsProxyCertificates({ ...common, namespace: input.namespace, members: input.members, clients: runtime.clients })
	// The listener serves the hosts whose certificates are issued and that no other rule routes, and no longer serves those
	// that left. This step records its failure rather than throwing it.
	namespace = await ensureAwsProxyHosts({
		...common,
		namespace,
		members: input.members,
		balancer: context.balancer,
		clients: runtime.clients,
		sleep: runtime.sleep,
		...(runtime.now === undefined ? {} : { now: runtime.now }),
	})
	for (;;) {
		const target = checkNamespaceTarget(namespace, installation, proxySource)
		if (awsProxyImageCurrent(target, manifestSha256, trustedProxies)) {
			const outputs = await readNamespaceOutputs(runtime.clients.cloudFormation, namespace, installation, proxySource, input.signal)
			namespace = await ensureAwsProxyService({
				...common,
				namespace,
				members: input.members,
				network: context.network,
				outputs,
				iam: runtime.iam,
				clients: runtime.clients,
			})
			// Settled only once the service serves the revision; its stale secrets go then, not before.
			const rolled = await followAwsProxyRollout({ ...common, namespace, members: input.members, iam: runtime.iam, clients: runtime.clients })
			namespace = rolled.namespace
			if (rolled.state === 'rolled') return { namespace, settled: true }
			if (now() >= giveUpAt) return { namespace, settled: false }
			await runtime.sleep(runtime.pollIntervalMs ?? AWS_PROXY_POLL_MS, input.signal)
			continue
		}
		if (target.proxyBuildId !== undefined && awsProxyBuildCurrent(target, manifestSha256, trustedProxies)) {
			const followed = await followAwsProxyBuild({ ...common, namespace, clients: runtime.clients })
			namespace = followed.namespace
			if (followed.state === 'built') continue
			if (now() >= giveUpAt) return { namespace, settled: false }
			await runtime.sleep(runtime.pollIntervalMs ?? AWS_PROXY_POLL_MS, input.signal)
			continue
		}
		namespace = await startAwsProxyBuild({
			...common,
			namespace,
			members: input.members,
			trustedProxies,
			clients: { ...runtime.clients, credentials: runtime.credentials() },
			source: runtime.source,
		})
		if (input.wait === 'started') return { namespace, settled: false }
	}
}

/** The code of a reconcile whose proxy work is still in flight when its wait ran out: retryable, a later one carries on. */
export const AWS_PROXY_PENDING = 'awsProxyPending'

/**
 * The namespace capabilities with the proxy's republish: `republish` drives the proxy to the members, and `reconcile`,
 * after the stack, republishes too (waiting as `active` does) and fails retryably when it does not settle in time.
 * Control queues a reconcile to publish a member change it could not publish while the namespace was busy
 * (`NamespaceProxyBusyError`), and a changed IAM key or issuer reaches the proxy only through one, so a reconcile drives
 * the proxy to the current members whenever the namespace has members or a recorded image (so the last member's
 * removal converges too), not only when a build is in flight. On a converged namespace that is the stack read and a
 * fingerprint that matches, with no call. `provision` stays the stack's alone: a proxy is built once there are members.
 */
export function withAwsProxyRepublish(base: ProviderNamespaceCapabilities, context: AwsProxyRepublishContext): ProviderNamespaceCapabilities {
	const run = async (input: AwsProxyRepublishInput) => {
		try {
			return await republishAwsProxy(context, input)
		} catch (error) {
			throw namespaceFailure(error)
		}
	}
	return {
		...base,
		republish: (input) => run({ namespace: input.namespace, members: input.members, events: input.events, signal: input.signal, wait: input.wait }),
		reconcile: async (input) => {
			const namespace = await base.reconcile(input)
			if (input.members.length === 0 && !awsProxyRecorded(namespace, context)) return namespace
			const result = await run({ namespace, members: input.members, events: input.events, signal: input.signal, wait: 'active' })
			if (!result.settled) {
				throw new ProviderNamespaceError("aws: the namespace's proxy build is still running; a later reconcile carries on", AWS_PROXY_PENDING, true)
			}
			return result.namespace
		},
	}
}

/** Whether the namespace's target records any proxy of its own: a build in flight, or an image. */
function awsProxyRecorded(namespace: ProviderDeploymentNamespace, context: Pick<AwsProxyRepublishContext, 'installation' | 'proxySource'>): boolean {
	const target = checkNamespaceTarget(namespace, context.installation, context.proxySource)
	return target.proxyBuildToken !== undefined || target.proxyImageDigest !== undefined
}
