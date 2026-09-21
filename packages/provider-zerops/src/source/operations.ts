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
	commitSha,
	descriptor,
	exactKeys,
	identifier,
	optionalCommitSha,
	optionalFields,
	optionalInstallationId,
	optionalPrivateBindingV2,
	protocolVersion,
	protocolVersionV2,
	record,
	ref,
	repository,
	sha256,
	uploadUrl,
} from './validation'

export function decodeZeropsSourceResolveRequest(value: unknown): ZeropsSourceResolveRequestV1 {
	const parsed = record(value, 'source resolve request')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'repository', 'requestedRef', 'descriptorSha256'],
		['expectedCommitSha', 'githubInstallationId'],
		'source resolve request',
	)
	const expected = optionalCommitSha(parsed['expectedCommitSha'], 'source resolve request.expectedCommitSha')
	const installation = optionalInstallationId(parsed['githubInstallationId'], 'source resolve request.githubInstallationId')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve request'),
		runId: identifier(parsed['runId'], 'source resolve request.runId'),
		repository: repository(parsed['repository'], 'source resolve request.repository'),
		requestedRef: ref(parsed['requestedRef'], 'source resolve request.requestedRef'),
		...(expected !== undefined ? { expectedCommitSha: expected } : {}),
		...(installation !== undefined ? { githubInstallationId: installation } : {}),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve request.descriptorSha256'),
	}
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
	const parsed = record(value, 'source resolve response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'commitSha', 'descriptorSha256'], 'source resolve response')
	return {
		protocolVersion: protocolVersion(parsed, 'source resolve response'),
		runId: identifier(parsed['runId'], 'source resolve response.runId'),
		commitSha: commitSha(parsed['commitSha'], 'source resolve response.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve response.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveResponse(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV1 {
	return decodeZeropsSourceResolveResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceUploadRequest(value: unknown): ZeropsSourceUploadRequestV1 {
	const parsed = record(value, 'source upload request')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'appVersionId', 'repository', 'commitSha', 'uploadUrl', 'descriptor'],
		['githubInstallationId'],
		'source upload request',
	)
	const installation = optionalInstallationId(parsed['githubInstallationId'], 'source upload request.githubInstallationId')
	return {
		protocolVersion: protocolVersion(parsed, 'source upload request'),
		runId: identifier(parsed['runId'], 'source upload request.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload request.appVersionId'),
		repository: repository(parsed['repository'], 'source upload request.repository'),
		commitSha: commitSha(parsed['commitSha'], 'source upload request.commitSha'),
		...(installation !== undefined ? { githubInstallationId: installation } : {}),
		uploadUrl: uploadUrl(parsed['uploadUrl'], 'source upload request.uploadUrl'),
		descriptor: descriptor(parsed['descriptor'], 'source upload request.descriptor'),
	}
}

export function buildZeropsSourceUploadRequest(input: ZeropsSourceUploadInput): ZeropsSourceUploadRequestV1 {
	return decodeZeropsSourceUploadRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		appVersionId: input.appVersionId,
		repository: input.repository,
		commitSha: input.commitSha,
		...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
		uploadUrl: input.uploadUrl,
		descriptor: input.descriptor,
	})
}

export function decodeZeropsSourceUploadResponse(value: unknown): ZeropsSourceUploadResponseV1 {
	const parsed = record(value, 'source upload response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId', 'commitSha', 'descriptorSha256'], 'source upload response')
	return {
		protocolVersion: protocolVersion(parsed, 'source upload response'),
		runId: identifier(parsed['runId'], 'source upload response.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload response.appVersionId'),
		commitSha: commitSha(parsed['commitSha'], 'source upload response.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source upload response.descriptorSha256'),
	}
}

export function buildZeropsSourceUploadResponse(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV1 {
	return decodeZeropsSourceUploadResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

export function decodeZeropsSourceResolveRequestV2(value: unknown): ZeropsSourceResolveRequestV2 {
	const parsed = record(value, 'source resolve request v2')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'repository', 'requestedRef', 'descriptorSha256'],
		['expectedCommitSha', 'privateBinding'],
		'source resolve request v2',
	)
	const expected = optionalCommitSha(parsed['expectedCommitSha'], 'source resolve request v2.expectedCommitSha')
	const binding = optionalPrivateBindingV2(parsed['privateBinding'], 'source resolve request v2.privateBinding')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source resolve request v2'),
		runId: identifier(parsed['runId'], 'source resolve request v2.runId'),
		repository: repository(parsed['repository'], 'source resolve request v2.repository'),
		requestedRef: ref(parsed['requestedRef'], 'source resolve request v2.requestedRef'),
		...(expected !== undefined ? { expectedCommitSha: expected } : {}),
		...(binding !== undefined ? { privateBinding: binding } : {}),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve request v2.descriptorSha256'),
	}
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
	const parsed = record(value, 'source resolve response v2')
	exactKeys(parsed, ['protocolVersion', 'runId', 'commitSha', 'descriptorSha256'], 'source resolve response v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source resolve response v2'),
		runId: identifier(parsed['runId'], 'source resolve response v2.runId'),
		commitSha: commitSha(parsed['commitSha'], 'source resolve response v2.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source resolve response v2.descriptorSha256'),
	}
}

export function buildZeropsSourceResolveResponseV2(result: ZeropsSourceResolveResult): ZeropsSourceResolveResponseV2 {
	return decodeZeropsSourceResolveResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
}

export function decodeZeropsSourceUploadRequestV2(value: unknown): ZeropsSourceUploadRequestV2 {
	const parsed = record(value, 'source upload request v2')
	optionalFields(
		parsed,
		['protocolVersion', 'runId', 'appVersionId', 'repository', 'commitSha', 'uploadUrl', 'descriptor'],
		['privateBinding'],
		'source upload request v2',
	)
	const binding = optionalPrivateBindingV2(parsed['privateBinding'], 'source upload request v2.privateBinding')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source upload request v2'),
		runId: identifier(parsed['runId'], 'source upload request v2.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload request v2.appVersionId'),
		repository: repository(parsed['repository'], 'source upload request v2.repository'),
		commitSha: commitSha(parsed['commitSha'], 'source upload request v2.commitSha'),
		...(binding !== undefined ? { privateBinding: binding } : {}),
		uploadUrl: uploadUrl(parsed['uploadUrl'], 'source upload request v2.uploadUrl'),
		descriptor: descriptor(parsed['descriptor'], 'source upload request v2.descriptor'),
	}
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
	const parsed = record(value, 'source upload response v2')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId', 'commitSha', 'descriptorSha256'], 'source upload response v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source upload response v2'),
		runId: identifier(parsed['runId'], 'source upload response v2.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source upload response v2.appVersionId'),
		commitSha: commitSha(parsed['commitSha'], 'source upload response v2.commitSha'),
		descriptorSha256: sha256(parsed['descriptorSha256'], 'source upload response v2.descriptorSha256'),
	}
}

export function buildZeropsSourceUploadResponseV2(result: ZeropsSourceUploadResult): ZeropsSourceUploadResponseV2 {
	return decodeZeropsSourceUploadResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...result })
}

export function decodeZeropsSourceCancelRequest(value: unknown): ZeropsSourceCancelRequestV1 {
	const parsed = record(value, 'source cancel request')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId'], 'source cancel request')
	return {
		protocolVersion: protocolVersion(parsed, 'source cancel request'),
		runId: identifier(parsed['runId'], 'source cancel request.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source cancel request.appVersionId'),
	}
}

export function buildZeropsSourceCancelRequest(input: ZeropsSourceCancelInput): ZeropsSourceCancelRequestV1 {
	return decodeZeropsSourceCancelRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: input.runId,
		appVersionId: input.appVersionId,
	})
}

export function decodeZeropsSourceCancelResponse(value: unknown): ZeropsSourceCancelResponseV1 {
	const parsed = record(value, 'source cancel response')
	exactKeys(parsed, ['protocolVersion', 'runId', 'appVersionId'], 'source cancel response')
	return {
		protocolVersion: protocolVersion(parsed, 'source cancel response'),
		runId: identifier(parsed['runId'], 'source cancel response.runId'),
		appVersionId: identifier(parsed['appVersionId'], 'source cancel response.appVersionId'),
	}
}

export function buildZeropsSourceCancelResponse(result: ZeropsSourceCancelResult): ZeropsSourceCancelResponseV1 {
	return decodeZeropsSourceCancelResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...result })
}

const includesString = <T extends string>(values: readonly T[], value: unknown): value is T =>
	typeof value === 'string' && values.some((entry) => entry === value)

export function decodeZeropsSourceErrorEnvelope(value: unknown): ZeropsSourceErrorEnvelope {
	const parsed = record(value, 'source error response')
	exactKeys(parsed, ['error'], 'source error response')
	const error = record(parsed['error'], 'source error response.error')
	exactKeys(error, ['code', 'stage', 'retryable'], 'source error response.error')
	if (!includesString(ZEROPS_SOURCE_ERROR_CODES, error['code'])) throw new Error('source error response.error.code is invalid')
	if (!includesString(ZEROPS_SOURCE_ERROR_STAGES, error['stage'])) throw new Error('source error response.error.stage is invalid')
	if (typeof error['retryable'] !== 'boolean') throw new Error('source error response.error.retryable must be boolean')
	return { error: { code: error['code'], stage: error['stage'], retryable: error['retryable'] } }
}

export function buildZeropsSourceErrorEnvelope(
	code: ZeropsSourceErrorCode,
	stage: ZeropsSourceErrorStage,
	retryable: boolean,
): ZeropsSourceErrorEnvelope {
	return decodeZeropsSourceErrorEnvelope({ error: { code, stage, retryable } })
}
