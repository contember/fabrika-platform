#!/usr/bin/env bun

// `fabrika-source-maps <root>`: the last step of a Zerops platform build. It uploads the source maps under the asset
// roots that `FABRIKA_SOURCE_MAP_UPLOAD` names, with the bearer in `FABRIKA_SOURCE_MAP_UPLOAD_KEY`, and prints one
// report line the provider reads back from the build log. It always exits 0: a deploy never fails on its maps.

import { FABRIKA_SOURCE_MAP_UPLOAD, FABRIKA_SOURCE_MAP_UPLOAD_KEY } from '@fabrika/auth-core'
import {
	type OperationsSourceMapBuildUpload,
	parseOperationsSourceMapBuildUpload,
	sourceMapUploadReport,
} from '@fabrika/operations-contract/releases'
import { resolve } from 'node:path'
import { type ArtifactFetch, collectAssetSourceMaps, type SourceMapUploadResult, uploadSourceMaps } from './source-maps'

const readUpload = (value: string | undefined): OperationsSourceMapBuildUpload | null => {
	if (value === undefined || value === '') return null
	try {
		return parseOperationsSourceMapBuildUpload(JSON.parse(value))
	} catch {
		return null
	}
}

/** Collect and upload; every failure is an incomplete result, and nothing it prints carries the bearer. */
export async function runSourceMapUpload(
	root: string,
	environment: Readonly<Record<string, string | undefined>>,
	fetch: ArtifactFetch,
): Promise<SourceMapUploadResult> {
	const upload = readUpload(environment[FABRIKA_SOURCE_MAP_UPLOAD])
	const bearer = environment[FABRIKA_SOURCE_MAP_UPLOAD_KEY] ?? ''
	if (upload === null || bearer === '') return { uploaded: 0, state: 'incomplete' }
	try {
		const collection = await collectAssetSourceMaps(root, upload.assetRoots)
		return await uploadSourceMaps({ ...upload.destination, bearer }, collection, fetch)
	} catch {
		return { uploaded: 0, state: 'incomplete' }
	}
}

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? '.')
	const result = await runSourceMapUpload(root, process.env, (input, init) => fetch(input, init))
	console.info(sourceMapUploadReport(result.uploaded, result.state))
}
