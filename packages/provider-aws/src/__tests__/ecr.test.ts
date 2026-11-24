// The ECR client against the fake endpoint: what each call sends, how an existing repository and a missing image are
// read, that every other failure is an error and never "no image", and that a value of another form is refused before
// anything is sent.

import { describe, expect, test } from 'bun:test'
import { ecrClient } from '../aws/ecr'
import { CODEBUILD, ECR } from '../aws/json'
import { awsError, FAKE_REFUSAL, fakeAws } from './helpers/fake-aws'

const DIGEST = `sha256:${'a'.repeat(64)}`
const repository = {
	repositoryName: 'fabrika/notes-prod',
	repositoryUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod',
	repositoryArn: 'arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/notes-prod',
}
const described = { ...repository, imageTagMutability: 'IMMUTABLE', encryptionConfiguration: { encryptionType: 'AES256' } }
const expected = { name: repository.repositoryName, uri: repository.repositoryUri, arn: repository.repositoryArn }

describe('ecrClient', () => {
	test('creates a repository with immutable tags, AES-256 encryption and its tags, as ECR', async () => {
		const { options, calls } = fakeAws(ECR, { CreateRepository: () => ({ repository }) })
		expect(await ecrClient(options).ensureRepository('fabrika/notes-prod', { 'fabrika:app': 'notes' })).toEqual(expected)
		expect(calls).toEqual([
			{
				operation: 'CreateRepository',
				target: 'AmazonEC2ContainerRegistry_V20150921.CreateRepository',
				body: {
					repositoryName: 'fabrika/notes-prod',
					imageTagMutability: 'IMMUTABLE',
					imageScanningConfiguration: { scanOnPush: false },
					encryptionConfiguration: { encryptionType: 'AES256' },
					tags: [{ Key: 'fabrika:app', Value: 'notes' }],
				},
			},
		])
	})

	test("the fake refuses a request of another service's protocol, so a client wired to it would fail here", async () => {
		const { options } = fakeAws(CODEBUILD, { CreateRepository: () => ({ repository }) })
		await expect(ecrClient(options).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: FAKE_REFUSAL })
	})

	test('answers an existing repository made as this client makes it, by describing it', async () => {
		const { options, calls } = fakeAws(ECR, {
			CreateRepository: () => awsError('RepositoryAlreadyExistsException'),
			DescribeRepositories: () => ({ repositories: [described] }),
		})
		expect(await ecrClient(options).ensureRepository('fabrika/notes-prod', {})).toEqual(expected)
		expect(calls.map((call) => call.operation)).toEqual(['CreateRepository', 'DescribeRepositories'])
		expect(calls[1]?.body).toEqual({ repositoryNames: ['fabrika/notes-prod'] })
	})

	test('refuses an existing repository with mutable tags or another encryption, and one of another name', async () => {
		const existing = (repositories: readonly Record<string, unknown>[]) =>
			fakeAws(ECR, { CreateRepository: () => awsError('RepositoryAlreadyExistsException'), DescribeRepositories: () => ({ repositories }) })
		const mutable = existing([{ ...described, imageTagMutability: 'MUTABLE' }])
		await expect(ecrClient(mutable.options).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'repository_settings' })
		const kms = existing([{ ...described, encryptionConfiguration: { encryptionType: 'KMS' } }])
		await expect(ecrClient(kms.options).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'repository_settings' })
		const other = existing([{ ...described, repositoryName: 'fabrika/other' }])
		await expect(ecrClient(other.options).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'invalid_answer' })
		const denied = fakeAws(ECR, { CreateRepository: () => awsError('AccessDeniedException') })
		await expect(ecrClient(denied.options).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'AccessDeniedException' })
	})

	test('keeps the newest images with one lifecycle rule', async () => {
		const { options, calls } = fakeAws(ECR, { PutLifecyclePolicy: () => ({}) })
		await ecrClient(options).keepNewestImages('fabrika/notes-prod', 20)
		const body = calls[0]?.body
		expect(body).toMatchObject({ repositoryName: 'fabrika/notes-prod' })
		const text = typeof body === 'object' && body !== null && 'lifecyclePolicyText' in body ? body.lifecyclePolicyText : undefined
		expect(JSON.parse(typeof text === 'string' ? text : '{}')).toEqual({
			rules: [
				{
					rulePriority: 1,
					description: 'Keep the newest 20 images',
					selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 20 },
					action: { type: 'expire' },
				},
			],
		})
	})

	test('finds an image by digest or tag, and only ImageNotFoundException is "no image"', async () => {
		const { options, calls } = fakeAws(ECR, {
			DescribeImages: (body) =>
				JSON.stringify(body).includes('missing')
					? awsError('ImageNotFoundException')
					: { imageDetails: [{ imageDigest: DIGEST, imageTags: ['run-1'], imagePushedAt: 1_768_478_400.5 }] },
		})
		const ecr = ecrClient(options)
		expect(await ecr.findImage('fabrika/notes-prod', { digest: DIGEST })).toEqual({
			digest: DIGEST,
			tags: ['run-1'],
			pushedAt: new Date(1_768_478_400_500),
		})
		expect(await ecr.findImage('fabrika/notes-prod', { tag: 'run-1' })).toMatchObject({ digest: DIGEST })
		expect(await ecr.findImage('fabrika/notes-prod', { tag: 'missing' })).toBeNull()
		expect(calls.map((call) => call.body)).toEqual([
			{ repositoryName: 'fabrika/notes-prod', imageIds: [{ imageDigest: DIGEST }] },
			{ repositoryName: 'fabrika/notes-prod', imageIds: [{ imageTag: 'run-1' }] },
			{ repositoryName: 'fabrika/notes-prod', imageIds: [{ imageTag: 'missing' }] },
		])
	})

	test('a missing repository, a refusal and a throttle are errors, never "no image"', async () => {
		const cases: readonly [string, boolean][] = [['RepositoryNotFoundException', false], ['AccessDeniedException', false], [
			'ThrottlingException',
			true,
		]]
		for (const [code, retryable] of cases) {
			const { options } = fakeAws(ECR, { DescribeImages: () => awsError(code) })
			await expect(ecrClient(options).findImage('fabrika/notes-prod', { digest: DIGEST })).rejects.toMatchObject({ code, retryable })
		}
	})

	test('a lookup by digest that answers another digest is an invalid answer', async () => {
		const { options } = fakeAws(ECR, {
			DescribeImages: () => ({ imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}`, imagePushedAt: 1_768_478_400 }] }),
		})
		await expect(ecrClient(options).findImage('fabrika/notes-prod', { digest: DIGEST })).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('refuses a value of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(ECR, {})
		const ecr = ecrClient(options)
		await expect(ecr.ensureRepository('Notes', {})).rejects.toThrow('the repository name')
		await expect(ecr.ensureRepository('fabrika//notes', {})).rejects.toThrow('the repository name')
		// The last value holds U+2028, the line separator.
		const tagSets: readonly Readonly<Record<string, string>>[] = [{ 'aws:reserved': 'x' }, { 'AWS:reserved': 'x' }, { owner: 'line\nbreak' }, {
			owner: 'line separator',
		}]
		for (const tags of tagSets) {
			await expect(ecr.ensureRepository('fabrika/notes', tags)).rejects.toThrow('a tag')
		}
		await expect(ecr.keepNewestImages('fabrika/notes', 0)).rejects.toThrow('the number of images to keep')
		await expect(ecr.findImage('fabrika/notes', { digest: 'sha256:short' })).rejects.toThrow('the image digest')
		await expect(ecr.findImage('fabrika/notes', { tag: '-leading' })).rejects.toThrow('the image tag')
		expect(calls).toEqual([])
	})
})
