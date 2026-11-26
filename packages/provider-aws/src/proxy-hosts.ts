// A namespace proxy's hosts on the installation's HTTPS listener (the AWS idea's checklist, step 10): on every republish
// and reconcile, after the certificates (`proxy-certificates.ts`), the namespace's hosts stack is brought to the hosts
// the listener may serve for it (`host-rules.ts`).
//
// - A stack of its own (`<namespace stack>-hosts`), apart from the namespace's: a rule refused by the listener (a
//   priority another namespace took in the same moment, a quota) rolls back that stack alone, and nothing of the
//   namespace (its stack, the proxy's build and rollout, deploys into it) waits on it or fails with it. Its failure is
//   recorded (`proxyHostsFailure`) and shown to the operator, and the next republish or reconcile applies it again.
// - The listener's rules are read with the namespace's target group, from its stack's outputs, so a rule is the
//   namespace's own only when it forwards there.
// - The listener's default action is the installation's (a fixed answer). One that forwards to this namespace's target
//   group would serve it every host no rule names: nothing is served then, and the operator is told.
// - With no host to serve and no hosts stack yet, nothing is created.
//
// UNVERIFIED: that a stack of only a `WaitConditionHandle` is accepted and costs nothing follows CloudFormation's
// documentation; it was not checked against an account.

import type { ProviderDeploymentNamespace, ProviderNamespaceEvents, ProviderNamespaceMember } from '@fabrika/provider-contract'
import type { CloudFormationClient } from './aws/cloudformation'
import type { ElbClient } from './aws/elb'
import type { AwsAppTarget, AwsNamespaceTarget, AwsProxyCertificate, AwsProxyHostsFailure } from './codecs'
import { assignHostRulePriorities, awsHostRules, awsHostsStack, listenerConflicts, servedCertificates } from './host-rules'
import {
	type AwsInstallationBalancer,
	awsNamespaceResources,
	awsNamespaceTargetEnvelope,
	type AwsProxySource,
	awsServedHosts,
	checkNamespaceTarget,
	readNamespaceOutputs,
} from './namespace'
import { AwsStackPending, ensureStack } from './stack'

export interface AwsProxyHostsClients {
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	readonly elb: Pick<ElbClient, 'describeRules'>
}

export interface AwsProxyHostsInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly members: readonly ProviderNamespaceMember[]
	readonly installation: AwsAppTarget
	readonly balancer: AwsInstallationBalancer
	readonly proxySource: AwsProxySource
	readonly clients: AwsProxyHostsClients
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly now?: () => number
}

/** Why the hosts stack stopped here: a stop of its own, which ends the step but not the pass. */
class HostsStopped extends Error {
	constructor(readonly failure: AwsProxyHostsFailure) {
		super(failure)
	}
}

/**
 * Brings the namespace's hosts stack to the hosts the listener may serve for it, and answers the namespace as recorded:
 * each served host's priority, each conflict, and the step's failure, if any. It never throws for the listener's or
 * the stack's sake (only for a signal or a target of another form), so the rest of the pass always runs.
 */
export async function ensureAwsProxyHosts(input: AwsProxyHostsInput): Promise<ProviderDeploymentNamespace> {
	const { installation, balancer, clients, signal } = input
	let namespace = input.namespace
	let stored = checkNamespaceTarget(namespace, installation, input.proxySource)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const record = async (target: AwsNamespaceTarget): Promise<void> => {
		if (JSON.stringify(target) === JSON.stringify(stored)) return
		stored = target
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(target) }
		await input.events.checkpoint(namespace)
	}
	const withCertificates = (certificates: readonly AwsProxyCertificate[]): AwsNamespaceTarget => {
		const { proxyCertificates: _previous, ...rest } = stored
		return certificates.length === 0 ? rest : { ...rest, proxyCertificates: certificates }
	}
	const withFailure = (failure: AwsProxyHostsFailure | null): AwsNamespaceTarget => {
		const { proxyHostsFailure: _previous, ...rest } = stored
		return failure === null ? rest : { ...rest, proxyHostsFailure: failure }
	}

	const hosts = awsServedHosts(input.members)
	const certificates = stored.proxyCertificates ?? []
	const candidates = servedCertificates(certificates, hosts).map((certificate) => certificate.host)
	try {
		const existing = await clients.cloudFormation.findStack(resources.hostsStackName, signal)
		if (candidates.length === 0 && existing === null) {
			await record(withFailure(null))
			return namespace
		}
		const outputs = await readNamespaceOutputs(clients.cloudFormation, namespace, installation, input.proxySource, signal)
		const rules = candidates.length === 0 ? [] : await clients.elb.describeRules(balancer.listenerArn, signal)
		if (rules.some((rule) => rule.priority === 'default' && rule.targetGroups.includes(outputs.proxyTargetGroupArn))) {
			throw new HostsStopped('defaultForwards')
		}
		const conflicts = listenerConflicts(candidates, rules, outputs.proxyTargetGroupArn, balancer.installationHosts)
		const served = hosts.filter((host) => !conflicts.has(host))
		const marked = certificates.map((certificate): AwsProxyCertificate => {
			const { listenerConflict: _previous, ...rest } = certificate
			return conflicts.has(certificate.host) ? { ...rest, listenerConflict: true } : rest
		})
		// Recorded before the stack is rendered with them, so a retry renders the same template.
		const assigned = assignHostRulePriorities(marked, served, rules, outputs.proxyTargetGroupArn)
		await record(withCertificates(assigned))
		const stack = awsHostsStack(
			resources.hostsStackName,
			{ 'fabrika:namespace': namespace.id, 'fabrika:env': namespace.env },
			balancer.listenerArn,
			outputs.proxyTargetGroupArn,
			awsHostRules(assigned, served),
		)
		await ensureStack({
			cloudFormation: clients.cloudFormation,
			stack,
			signal,
			sleep: input.sleep,
			...(input.now === undefined ? {} : { now: input.now }),
			log: () => {},
		})
		await record(withFailure(null))
	} catch (error) {
		signal.throwIfAborted()
		const failure: AwsProxyHostsFailure = error instanceof HostsStopped ? error.failure : error instanceof AwsStackPending ? 'pending' : 'failed'
		await record(withFailure(failure))
	}
	return namespace
}
