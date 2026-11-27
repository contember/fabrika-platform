// The Parameter Store client against the fake endpoint: a secret written and deleted, the names under a path listed
// page by page without a value, and that a name or value of another form is refused before anything is sent, without
// quoting it.

import { describe, expect, test } from 'bun:test'
import { SSM } from '../aws/json'
import { MAX_LISTED_PAGES, MAX_SECRET_BYTES, parameterArn, ssmClient, ssmPlatformSecrets } from '../aws/ssm'
import { awsError, fakeAws } from './helpers/fake-aws'

const PATH = '/fabrika/main/apps/notes/prod'
const NAME = `${PATH}/STRIPE_KEY`
const VALUE = 'sk_live_not_to_be_quoted'

describe('ssmClient', () => {
	test('writes a secret as a standard SecureString, replacing an earlier one', async () => {
		const { options, calls } = fakeAws(SSM, { PutParameter: () => ({ Version: 3, Tier: 'Standard' }) })
		expect(await ssmClient(options).putSecret(NAME, VALUE)).toBe(3)
		expect(calls).toEqual([
			{
				operation: 'PutParameter',
				target: 'AmazonSSM.PutParameter',
				body: { Name: NAME, Value: VALUE, Type: 'SecureString', Overwrite: true, Tier: 'Standard', DataType: 'text' },
			},
		])
	})

	test('a refused write names its code, never the value', async () => {
		const { options } = fakeAws(SSM, { PutParameter: () => awsError('ParameterLimitExceeded') })
		const failure = await ssmClient(options).putSecret(NAME, VALUE).catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: 'ParameterLimitExceeded' })
		expect(String(failure)).not.toContain(VALUE)
	})

	test('deletes a secret, and one that is not there answers false', async () => {
		const { options, calls } = fakeAws(SSM, { DeleteParameter: (body) => (JSON.stringify(body).includes('GONE') ? awsError('ParameterNotFound') : {}) })
		const ssm = ssmClient(options)
		expect(await ssm.deleteSecret(NAME)).toBe(true)
		expect(await ssm.deleteSecret(`${PATH}/GONE`)).toBe(false)
		expect(calls.map((call) => call.body)).toEqual([{ Name: NAME }, { Name: `${PATH}/GONE` }])
		const denied = fakeAws(SSM, { DeleteParameter: () => awsError('AccessDeniedException') })
		await expect(ssmClient(denied.options).deleteSecret(NAME)).rejects.toMatchObject({ code: 'AccessDeniedException' })
	})

	test('lists the names one level below a path, page by page, sorted', async () => {
		const { options, calls } = fakeAws(SSM, {
			DescribeParameters: (body) =>
				JSON.stringify(body).includes('NextToken')
					? { Parameters: [{ Name: `${PATH}/A_KEY` }] }
					: { Parameters: [{ Name: `${PATH}/Z_KEY` }, { Name: NAME }], NextToken: 'page-2' },
		})
		expect(await ssmClient(options).listNames(PATH)).toEqual([`${PATH}/A_KEY`, NAME, `${PATH}/Z_KEY`])
		expect(calls.map((call) => call.body)).toEqual([
			{ ParameterFilters: [{ Key: 'Path', Option: 'OneLevel', Values: [PATH] }], MaxResults: 50 },
			{ ParameterFilters: [{ Key: 'Path', Option: 'OneLevel', Values: [PATH] }], MaxResults: 50, NextToken: 'page-2' },
		])
	})

	test('a name outside the path, or more names than the bound, is no answer', async () => {
		const outside = fakeAws(SSM, { DescribeParameters: () => ({ Parameters: [{ Name: '/fabrika/main/apps/other/prod/KEY' }] }) })
		await expect(ssmClient(outside.options).listNames(PATH)).rejects.toMatchObject({ code: 'invalid_answer' })
		let page = 0
		const endless = fakeAws(SSM, {
			DescribeParameters: () => {
				page += 1
				return { Parameters: Array.from({ length: 50 }, (_, index) => ({ Name: `${PATH}/K${page}_${index}` })), NextToken: `page-${page + 1}` }
			},
		})
		await expect(ssmClient(endless.options).listNames(PATH)).rejects.toMatchObject({ code: 'too_many_parameters' })
		expect(endless.calls.length).toBe(21)
	})

	test('a name deeper than one level below the path is no answer', async () => {
		const deeper = fakeAws(SSM, { DescribeParameters: () => ({ Parameters: [{ Name: `${PATH}/nested/KEY` }] }) })
		await expect(ssmClient(deeper.options).listNames(PATH)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('empty pages with a token are read on, up to a bound, and a repeated token is no answer', async () => {
		let page = 0
		const sparse = fakeAws(SSM, {
			DescribeParameters: () => {
				page += 1
				return page < 5 ? { Parameters: [], NextToken: `page-${page + 1}` } : { Parameters: [{ Name: NAME }] }
			},
		})
		expect(await ssmClient(sparse.options).listNames(PATH)).toEqual([NAME])
		expect(sparse.calls.length).toBe(5)

		let empty = 0
		const endless = fakeAws(SSM, {
			DescribeParameters: () => {
				empty += 1
				return { Parameters: [], NextToken: `page-${empty + 1}` }
			},
		})
		await expect(ssmClient(endless.options).listNames(PATH)).rejects.toMatchObject({ code: 'too_many_pages' })
		expect(endless.calls.length).toBe(MAX_LISTED_PAGES)

		const repeated = fakeAws(SSM, { DescribeParameters: () => ({ Parameters: [], NextToken: 'same' }) })
		await expect(ssmClient(repeated.options).listNames(PATH)).rejects.toMatchObject({ code: 'invalid_answer' })
		expect(repeated.calls.length).toBe(2)
	})

	test("builds the ARN a task definition's secret names", () => {
		expect(parameterArn({ partition: 'aws', region: 'eu-central-1', accountId: '123456789012' }, NAME)).toBe(
			`arn:aws:ssm:eu-central-1:123456789012:parameter${NAME}`,
		)
		expect(() => parameterArn({ partition: 'aws', region: 'eu-central-1', accountId: '1234' }, NAME)).toThrow('the account')
	})

	test('refuses a name, path or value of another form before anything is sent, without quoting the value', async () => {
		const { options, calls } = fakeAws(SSM, {})
		const ssm = ssmClient(options)
		const tooDeep = '/a'.repeat(16)
		const tooLong = `/${'x'.repeat(950)}`
		for (const name of ['relative/name', '/trailing/', '/double//slash', '/aws/reserved', '/SSM/reserved', '/space name', tooDeep, tooLong]) {
			await expect(ssm.putSecret(name, VALUE)).rejects.toThrow('the parameter name')
		}
		await expect(ssm.putSecret(NAME, '')).rejects.toThrow('the value')
		const large = ssm.putSecret(NAME, `${VALUE}${'x'.repeat(MAX_SECRET_BYTES)}`).catch((error: unknown) => String(error))
		expect(await large).toContain('the value')
		expect(await large).not.toContain(VALUE)
		await expect(ssm.deleteSecret('/aws/reserved')).rejects.toThrow('the parameter name')
		await expect(ssm.listNames('no-slash')).rejects.toThrow('the path')
		expect(calls).toEqual([])
	})
})

describe("ssmPlatformSecrets, the operator's own", () => {
	const PLATFORM_NAME = '/fabrika/platform/database/admin-password'

	test('writes a secret once: never over one that exists, which answers false', async () => {
		const first = fakeAws(SSM, { PutParameter: () => ({ Version: 1 }) })
		expect(await ssmPlatformSecrets(first.options).putSecretOnce(PLATFORM_NAME, VALUE)).toBe(true)
		expect(first.calls[0]?.body).toEqual({
			Name: PLATFORM_NAME,
			Value: VALUE,
			Type: 'SecureString',
			Overwrite: false,
			Tier: 'Standard',
			DataType: 'text',
		})
		const again = fakeAws(SSM, { PutParameter: () => awsError('ParameterAlreadyExists') })
		expect(await ssmPlatformSecrets(again.options).putSecretOnce(PLATFORM_NAME, VALUE)).toBe(false)
		const refused = fakeAws(SSM, { PutParameter: () => awsError('AccessDeniedException') })
		const failure = await ssmPlatformSecrets(refused.options).putSecretOnce(PLATFORM_NAME, VALUE).catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: 'AccessDeniedException' })
		expect(String(failure)).not.toContain(VALUE)
	})

	test('replaces a secret, and reads one back decrypted, or null when there is none', async () => {
		const put = fakeAws(SSM, { PutParameter: () => ({ Version: 2 }) })
		await ssmPlatformSecrets(put.options).putSecret(PLATFORM_NAME, VALUE)
		expect(put.calls[0]?.body).toMatchObject({ Overwrite: true })
		const read = fakeAws(SSM, { GetParameter: () => ({ Parameter: { Name: PLATFORM_NAME, Value: VALUE, Type: 'SecureString' } }) })
		expect(await ssmPlatformSecrets(read.options).readSecret(PLATFORM_NAME)).toBe(VALUE)
		expect(read.calls[0]?.body).toEqual({ Name: PLATFORM_NAME, WithDecryption: true })
		const none = fakeAws(SSM, { GetParameter: () => awsError('ParameterNotFound') })
		expect(await ssmPlatformSecrets(none.options).readSecret(PLATFORM_NAME)).toBeNull()
		// An answer of another form names no value.
		const odd = fakeAws(SSM, { GetParameter: () => ({ Parameter: { Name: PLATFORM_NAME } }) })
		const failure = await ssmPlatformSecrets(odd.options).readSecret(PLATFORM_NAME).catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: 'invalid_answer' })
	})

	test('a name or value of another form is refused before anything is sent', async () => {
		const { options, calls } = fakeAws(SSM, {})
		const secrets = ssmPlatformSecrets(options)
		await expect(secrets.putSecretOnce('/aws/reserved', VALUE)).rejects.toThrow('the parameter name')
		await expect(secrets.putSecret(PLATFORM_NAME, '')).rejects.toThrow('the value')
		await expect(secrets.readSecret('no-slash')).rejects.toThrow('the parameter name')
		expect(calls).toEqual([])
	})
})
