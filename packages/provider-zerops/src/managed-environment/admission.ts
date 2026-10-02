import { parseServiceEnvResponse } from '../api/service-env-response'
import type { ZeropsImportResult, ZeropsProcess, ZeropsService, ZeropsServiceEnv } from '../api/types'
import type { FabrikaImportDocument } from '../manifest'
import {
	type ConfirmedManagedBinding,
	MANAGED_ENVIRONMENT_MARKER,
	MANAGED_KEYS,
	type ManagedOwner,
	managedOwnerCoordinates,
	mapManagedKeys,
	parseManagedMarker,
	parseManagedOwner,
	requireConfirmedBinding,
	serializeManagedOwner,
	verifyManagedCheckpoint,
} from './protocol'

const refuse = (): never => {
	throw new Error('zerops: managed-environment ownership could not be established')
}

export interface FreshManagedServiceEvidence {
	projectId: string
	serviceId: string
	hostname: string
	creationProcessId: string
}

export interface CodelessManagedServiceEvidence extends FreshManagedServiceEvidence {
	codelessAppVersionId: string
}

/** The caller supplies the actual collision-rejecting request and every completed import process. */
export function confirmFreshManagedService(input: {
	owner: ManagedOwner
	provisioningDocument: FabrikaImportDocument
	imported: ZeropsImportResult
	finishedProcesses: readonly ZeropsProcess[]
	service: ZeropsService
}): FreshManagedServiceEvidence {
	const owner = parseManagedOwner(input.owner)
	const { imported, finishedProcesses, service } = input
	if (
		imported.projectId !== owner.projectId || service.id !== owner.serviceId || service.name !== owner.hostname || service.projectId !== owner.projectId
	) {
		return refuse()
	}
	const declaredNames = input.provisioningDocument.services.map((entry) => {
		const hostname = entry['hostname']
		if (typeof hostname !== 'string' || hostname === '' || entry['override'] !== false || entry['startWithoutCode'] !== true) return refuse()
		return hostname
	})
	if (declaredNames.length === 0 || new Set(declaredNames).size !== declaredNames.length || !declaredNames.includes(owner.hostname)) return refuse()
	if (imported.services.length !== declaredNames.length) return refuse()
	const serviceIds = new Set<string>()
	const serviceNames = new Set<string>()
	const processIds = new Set<string>()
	let creation: ZeropsProcess | undefined
	for (const importedService of imported.services) {
		if (
			importedService.id.trim() === '' || !declaredNames.includes(importedService.name) || serviceIds.has(importedService.id)
			|| serviceNames.has(importedService.name)
		) {
			return refuse()
		}
		serviceIds.add(importedService.id)
		serviceNames.add(importedService.name)
		if (importedService.name === owner.hostname && importedService.id !== owner.serviceId) return refuse()
		if (importedService.processes.length === 0) return refuse()
		for (const reported of importedService.processes) {
			if (reported.id.trim() === '' || processIds.has(reported.id)) return refuse()
			processIds.add(reported.id)
			const matches = finishedProcesses.filter((process) => process.id === reported.id)
			const finished = matches[0]
			if (matches.length !== 1 || finished === undefined || finished.status !== 'FINISHED' || finished.serviceStackId !== importedService.id) {
				return refuse()
			}
			if (reported.serviceStackId !== importedService.id) return refuse()
			if (reported.actionName === undefined || reported.actionName.trim() === '' || reported.actionName !== finished.actionName) return refuse()
			if (reported.appVersionId !== undefined && reported.appVersionId !== finished.appVersionId) return refuse()
			if (importedService.id !== owner.serviceId) continue
			if (finished.actionName === 'stack.create') {
				if (creation !== undefined) return refuse()
				creation = finished
			}
		}
	}
	if (finishedProcesses.length !== processIds.size || creation === undefined) {
		return refuse()
	}
	return {
		projectId: owner.projectId,
		serviceId: owner.serviceId,
		hostname: owner.hostname,
		creationProcessId: creation.id,
	}
}

/** Bootstrap requires evidence for the active codeless version, not just an empty canonical map. */
export function confirmCodelessManagedService(input: Parameters<typeof confirmFreshManagedService>[0]): CodelessManagedServiceEvidence {
	const fresh = confirmFreshManagedService(input)
	const declared = input.provisioningDocument.services.find((service) => service['hostname'] === fresh.hostname)
	if (declared?.['buildFromGit'] !== undefined) return refuse()
	if (input.finishedProcesses.some((process) => process.serviceStackId === fresh.serviceId && process.actionName === 'stack.build')) return refuse()
	const deployments = input.finishedProcesses.filter((process) => process.serviceStackId === fresh.serviceId && process.actionName === 'stack.deploy')
	const deployment = deployments[0]
	if (deployments.length !== 1 || deployment?.appVersionId === undefined || deployment.appVersionId.trim() === '') return refuse()
	if (input.service.activeAppVersionId !== deployment.appVersionId) return refuse()
	return { ...fresh, codelessAppVersionId: deployment.appVersionId }
}

export type PriorManagedBinding =
	| { kind: 'retained'; checkpoint: unknown }
	| { kind: 'bootstrap' }

/** Retained checkpoints must be looked up by observed external version, including after rollback. */
export async function admitManagedEnvironment(input: {
	owner: ManagedOwner
	records: readonly ZeropsServiceEnv[]
	observedActiveAppVersionId: string | null
	prior: PriorManagedBinding
}): Promise<{ markerRecordId: string; binding: ConfirmedManagedBinding }> {
	const owner = parseManagedOwner(input.owner)
	const records = parseServiceEnvResponse({ items: input.records }, owner.serviceId)
	const marker = records.find((entry) => entry.key === MANAGED_ENVIRONMENT_MARKER)
	if (marker === undefined || marker.sensitive !== true) return refuse()
	const ownership = parseManagedMarker(marker.content)
	if (serializeManagedOwner(managedOwnerCoordinates(ownership)) !== serializeManagedOwner(owner)) return refuse()
	let binding: ConfirmedManagedBinding
	if (input.prior.kind === 'bootstrap') {
		if (input.observedActiveAppVersionId !== ownership.initialCodelessAppVersionId) return refuse()
		binding = mapManagedKeys(() => ({ state: 'absent' }))
	} else {
		const prior = await verifyManagedCheckpoint(input.prior.checkpoint)
		if (prior.phase !== 'build_trigger_requested' && prior.phase !== 'build_triggered') return refuse()
		if (prior.appVersionId !== input.observedActiveAppVersionId || prior.markerRecordId !== marker.id) return refuse()
		const priorOwner: ManagedOwner = {
			protocol: prior.protocol,
			appId: prior.appId,
			environment: prior.environment,
			namespaceId: prior.namespaceId,
			projectId: prior.projectId,
			serviceId: prior.serviceId,
			hostname: prior.hostname,
		}
		if (serializeManagedOwner(priorOwner) !== serializeManagedOwner(owner)) return refuse()
		binding = requireConfirmedBinding(prior.binding)
	}
	for (const key of MANAGED_KEYS) {
		const entry = binding[key]
		const canonical = records.find((record) => record.key === key)
		if (entry.state === 'absent') {
			if (canonical !== undefined) return refuse()
			continue
		}
		if (canonical === undefined || canonical.content !== `\${${entry.referenceName}}`) return refuse()
		const backing = records.find((record) => record.key === entry.referenceName)
		if (backing === undefined || backing.id !== entry.backingRecordId || backing.sensitive !== true) return refuse()
	}
	return { markerRecordId: marker.id, binding }
}
