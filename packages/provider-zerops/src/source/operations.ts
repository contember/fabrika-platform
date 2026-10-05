import { z } from 'zod'
import { ZEROPS_SOURCE_PROTOCOL_VERSION, ZEROPS_SOURCE_PROTOCOL_VERSION_V2 } from './constants'
import {
	ZEROPS_SOURCE_ERROR_CODES,
	ZEROPS_SOURCE_ERROR_STAGES,
	type ZeropsSourceCancelInput,
	type ZeropsSourceCancelRequestV1,
	type ZeropsSourceCancelResponseV1,
	type ZeropsSourceCancelResult,
	type ZeropsSourceErrorCode,
	type ZeropsSourceErrorEnvelope,
	type ZeropsSourceErrorStage,
	type ZeropsSourceResolveInput,
	type ZeropsSourceResolveInputV2,
	type ZeropsSourceResolveRequestV1,
	type ZeropsSourceResolveRequestV2,
	type ZeropsSourceResolveResponseV1,
	type ZeropsSourceResolveResponseV2,
	type ZeropsSourceResolveResult,
	type ZeropsSourceUploadInput,
	type ZeropsSourceUploadInputV2,
	type ZeropsSourceUploadRequestV1,
	type ZeropsSourceUploadRequestV2,
	type ZeropsSourceUploadResponseV1,
	type ZeropsSourceUploadResponseV2,
	type ZeropsSourceUploadResult,
} from './types'
import {
	commitShaSchema,
	descriptorSchema,
	identifierSchema,
	installationIdSchema,
	parseSourceWire,
	privateBindingV2Schema,
	refSchema,
	rejectExplicitUndefined,
	repositorySchema,
	sha256Schema,
	uploadUrlSchema,
} from './validation'

const resolveRequestSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION),
	runId: identifierSchema,
	repository: repositorySchema,
	requestedRef: refSchema,
	expectedCommitSha: commitShaSchema.optional(),
	githubInstallationId: installationIdSchema.optional(),
	descriptorSha256: sha256Schema,
}).strict()

const resolveRequestV2Schema = resolveRequestSchema.omit({ githubInstallationId: true }).extend({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION_V2),
	privateBinding: privateBindingV2Schema.optional(),
}).superRefine(rejectExplicitUndefined)
const resolveRequestV1Schema = resolveRequestSchema.superRefine(rejectExplicitUndefined)

const resolveResponseSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION),
	runId: identifierSchema,
	commitSha: commitShaSchema,
	descriptorSha256: sha256Schema,
}).strict()
const resolveResponseV2Schema = resolveResponseSchema.extend({ protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION_V2) })

const uploadRequestSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION),
	runId: identifierSchema,
	appVersionId: identifierSchema,
	archiveKind: z.literal('platform').optional(),
	repository: repositorySchema,
	commitSha: commitShaSchema,
	githubInstallationId: installationIdSchema.optional(),
	uploadUrl: uploadUrlSchema,
	descriptor: descriptorSchema,
}).strict()
const uploadRequestV1Schema = uploadRequestSchema.superRefine(rejectExplicitUndefined).refine(
	(value) => value.archiveKind === undefined || value.githubInstallationId === undefined,
	'platform archives require anonymous source access',
)
const uploadRequestV2Schema = uploadRequestSchema.omit({ archiveKind: true, githubInstallationId: true }).extend({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION_V2),
	privateBinding: privateBindingV2Schema.optional(),
}).superRefine(rejectExplicitUndefined)

const uploadResponseSchema = resolveResponseSchema.extend({ appVersionId: identifierSchema })
const uploadResponseV2Schema = uploadResponseSchema.extend({ protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION_V2) })
const cancelSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION),
	runId: identifierSchema,
	appVersionId: identifierSchema,
}).strict()
const errorEnvelopeSchema = z.object({
	error: z.object({
		code: z.enum(ZEROPS_SOURCE_ERROR_CODES),
		stage: z.enum(ZEROPS_SOURCE_ERROR_STAGES),
		retryable: z.boolean(),
	}).strict(),
}).strict()

export function decodeZeropsSourceResolveRequest(value: unknown): ZeropsSourceResolveRequestV1 {
	return parseSourceWire(resolveRequestV1Schema, value, 'source resolve request')
}

export function buildZeropsSourceResolveRequest(input: ZeropsSourceResolveInput): ZeropsSourceResolveRequestV1 {
	return decodeZeropsSourceResolveRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		repository: input.repository,
		requestedRef: input.requestedRef,
		...(input.expectedCommitSha !== undefined ? { expectedCommitSha: input.expectedCommitSha } : {}),
		...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
		descriptorSha256: input.descriptorSha256,
	})
}

export function decodeZeropsSourceResolveResponse(value: unknown): ZeropsSourceResolveResponseV1 {
	return parseSourceWire(resolveResponseSchema, value, 'source resolve response')
}

export function buildZeropsSourceResolveResponse(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV1 {
	return decodeZeropsSourceResolveResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceUploadRequest(value: unknown): ZeropsSourceUploadRequestV1 {
	return parseSourceWire(uploadRequestV1Schema, value, 'source upload request')
}

export function buildZeropsSourceUploadRequest(input: ZeropsSourceUploadInput): ZeropsSourceUploadRequestV1 {
	return decodeZeropsSourceUploadRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		appVersionId: input.appVersionId,
		...(input.archiveKind !== undefined ? { archiveKind: input.archiveKind } : {}),
		repository: input.repository,
		commitSha: input.commitSha,
		...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
		uploadUrl: input.uploadUrl,
		descriptor: input.descriptor,
	})
}

export function decodeZeropsSourceUploadResponse(value: unknown): ZeropsSourceUploadResponseV1 {
	return parseSourceWire(uploadResponseSchema, value, 'source upload response')
}

export function buildZeropsSourceUploadResponse(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV1 {
	return decodeZeropsSourceUploadResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceResolveRequestV2(value: unknown): ZeropsSourceResolveRequestV2 {
	return parseSourceWire(resolveRequestV2Schema, value, 'source resolve request v2')
}

export function buildZeropsSourceResolveRequestV2(input: ZeropsSourceResolveInputV2): ZeropsSourceResolveRequestV2 {
	return decodeZeropsSourceResolveRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		runId: input.runId,
		repository: input.repository,
		requestedRef: input.requestedRef,
		...(input.expectedCommitSha !== undefined ? { expectedCommitSha: input.expectedCommitSha } : {}),
		...(input.privateBinding !== undefined ? { privateBinding: input.privateBinding } : {}),
		descriptorSha256: input.descriptorSha256,
	})
}

export function decodeZeropsSourceResolveResponseV2(value: unknown): ZeropsSourceResolveResponseV2 {
	return parseSourceWire(resolveResponseV2Schema, value, 'source resolve response v2')
}

export function buildZeropsSourceResolveResponseV2(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV2 {
	return decodeZeropsSourceResolveResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
}

export function decodeZeropsSourceUploadRequestV2(value: unknown): ZeropsSourceUploadRequestV2 {
	return parseSourceWire(uploadRequestV2Schema, value, 'source upload request v2')
}

export function buildZeropsSourceUploadRequestV2(input: ZeropsSourceUploadInputV2): ZeropsSourceUploadRequestV2 {
	return decodeZeropsSourceUploadRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		runId: input.runId,
		appVersionId: input.appVersionId,
		repository: input.repository,
		commitSha: input.commitSha,
		...(input.privateBinding !== undefined ? { privateBinding: input.privateBinding } : {}),
		uploadUrl: input.uploadUrl,
		descriptor: input.descriptor,
	})
}

export function decodeZeropsSourceUploadResponseV2(value: unknown): ZeropsSourceUploadResponseV2 {
	return parseSourceWire(uploadResponseV2Schema, value, 'source upload response v2')
}

export function buildZeropsSourceUploadResponseV2(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV2 {
	return decodeZeropsSourceUploadResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
}

export function decodeZeropsSourceCancelRequest(value: unknown): ZeropsSourceCancelRequestV1 {
	return parseSourceWire(cancelSchema, value, 'source cancel request')
}

export function buildZeropsSourceCancelRequest(input: ZeropsSourceCancelInput): ZeropsSourceCancelRequestV1 {
	return decodeZeropsSourceCancelRequest({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, runId: input.runId, appVersionId: input.appVersionId })
}

export function decodeZeropsSourceCancelResponse(value: unknown): ZeropsSourceCancelResponseV1 {
	return parseSourceWire(cancelSchema, value, 'source cancel response')
}

export function buildZeropsSourceCancelResponse(result: ZeropsSourceCancelResult): ZeropsSourceCancelResponseV1 {
	return decodeZeropsSourceCancelResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceErrorEnvelope(value: unknown): ZeropsSourceErrorEnvelope {
	return parseSourceWire(errorEnvelopeSchema, value, 'source error response')
}

export function buildZeropsSourceErrorEnvelope(
	code: ZeropsSourceErrorCode,
	stage: ZeropsSourceErrorStage,
	retryable: boolean,
): ZeropsSourceErrorEnvelope {
	return decodeZeropsSourceErrorEnvelope({ error: { code, stage, retryable } })
}
