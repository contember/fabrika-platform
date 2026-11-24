// The ECR client against the fake endpoint: what each call sends, how an existing repository and a missing image are
// read, and that a value of another form is refused before anything is sent.

import { describe, expect, test } from 'bun:test'
import { ecrClient } from '../aws/ecr'
import { ECR } from '../aws/json'
import { awsError, fakeAws } from './helpers/fake-aws'

const DIGEST = `sha256:${'a'.repeat(64)}`
const repository = {
	repositoryName: 'fabrika/notes-prod',
	repositoryUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod',
	repositoryArn: 'arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/notes-prod',
}
const expected = { name: repository.repositoryName, uri: repository.repositoryUri, arn: repository.repositoryArn }

describe('ecrClient', () => {
	test('creates a repository with immutable tags, AES-256 encryption and its tags', async () => {
		const { client, calls } = fakeAws(ECR, { CreateRepository: () => ({ repository }) })
		expect(await ecrClient(client).ensureRepository('fabrika/notes-prod', { 'fabrika:app': 'notes' })).toEqual(expected)
		expect(calls).toEqual([
			{
				operation: 'CreateRepository',
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

	test('answers an existing repository as it is, by describing it', async () => {
		const { client, calls } = fakeAws(ECR, {
			CreateRepository: () => awsError('RepositoryAlreadyExistsException'),
			DescribeRepositories: () => ({ repositories: [repository] }),
		})
		expect(await ecrClient(client).ensureRepository('fabrika/notes-prod', {})).toEqual(expected)
		expect(calls.map((call) => call.operation)).toEqual(['CreateRepository', 'DescribeRepositories'])
		expect(calls[1]?.body).toEqual({ repositoryNames: ['fabrika/notes-prod'] })
	})

	test('any other failure of the create is the caller’s, and a describe of another repository is no answer', async () => {
		const denied = fakeAws(ECR, { CreateRepository: () => awsError('AccessDeniedException') })
		await expect(ecrClient(denied.client).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'AccessDeniedException' })
		const other = fakeAws(ECR, {
			CreateRepository: () => awsError('RepositoryAlreadyExistsException'),
			DescribeRepositories: () => ({ repositories: [{ ...repository, repositoryName: 'fabrika/other' }] }),
		})
		await expect(ecrClient(other.client).ensureRepository('fabrika/notes-prod', {})).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('keeps the newest images with one lifecycle rule', async () => {
		const { client, calls } = fakeAws(ECR, { PutLifecyclePolicy: () => ({}) })
		await ecrClient(client).keepNewestImages('fabrika/notes-prod', 20)
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

	test('finds an image by digest or tag, and a missing one is null', async () => {
		const { client, calls } = fakeAws(ECR, {
			DescribeImages: (body) =>
				JSON.stringify(body).includes('missing')
					? awsError('ImageNotFoundException')
					: { imageDetails: [{ imageDigest: DIGEST, imageTags: ['run-1'], imagePushedAt: 1_768_478_400.5 }] },
		})
		const ecr = ecrClient(client)
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

	test('refuses a value of another form before anything is sent', async () => {
		const { client, calls } = fakeAws(ECR, {})
		const ecr = ecrClient(client)
		await expect(ecr.ensureRepository('Notes', {})).rejects.toThrow('the repository name')
		await expect(ecr.ensureRepository('fabrika//notes', {})).rejects.toThrow('the repository name')
		await expect(ecr.ensureRepository('fabrika/notes', { 'aws:reserved': 'x' })).rejects.toThrow('a tag')
		await expect(ecr.ensureRepository('fabrika/notes', { owner: 'line\nbreak' })).rejects.toThrow('a tag')
		await expect(ecr.keepNewestImages('fabrika/notes', 0)).rejects.toThrow('the number of images to keep')
		await expect(ecr.findImage('fabrika/notes', { digest: 'sha256:short' })).rejects.toThrow('the image digest')
		await expect(ecr.findImage('fabrika/notes', { tag: '-leading' })).rejects.toThrow('the image tag')
		expect(calls).toEqual([])
	})
})
