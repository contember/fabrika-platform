// The Elastic Load Balancing client against the fake query endpoint: a listener's rules read page by page with their
// priority, host values and forward target groups; an answer of another form refused; a listener of another form
// refused before anything is sent.

import { describe, expect, test } from 'bun:test'
import { ELB, elbClient } from '../aws/elb'
import { awsError } from './helpers/fake-aws'
import { fakeAwsQuery, FakeRawAnswer } from './helpers/fake-aws-query'

const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika/0123456789abcdef/fedcba9876543210'
const GROUP = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Proxy-1A2B3C4D/0123456789abcdef'
const ruleArn = (id: string) =>
	`arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener-rule/app/fabrika/0123456789abcdef/fedcba9876543210/${id}`

const hostRule = (id: string, priority: string, host: string) =>
	`<member><RuleArn>${ruleArn(id)}</RuleArn><Priority>${priority}</Priority><IsDefault>false</IsDefault>`
	+ `<Conditions><member><Field>host-header</Field><HostHeaderConfig><Values><member>${host}</member></Values></HostHeaderConfig></member></Conditions>`
	+ `<Actions><member><Type>forward</Type><TargetGroupArn>${GROUP}</TargetGroupArn>`
	+ `<ForwardConfig><TargetGroups><member><TargetGroupArn>${GROUP}</TargetGroupArn><Weight>1</Weight></member></TargetGroups></ForwardConfig>`
	+ `</member></Actions></member>`
const defaultRule = `<member><RuleArn>${ruleArn('0000000000000000')}</RuleArn><Priority>default</Priority><IsDefault>true</IsDefault>`
	+ `<Conditions/><Actions><member><Type>fixed-response</Type></member></Actions></member>`

describe('elbClient', () => {
	test("reads every page of a listener's rules: priority, host values and the target groups it forwards to", async () => {
		const { options, calls } = fakeAwsQuery(ELB, {
			DescribeRules: (parameters) =>
				parameters['Marker'] === undefined
					? `<Rules>${defaultRule}${hostRule('1111111111111111', '7', 'notes.example.com')}</Rules><NextMarker>page-2</NextMarker>`
					: `<Rules>${hostRule('2222222222222222', '12', 'crm.example.com')}</Rules>`,
		})
		expect(await elbClient(options).describeRules(LISTENER)).toEqual([
			{ arn: ruleArn('0000000000000000'), priority: 'default', hosts: [], targetGroups: [] },
			{ arn: ruleArn('1111111111111111'), priority: 7, hosts: ['notes.example.com'], targetGroups: [GROUP] },
			{ arn: ruleArn('2222222222222222'), priority: 12, hosts: ['crm.example.com'], targetGroups: [GROUP] },
		])
		expect(calls).toEqual([
			{ action: 'DescribeRules', parameters: { ListenerArn: LISTENER, PageSize: '400' } },
			{ action: 'DescribeRules', parameters: { ListenerArn: LISTENER, PageSize: '400', Marker: 'page-2' } },
		])
	})

	test('a host condition of the older form, without its config, is read too', async () => {
		const older = `<member><RuleArn>${ruleArn('3333333333333333')}</RuleArn><Priority>3</Priority>`
			+ `<Conditions><member><Field>host-header</Field><Values><member>old.example.com</member></Values></member></Conditions><Actions/></member>`
		const { options } = fakeAwsQuery(ELB, { DescribeRules: () => `<Rules>${older}</Rules>` })
		expect(await elbClient(options).describeRules(LISTENER)).toEqual([{
			arn: ruleArn('3333333333333333'),
			priority: 3,
			hosts: ['old.example.com'],
			targetGroups: [],
		}])
	})

	test('two rules of one priority, a priority or rule of another form, or a marker repeated is an invalid answer', async () => {
		for (
			const answer of [
				() => `<Rules>${hostRule('1111111111111111', '7', 'a.example.com')}${hostRule('2222222222222222', '7', 'b.example.com')}</Rules>`,
				() => `<Rules>${hostRule('1111111111111111', '0', 'a.example.com')}</Rules>`,
				() => `<Rules>${hostRule('1111111111111111', '50001', 'a.example.com')}</Rules>`,
				() => `<Rules>${hostRule('1111111111111111', 'seven', 'a.example.com')}</Rules>`,
				() => `<Rules><member><RuleArn>arn:aws:s3:::bucket</RuleArn><Priority>1</Priority></member></Rules>`,
				() => `<Rules>${defaultRule}</Rules><NextMarker>same</NextMarker>`,
			]
		) {
			const { options } = fakeAwsQuery(ELB, {
				DescribeRules: (parameters) => (parameters['Marker'] === 'same' ? `<Rules/><NextMarker>same</NextMarker>` : answer()),
			})
			await expect(elbClient(options).describeRules(LISTENER)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
		const odd = fakeAwsQuery(ELB, { DescribeRules: () => new FakeRawAnswer('not xml') })
		await expect(elbClient(odd.options).describeRules(LISTENER)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('a refusal names its code; a listener of another form is refused before anything is sent', async () => {
		const denied = fakeAwsQuery(ELB, { DescribeRules: () => awsError('ListenerNotFound') })
		await expect(elbClient(denied.options).describeRules(LISTENER)).rejects.toMatchObject({ code: 'ListenerNotFound' })
		const { options, calls } = fakeAwsQuery(ELB, {})
		await expect(elbClient(options).describeRules('arn:aws:s3:::bucket')).rejects.toThrow('the listener')
		expect(calls).toEqual([])
	})
})
