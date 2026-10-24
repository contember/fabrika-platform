// The installation's client logo (ADR-0066): an installation administrator's to read and to change. Control reads it
// with the provisioning key, which resolves to a synthetic installation administrator, and carries it to the proxy.

import type { InstallationBrandDto, SetInstallationBrandRequest } from '@fabrika/iam-contract'
import { installationBrandSchema } from '@fabrika/proxy-core/brand'
import { type AuditEventInput, type InstallationBrandRow } from '../db'
import { brandImages, storedBrand } from '../installation-brand'
import { type AdminContext, adminEvent, fail } from './context'

export async function getInstallationBrandUseCase(c: AdminContext): Promise<InstallationBrandDto> {
	requireInstallationAdmin(c)
	return brandDto(c, await c.services.repositories.brand.get())
}

/**
 * Store the brand, checked here again whatever the console checked: every reader trusts what IAM stored no more than
 * this, and checks it again too. The record names the types of the images it stored, never their bytes.
 */
export async function setInstallationBrandUseCase(c: AdminContext, input: SetInstallationBrandRequest): Promise<InstallationBrandDto> {
	requireInstallationAdmin(c)
	const parsed = installationBrandSchema.safeParse(input.brand)
	if (!parsed.success) {
		return fail(400, `not an installation brand: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
	}
	const brand = parsed.data
	const row = await c.services.repositories.brand.set(
		brandImages(brand),
		brandEvent(c, { light: brand.light.type, dark: brand.dark?.type ?? null }),
	)
	return brandDto(c, row)
}

/** Clear the brand, so every page draws the fabrika mark again. Clearing an absent brand changes and records nothing. */
export async function clearInstallationBrandUseCase(c: AdminContext): Promise<InstallationBrandDto> {
	requireInstallationAdmin(c)
	const cleared = await c.services.repositories.brand.clear(brandEvent(c, { light: null, dark: null }))
	return brandDto(c, cleared ?? await c.services.repositories.brand.get())
}

function brandEvent(c: AdminContext, images: { light: string | null; dark: string | null }): AuditEventInput {
	return adminEvent(c, { action: 'iam.brand.update', resourceType: 'installation_brand', metadata: images })
}

/** The brand as the pages draw it: a stored row the check now refuses answers null, like no brand. */
function brandDto(c: AdminContext, row: InstallationBrandRow | null): InstallationBrandDto {
	return { brand: storedBrand(c.services.repositories.brand, row), updatedAt: row?.updated_at ?? null }
}

/** `.require(iam.admin)` gates these procedures already; a direct caller of a use case meets the same rule. */
function requireInstallationAdmin(c: AdminContext): void {
	if (c.administration.kind !== 'installation') {
		return fail(403, "the installation's brand is changed and read only by an installation administrator")
	}
}
