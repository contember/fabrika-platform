// The ECR calls the AWS provider makes (ADR-0081): a repository per application environment, created on first use and
// kept by name; a lifecycle policy that expires old images; and the lookup of an image the build pushed, by digest or
// tag. The task definition names an image by digest, never by tag, so a lookup answers the digest.
//
// UNVERIFIED: the operations' input and answer fields follow ECR's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, ECR } from './json'

/** A repository's name: lowercase segments separated by `/`, each joined by `.`, `_` or `-`, at most 256. */
const REPOSITORY_NAME = /^(?=.{2,256}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/
/** An image digest as ECR records it. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/
/** An image tag. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
/**
 * A resource tag's key and value: letters, digits, spaces and `_.:/=+-@`. Narrower than AWS's own pattern, which also
 * takes the line and paragraph separators (U+2028, U+2029); a tag here never holds a line break.
 */
const TAG_KEY = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{1,128}$/u
const TAG_VALUE = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{0,256}$/u
/** The most images a lifecycle policy keeps. */
export const MAX_KEPT_IMAGES = 1000

/** A repository: its name, the URI an image reference starts with, and its ARN. */
export interface EcrRepository {
	readonly name: string
	readonly uri: string
	readonly arn: string
}

/** An image in a repository: its digest, its tags, and when it was pushed. */
export interface EcrImage {
	readonly digest: string
	readonly tags: readonly string[]
	readonly pushedAt: Date
}

/** Which image a lookup names. */
export type EcrImageReference = { readonly digest: string } | { readonly tag: string }

export interface EcrClient {
	/**
	 * The repository `name`, created with `tags` when it does not exist. An existing one is answered only when it is what
	 * this client creates (immutable tags, AES-256 encryption); one made otherwise is refused as `repository_settings`.
	 */
	ensureRepository(name: string, tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<EcrRepository>
	/**
	 * Keeps the newest `keep` images of `name` and expires the rest, replacing any earlier policy. It counts pushes, not
	 * deployments: `keep` builds pushed after the image a service runs (failed or cancelled deploys) expire that image, and
	 * ECS can then neither replace a task nor roll back to it. The deploy step sizes `keep` against that, or keeps the
	 * deployed digest apart (B8).
	 */
	keepNewestImages(name: string, keep: number, signal?: AbortSignal): Promise<void>
	/**
	 * The image `reference` names in `name`, or `null` when the repository holds no such image. A missing repository, a
	 * refusal or a throttle is an error, never `null`: a caller reads `null` as "build it", and the deploy ensures the
	 * repository first.
	 */
	findImage(name: string, reference: EcrImageReference, signal?: AbortSignal): Promise<EcrImage | null>
}

const repositorySchema = z.object({ repositoryName: z.string(), repositoryUri: z.string(), repositoryArn: z.string() })
const createdSchema = z.object({ repository: repositorySchema })
const describedSchema = z.object({
	repositories: z.array(
		repositorySchema.extend({
			imageTagMutability: z.string().optional(),
			encryptionConfiguration: z.object({ encryptionType: z.string() }).optional(),
		}),
	),
})
const imagesSchema = z.object({
	imageDetails: z.array(
		z.object({ imageDigest: z.string().regex(IMAGE_DIGEST), imageTags: z.array(z.string()).optional(), imagePushedAt: z.number() }),
	),
})
const policySchema = z.object({})

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`ECR: ${what} is not one ECR takes`)
}

function repositoryName(name: string): string {
	return REPOSITORY_NAME.test(name) ? name : refuse('the repository name')
}

function repositoryOf(raw: z.infer<typeof repositorySchema>): EcrRepository {
	return { name: raw.repositoryName, uri: raw.repositoryUri, arn: raw.repositoryArn }
}

/** ECR at `options.origin`; the client is of the `ECR` service by construction, so it cannot call another one. */
/**
 * The lifecycle policy text that keeps a repository's newest `keep` images, counting pushes: what `keepNewestImages`
 * sends and the environment stack declares, so the two never disagree.
 */
export function ecrLifecyclePolicy(keep: number): string {
	if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEPT_IMAGES) refuse('the number of images to keep')
	return JSON.stringify({
		rules: [
			{
				rulePriority: 1,
				description: `Keep the newest ${keep} images`,
				selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: keep },
				action: { type: 'expire' },
			},
		],
	})
}

export function ecrClient(options: AwsJsonClientOptions): EcrClient {
	const json = awsJsonClient(ECR, options)
	return {
		async ensureRepository(name, tags, signal) {
			const repository = repositoryName(name)
			const tagList = Object.entries(tags).map(([key, value]) => {
				// AWS reserves the `aws:` prefix in any letter case.
				if (!TAG_KEY.test(key) || !TAG_VALUE.test(value) || key.toLowerCase().startsWith('aws:')) refuse('a tag')
				return { Key: key, Value: value }
			})
			try {
				const created = await json.call(
					'CreateRepository',
					{
						repositoryName: repository,
						imageTagMutability: 'IMMUTABLE',
						imageScanningConfiguration: { scanOnPush: false },
						encryptionConfiguration: { encryptionType: 'AES256' },
						tags: tagList,
					},
					createdSchema,
					signal,
				)
				return repositoryOf(created.repository)
			} catch (error) {
				if (!(error instanceof AwsError) || error.code !== 'RepositoryAlreadyExistsException') throw error
			}
			const described = await json.call('DescribeRepositories', { repositoryNames: [repository] }, describedSchema, signal)
			const [found] = described.repositories
			if (found === undefined || found.repositoryName !== repository) throw new AwsError('DescribeRepositories', 'invalid_answer', 200, null, false)
			// A repository made by hand or by an earlier release is adopted only with the settings this client creates.
			if (found.imageTagMutability !== 'IMMUTABLE' || found.encryptionConfiguration?.encryptionType !== 'AES256') {
				throw new AwsError('DescribeRepositories', 'repository_settings', 200, null, false)
			}
			return repositoryOf(found)
		},

		async keepNewestImages(name, keep, signal) {
			const repository = repositoryName(name)
			await json.call('PutLifecyclePolicy', { repositoryName: repository, lifecyclePolicyText: ecrLifecyclePolicy(keep) }, policySchema, signal)
		},

		async findImage(name, reference, signal) {
			const repository = repositoryName(name)
			const imageId = 'digest' in reference
				? IMAGE_DIGEST.test(reference.digest) ? { imageDigest: reference.digest } : refuse('the image digest')
				: IMAGE_TAG.test(reference.tag)
				? { imageTag: reference.tag }
				: refuse('the image tag')
			let answer: z.infer<typeof imagesSchema>
			try {
				answer = await json.call('DescribeImages', { repositoryName: repository, imageIds: [imageId] }, imagesSchema, signal)
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ImageNotFoundException') return null
				throw error
			}
			const [image] = answer.imageDetails
			if (image === undefined) return null
			if ('digest' in reference && image.imageDigest !== reference.digest) throw new AwsError('DescribeImages', 'invalid_answer', 200, null, false)
			// ECR's JSON protocol writes a timestamp as seconds since the epoch, fractions included.
			return { digest: image.imageDigest, tags: image.imageTags ?? [], pushedAt: new Date(image.imagePushedAt * 1000) }
		},
	}
}
