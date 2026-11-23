import type { DataOperationDto } from '@fabrika/control-contract'
import { type DataOperationOutcome, type OpsUnavailable, toDataOperationDto } from '../data-operations'
import { fail } from './domain'

/** The record as the operation left it: one the object left unanswered is still `running`, at its step. */
export function dataOperationResult(outcome: DataOperationOutcome): DataOperationDto {
	if (outcome.kind === 'busy') fail(409, 'a deploy or another data operation holds this environment')
	if (outcome.kind === 'driven' || outcome.kind === 'started') return toDataOperationDto(outcome.operation)
	if (outcome.reason === 'operation_running') fail(409, 'an operation of this environment is still running: recover it first')
	if (outcome.reason === 'not_recoverable') fail(409, 'that operation is not one this environment can recover')
	if (outcome.reason === 'superseded') fail(409, 'a newer operation of this environment supersedes that one')
	if (outcome.reason === 'not_open') fail(409, 'the environment is not open: open it first')
	if (outcome.reason === 'too_many_objects') fail(409, "the environment's object list is full (16 names): no clone can be listed")
	if (outcome.reason === 'nothing_deployed') fail(409, 'the environment has no succeeded deploy to redeploy')
	if (outcome.reason === 'no_deploys') fail(503, 'restores are unavailable: this composition does not deploy from a data operation')
	if (outcome.reason === 'not_past') fail(400, 'the restore time must lie in the past')
	failUnavailable(outcome.reason)
}

export function failUnavailable(reason: OpsUnavailable): never {
	if (reason === 'no_channel') fail(409, 'the environment has no ops channel: it needs a domain and a deploy at a release that serves one')
	if (reason === 'not_served') fail(409, "the environment's release does not serve this operation: deploy it at a release that does")
	fail(502, reason === 'channel_refused' ? "the environment's ops channel refused Control" : "the environment's object gave no usable answer")
}
