#!/usr/bin/env bun
// The build sandbox, for real, in the runner image (ADR-0086): run as root with a Cloudflare token in this process's
// environment, as the runner holds its job. Checks that a sandboxed step runs as the build user with nothing of that
// environment and no descriptor of this process, cannot read this process's `/proc/<pid>/environ` or a root file beside
// the checkout, has no network when the container allows a namespace, leaves nothing running after `reap` (not even a
// process that keeps forking), and builds the smoke application into an output the runner copies and the deploy opens
// without importing anything of it, without letting a recorded binding replace the Worker's `main` or a Worker option
// bind a resource by literal id, and that the step cannot change the tools or the home the deploy runs with as root.
//
// `SMOKE_REQUIRE_NETNS=1` fails unless the network is isolated (run with `--cap-add SYS_ADMIN --cap-add NET_ADMIN`).

import { cp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { openPrebuiltApplication, rebuildApplicationWorker } from '../../../provider-cloudflare/src/isolated-deploy'
import { BuildOutputRefused, copyBuildOutput } from '../../src/output'
import { linuxBuildSandbox, processesOf } from '../../src/sandbox'
import { bunSpawner } from '../../src/spawn'

const fail = (message: string): never => {
	console.error(`sandbox smoke: ${message}`)
	process.exit(1)
}

const UID = 10001
const work = '/workspace/smoke'
const secretFile = `${work}.values.json`
await rm(work, { recursive: true, force: true })
await mkdir(`${work}/build/home`, { recursive: true })
await mkdir(`${work}/build/tmp`, { recursive: true })
await mkdir(`${work}/build/out`, { recursive: true })
await writeFile(secretFile, '{"API_KEY":"smoke-secret"}', { mode: 0o600 })

if (process.env['CLOUDFLARE_API_TOKEN'] === undefined) fail('run it with CLOUDFLARE_API_TOKEN set, as the runner holds its job')
const sandbox = await linuxBuildSandbox({ uid: UID, gid: UID, network: process.env['SMOKE_REQUIRE_NETNS'] === '1' ? 'isolated' : 'auto' })
if (sandbox.unavailable !== null) fail(`unavailable: ${sandbox.unavailable}`)
console.info(`sandbox smoke: network ${sandbox.isolatesNetwork ? 'isolated' : 'open'}`)

// The checkout: the smoke application, resolving the platform from the image's workspace as an install would.
await cp('/opt/fabrika/packages/runner-container/docker/smoke', `${work}/src`, { recursive: true })
await mkdir(`${work}/src/node_modules/@fabrika`, { recursive: true })
await symlink('/opt/fabrika/packages/provider-cloudflare', `${work}/src/node_modules/@fabrika/provider-cloudflare`)
await sandbox.own([`${work}/src`, `${work}/build`])
const env = {
	PATH: '/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
	HOME: `${work}/build/home`,
	TMPDIR: `${work}/build/tmp`,
	WRANGLER_SEND_METRICS: 'false',
}

const run = async (command: string, args: readonly string[], cwd: string, network: boolean): Promise<{ exitCode: number; output: string }> => {
	let output = ''
	const spec = sandbox.command({ command, args, cwd, env, network })
	const result = await bunSpawner(spec, { onStdout: (chunk) => (output += chunk), onStderr: (chunk) => (output += chunk) })
	await sandbox.reap()
	return { exitCode: result.exitCode, output }
}

const probe = `
const attempt = async (body) => { try { await body(); return 'allowed' } catch (error) { return error?.code ?? error?.name ?? 'refused' } }
const report = {
	uid: process.getuid(),
	gid: process.getgid(),
	env: Object.keys(process.env).sort(),
	environ: await attempt(() => Bun.file('/proc/1/environ').text()),
	values: await attempt(() => Bun.file(${JSON.stringify(secretFile)}).text()),
	workspace: await attempt(() => Bun.write('/workspace/planted', 'x')),
	// What the deploy runs as root afterwards: the image's tools and root's home, where wrangler keeps its config.
	tools: await attempt(() => Bun.write('/opt/bun/bin/planted', 'x')),
	executor: await attempt(() => Bun.write('/opt/fabrika/packages/provider-cloudflare/src/planted.ts', 'x')),
	rootHome: await attempt(() => Bun.write('/root/.wrangler/planted', 'x')),
	network: await attempt(() => fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(3000) })),
}
console.log(JSON.stringify(report))
`
const probed = await run('bun', ['-e', probe], `${work}/build/tmp`, false)
if (probed.exitCode !== 0) fail(`the probe failed: ${probed.output}`)
const report = JSON.parse(probed.output.trim().split('\n').at(-1) ?? '{}')
console.info(`sandbox smoke: probe ${JSON.stringify(report)}`)
if (report.uid !== UID || report.gid !== UID) fail('the step did not run as the build user')
if (report.env.some((name: string) => name.startsWith('CLOUDFLARE_'))) fail('the step inherited a Cloudflare variable')
if (report.environ === 'allowed') fail("the step read the runner's /proc/1/environ")
if (report.values === 'allowed') fail("the step read the runner's values file")
if (report.workspace === 'allowed') fail('the step wrote into the workspace')
if (report.tools === 'allowed' || report.executor === 'allowed') fail('the step changed a tool the deploy runs as root')
if (report.rootHome === 'allowed') fail("the step wrote into root's home")
if (sandbox.isolatesNetwork && report.network === 'allowed') fail('the step reached the network inside its namespace')
// Only stdin, stdout, stderr and the listing's own: no descriptor of the runner reaches the step.
const fds = await run('/bin/sh', ['-c', 'ls /proc/self/fd'], `${work}/build/tmp`, false)
if (fds.output.trim().split(/\s+/).join(' ') !== '0 1 2 3') fail(`the step inherited a descriptor of the runner: ${fds.output.trim()}`)

// Nothing a step starts outlives it.
await run('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 &'], `${work}/build/tmp`, false)
if ((await processesOf(UID)).length > 0) fail('a process of the build user outlived reap')
// Nor one that keeps replacing itself with a new pid, which a walk of /proc alone can miss.
const hop = `printf '#!/bin/sh\\n: > ${work}/build/tmp/hop\\n"$0" </dev/null >/dev/null 2>&1 &\\n' > ${work}/build/tmp/hop.sh
chmod +x ${work}/build/tmp/hop.sh; ${work}/build/tmp/hop.sh </dev/null >/dev/null 2>&1 &`
for (let round = 0; round < 5; round++) {
	await run('/bin/sh', ['-c', hop], `${work}/build/tmp`, false)
	const before = (await stat(`${work}/build/tmp/hop`)).mtimeMs
	await Bun.sleep(500)
	if ((await stat(`${work}/build/tmp/hop`)).mtimeMs !== before) fail('a process that keeps forking outlived reap')
}

// The build of the smoke application, offline when the container allows it.
const built = await run('fabrika-cloudflare-executor', ['build', '--env=smoke', `--out=${work}/build/out`], `${work}/src`, false)
if (built.exitCode !== 0) fail(`the build failed: ${built.output.slice(-2000)}`)
await copyBuildOutput(`${work}/build/out`, `${work}/bundle`)
const prebuilt = await openPrebuiltApplication(`${work}/bundle`, 'smoke')
if (!(await Bun.file(prebuilt.main).exists())) fail('the bundle has no entry')
console.info(`sandbox smoke: built ${prebuilt.manifest.appId} into ${prebuilt.manifest.worker.main}`)

// A recorded binding cannot replace the Worker's \`main\`: wrangler would read the checkout as root and upload its links.
const steered = { ...prebuilt.manifest, worker: { ...prebuilt.manifest.worker, bindings: { ...prebuilt.manifest.worker.bindings } } }
steered.worker.bindings['X'] = { type: 'config', config: { main: `${work}/src/evil.mjs` } }
try {
	rebuildApplicationWorker(steered, prebuilt.appDir)
	fail('the deploy rebuilt a Worker whose main a recorded binding replaced')
} catch (error) {
	if (!String(error).includes('other than its own service or AI binding')) throw error
}

// Nor can a Worker option bind a resource by literal id past the classes the deploy rebuilds.
const literal = { ...prebuilt.manifest, worker: { ...prebuilt.manifest.worker, options: { ...prebuilt.manifest.worker.options } } }
literal.worker.options['kv_namespaces'] = [{ binding: 'STATE', id: 'platform-state-namespace' }]
try {
	rebuildApplicationWorker(literal, prebuilt.appDir)
	fail('the deploy rebuilt a Worker that binds a KV namespace by a literal id')
} catch (error) {
	if (!String(error).includes('sets the Worker option `kv_namespaces`')) throw error
}

// The copier refuses a link the build could leave.
await mkdir(`${work}/linked/app`, { recursive: true })
await symlink('/proc/1/environ', `${work}/linked/app/environ`)
try {
	await copyBuildOutput(`${work}/linked`, `${work}/linked-copy`)
	fail('the copier copied a symbolic link')
} catch (error) {
	if (!(error instanceof BuildOutputRefused)) throw error
}

// A build process that outlived reap could still swap a directory for a link while the copier walks it: every name is
// resolved inside the directory the copier opened, so the copy never reaches what the link points at.
await mkdir(`${work}/secretdir`, { mode: 0o700 })
await writeFile(`${work}/secretdir/entry.js`, 'smoke-secret', { mode: 0o600 })
await mkdir(`${work}/race/out/app/bundle`, { recursive: true })
await writeFile(`${work}/race/out/app/bundle/entry.js`, 'export default {}')
// Outside the output, so the copier's listing only ever shows `bundle`, a directory one moment and a link the next.
await mkdir(`${work}/race/hold`)
await symlink(`${work}/secretdir`, `${work}/race/hold/link`)
await sandbox.own([`${work}/race`])
const swap = `exec perl -e 'while (1) { rename q(out/app/bundle), q(hold/real); rename q(hold/link), q(out/app/bundle); \
rename q(out/app/bundle), q(hold/link); rename q(hold/real), q(out/app/bundle) }'`
const swapper = sandbox.command({ command: '/bin/sh', args: ['-c', swap], cwd: `${work}/race`, env, network: false })
const swapping = Bun.spawn([swapper.command, ...swapper.args], { cwd: swapper.cwd, env: swapper.env, stdout: 'ignore', stderr: 'ignore' })
let copies = 0
let refusals = 0
for (let round = 0; round < 2000; round++) {
	const target = `${work}/race-copy-${round}`
	try {
		await copyBuildOutput(`${work}/race/out`, target)
		copies += 1
		const entry = Bun.file(`${target}/app/bundle/entry.js`)
		if ((await entry.exists()) && (await entry.text()).includes('smoke-secret')) fail('the copier followed a directory swapped for a link')
	} catch (error) {
		if (!(error instanceof BuildOutputRefused) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		refusals += 1
	}
	await rm(target, { recursive: true, force: true })
}
swapping.kill('SIGKILL')
await sandbox.reap()
console.info(`sandbox smoke: copied ${copies} and refused ${refusals} outputs while a directory was swapped for a link`)

console.info('sandbox smoke: ok')
