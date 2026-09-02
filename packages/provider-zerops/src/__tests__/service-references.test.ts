import { describe, expect, test } from 'bun:test'
import { allowedReferenceHosts, foreignReferenceHost, serviceReferenceHosts } from '../service-references'

describe('service references', () => {
	test('extracts the host of every `${host_KEY}` reference once, in order', () => {
		const text = 'a=${notesdb_connectionTlsString}/${notesdb_dbName} b=${proxy_FABRIKA_IAM_KEY} c=${notesdb_user}'
		expect(serviceReferenceHosts(text)).toEqual(['notesdb', 'proxy'])
	})

	test('ignores platform variables that carry no service host', () => {
		expect(serviceReferenceHosts('${zeropsSubdomainHost} ${RUNTIME_FABRIKA_PROXY_MANIFEST_JSON} $notesdb_x ${_x}')).toEqual([])
	})

	test('an app may reference its own services and the shared postgres, nothing else', () => {
		const allowed = allowedReferenceHosts(['notesapi', 'notesdb'])
		expect(foreignReferenceHost('${notesdb_connectionTlsString} ${postgres_dbName}', allowed)).toBeNull()
		expect(foreignReferenceHost('${notesdb_user} ${proxy_FABRIKA_IAM_KEY}', allowed)).toBe('proxy')
		expect(foreignReferenceHost('${aaanotesdb_user}', allowed)).toBe('aaanotesdb')
	})

	test('reads the `RUNTIME_` build-time bridge as a reference to the host it names', () => {
		const allowed = allowedReferenceHosts(['notesapi'])
		expect(foreignReferenceHost('${RUNTIME_proxy_FABRIKA_IAM_KEY}', allowed)).toBe('proxy')
		expect(foreignReferenceHost('${RUNTIME_notesapi_PORT}', allowed)).toBeNull()
	})
})
