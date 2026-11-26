// The Elastic Load Balancing (v2) call the AWS provider makes itself, over the query protocol (`query.ts`): read the
// rules of the installation's HTTPS listener, so a namespace's host rule takes a priority no other rule holds. Its rules
// and certificates are written by the namespace's stack (CloudFormation), never here.
//
// - A rule is read for what tells it apart: its priority (`default` for the listener's own), its host-header values and
//   the target groups it forwards to. Any other condition or action is kept out of those lists, never guessed at.
// - Pages are read to the end, at most `MAX_PAGES`; a marker repeated is an invalid answer, as it would read forever.
//
// UNVERIFIED: the action, its parameters, the answer's element names (`HostHeaderConfig`, `ForwardConfig`) and the page
// size follow Elastic Load Balancing's API reference; none was checked against an account.

import { awsQueryClient, type AwsQueryService } from './query'
import { type AwsClientOptions, AwsError } from './transport'
import { xmlChildren, type XmlElement, xmlOptional, xmlText } from './xml'

export const ELB: AwsQueryService = { service: 'elasticloadbalancing', version: '2015-12-01' }

/** A listener's ARN: `listener/app/<balancer>/<id>/<id>`. */
export const LISTENER_ARN =
	/^arn:aws(?:-[a-z]{1,10}){0,2}:elasticloadbalancing:[a-z0-9-]{1,32}:\d{12}:listener\/app\/[A-Za-z0-9-]{1,32}\/[0-9a-f]{16}\/[0-9a-f]{16}$/
/** The most rules a listener holds (its quota is 100 by default, adjustable); a page holds up to 400. */
const PAGE_SIZE = 400
const MAX_PAGES = 20
/** The highest priority a rule takes. */
export const MAX_RULE_PRIORITY = 50_000

/** One rule of a listener, as far as the provider tells rules apart. */
export interface ListenerRule {
	readonly arn: string
	/** `default` for the listener's own rule, which every listener has and no priority names. */
	readonly priority: number | 'default'
	/** The values of its host-header conditions. */
	readonly hosts: readonly string[]
	/** The target groups its forward actions name. */
	readonly targetGroups: readonly string[]
}

export interface ElbClient {
	/** Every rule of the listener `listenerArn`. */
	describeRules(listenerArn: string, signal?: AbortSignal): Promise<readonly ListenerRule[]>
}

const RULE_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:elasticloadbalancing:[a-z0-9-]{1,32}:\d{12}:listener-rule\/app\/[A-Za-z0-9-/]{1,128}$/
const PRIORITY = /^[1-9]\d{0,4}$/

/** The `member` texts of `parent`'s list `name`, or none when it has no such list. */
function members(parent: XmlElement, name: string): readonly XmlElement[] {
	const list = xmlOptional(parent, name)
	return list === null ? [] : xmlChildren(list, 'member')
}

function ruleOf(member: XmlElement): ListenerRule {
	const arn = xmlText(member, 'RuleArn') ?? ''
	const raw = xmlText(member, 'Priority') ?? ''
	if (!RULE_ARN.test(arn)) throw new Error('a rule of another form')
	const priority = raw === 'default' ? 'default' : PRIORITY.test(raw) && Number(raw) <= MAX_RULE_PRIORITY ? Number(raw) : null
	if (priority === null) throw new Error('a priority of another form')
	const hosts: string[] = []
	for (const condition of members(member, 'Conditions')) {
		if (xmlText(condition, 'Field') !== 'host-header') continue
		const config = xmlOptional(condition, 'HostHeaderConfig')
		// The older form lists the values on the condition itself.
		const values = config === null ? members(condition, 'Values') : members(config, 'Values')
		for (const value of values) hosts.push(value.text)
	}
	const targetGroups: string[] = []
	for (const action of members(member, 'Actions')) {
		if (xmlText(action, 'Type') !== 'forward') continue
		const direct = xmlText(action, 'TargetGroupArn')
		if (direct !== null) targetGroups.push(direct)
		const forward = xmlOptional(action, 'ForwardConfig')
		if (forward !== null) {
			for (const group of members(forward, 'TargetGroups')) {
				const arn = xmlText(group, 'TargetGroupArn')
				if (arn !== null) targetGroups.push(arn)
			}
		}
	}
	return { arn, priority, hosts, targetGroups: [...new Set(targetGroups)] }
}

/** Elastic Load Balancing at `options.origin`; the client is of the `ELB` service by construction. */
export function elbClient(options: AwsClientOptions): ElbClient {
	const query = awsQueryClient(ELB, options)
	return {
		async describeRules(listenerArn, signal) {
			if (!LISTENER_ARN.test(listenerArn)) throw new Error('Elastic Load Balancing: the listener is not one it takes')
			const rules: ListenerRule[] = []
			let marker: string | null = null
			for (let page = 0; page < MAX_PAGES; page += 1) {
				const answer: { readonly rules: readonly ListenerRule[]; readonly next: string | null } = await query.call(
					'DescribeRules',
					{ ListenerArn: listenerArn, PageSize: String(PAGE_SIZE), ...(marker === null ? {} : { Marker: marker }) },
					(result) => {
						if (result === null) return { rules: [], next: null }
						return { rules: members(result, 'Rules').map(ruleOf), next: xmlText(result, 'NextMarker') }
					},
					signal,
				)
				rules.push(...answer.rules)
				if (answer.next === null || answer.next === '') {
					const priorities = rules.map((rule) => rule.priority)
					// Two rules of one priority, or two default ones, is an answer this client cannot read.
					if (new Set(priorities).size !== priorities.length) throw new AwsError('DescribeRules', 'invalid_answer', 200, null, false)
					return rules
				}
				if (answer.next === marker) throw new AwsError('DescribeRules', 'invalid_answer', 200, null, false)
				marker = answer.next
			}
			throw new AwsError('DescribeRules', 'too_many_pages', 200, null, false)
		},
	}
}
