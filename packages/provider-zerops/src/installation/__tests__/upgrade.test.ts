// What `fabrika platform upgrade --provider=zerops` must do, and in what order.
//
// The checkout is a REAL temporary directory, so `fabrika.ref` is asserted as it lands on disk —
// including the trailing newline the sidecar template writes and the workflow's `tr -d '[:space:]'`
// tolerates. Everything that leaves the machine is an injected effect, recorded as an ordered list:
// there is no `gh` and no `git` on this path, deliberately, so the test says what the command does
// rather than what the tools do.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordingDeployLog } from '../log'
import { FABRIKA_REF_FILE } from '../sidecar'
import { runUpgrade, type SidecarBranch, type TagLookup, type UpgradeCollaborators, type UpgradeRun } from '../upgrade'
import { parsePlatformUpgradeArgs } from '../upgrade-options'

const REPO = 'contember/fabrika-zerops-test'
const SHA = '4d1f6a0b6d3f4a1e8c2b9d0f7a5e3c1b8d6f4a2e'
const RUN: UpgradeRun = { id: '42', url: `https://github.com/${REPO}/actions/runs/42`, status: 'queued' }
const ON_MAIN: SidecarBranch = { name: 'main', ahead: 0 }

interface Recorder {
	readonly collaborators: UpgradeCollaborators
	readonly effects: string[]
	readonly lines: readonly string[]
	/** The transcript as it stood when `watchRun` was entered — the run URL must already be in it. */
	readonly linesAtWatch: string[]
}

const recorder = (options: {
	readonly ghInstalled?: boolean
	readonly tag?: TagLookup
	readonly dirty?: boolean
	readonly branch?: SidecarBranch
	readonly cloneDir?: string
	/** What each `findRun` poll answers, in order; the last answer repeats. */
	readonly runs?: readonly (UpgradeRun | undefined)[]
	readonly watchFails?: boolean
} = {}): Recorder => {
	const effects: string[] = []
	const log = recordingDeployLog()
	const linesAtWatch: string[] = []
	const answers = [...(options.runs ?? [undefined, RUN])]
	return {
		effects,
		lines: log.lines,
		linesAtWatch,
		collaborators: {
			log,
			sleep: async () => {},
			signal: new AbortController().signal,
			effects: {
				hasGh: async () => {
					effects.push('has-gh')
					return options.ghInstalled ?? true
				},
				verifyTag: async (tag) => {
					effects.push(`verify-tag: ${tag}`)
					return options.tag ?? { state: 'published' }
				},
				cloneSidecar: async (repo) => {
					effects.push(`clone: ${repo}`)
					return options.cloneDir ?? ''
				},
				describeCheckout: async () => {
					effects.push('describe')
					return REPO
				},
				isDirty: async () => {
					effects.push('status')
					return options.dirty ?? false
				},
				readBranch: async () => {
					effects.push('branch')
					return options.branch ?? ON_MAIN
				},
				commit: async ({ message }) => {
					effects.push(`commit: ${message}`)
					return SHA
				},
				push: async () => void effects.push('push'),
				findRun: async ({ sha }) => {
					effects.push(`find-run: ${sha}`)
					return answers.length > 1 ? answers.shift() : answers[0]
				},
				watchRun: async ({ runId }) => {
					effects.push(`watch: ${runId}`)
					linesAtWatch.push(...log.lines)
					if (options.watchFails === true) {
						throw new Error('`gh run watch 42 --repo … --exit-status` failed (exit 1).')
					}
				},
			},
		},
	}
}

/** A directory that passes the local checkout probe: it exists and carries a `.git`. */
const withSidecar = async (pin: string | undefined, run: (dir: string) => Promise<void>): Promise<void> => {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-upgrade-'))
	try {
		await mkdir(join(dir, '.git'), { recursive: true })
		if (pin !== undefined) {
			await Bun.write(join(dir, FABRIKA_REF_FILE), pin)
		}
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const pinOf = async (dir: string): Promise<string> => await Bun.file(join(dir, FABRIKA_REF_FILE)).text()

describe('the roll', () => {
	test('checks gh and the tag, writes the pin, commits it under a fixed subject, pushes, then follows the run', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder()
			await runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators)

			expect(recorded.effects).toEqual([
				'has-gh',
				'verify-tag: v0.2.0',
				'describe',
				'status',
				'branch',
				'commit: chore: roll test forward to fabrika v0.2.0',
				'push',
				`find-run: ${SHA}`,
				`find-run: ${SHA}`,
				'watch: 42',
			])
			// The trailing newline is the sidecar template's own shape (`sidecar.test.ts` pins it too).
			expect(await pinOf(dir)).toBe('v0.2.0\n')
		})
	})

	test('prints the run URL BEFORE it starts watching, so an operator who leaves can come back to it', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder()
			await runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators)

			expect(recorded.linesAtWatch.join('\n')).toContain(RUN.url)
			// And it says why a run may sit still: the sidecar workflow queues rather than cancelling.
			expect(recorded.lines.join('\n')).toContain('queued')
		})
	})

	test('warns that unrelated unpushed commits ride along with the roll', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ branch: { name: 'main', ahead: 2 } })
			await runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators)

			expect(recorded.lines).toContain(`warn: ${REPO}: 2 commit(s) here have not been pushed yet — this roll's push carries them too`)
			expect(recorded.effects).toContain('push')
		})
	})

	test('waits for the run GitHub has not registered yet, and gives up naming the repository', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ runs: [undefined] })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow(`no platform.yml run appeared for ${SHA} on main`)
			// The pin IS pushed — the failure is only that the run could not be found to watch.
			expect(recorded.effects).toContain('push')
			expect(await pinOf(dir)).toBe('v0.2.0\n')
		})
	})

	test('a run that ends badly ends the command badly', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ watchFails: true })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('--exit-status')
		})
	})

	test('a repository-shaped sidecar is cloned, and the commit subject still names the installation', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ cloneDir: dir })
			// No installation positional: the name is read back out of `fabrika-zerops-<installation>`.
			await runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', `--sidecar=${REPO}`]), recorded.collaborators)

			expect(recorded.effects.slice(0, 3)).toEqual(['has-gh', 'verify-tag: v0.2.0', `clone: ${REPO}`])
			expect(recorded.effects).toContain('commit: chore: roll test forward to fabrika v0.2.0')
		})
	})
})

describe('what it refuses, before it writes anything', () => {
	test('a `gh` that is missing or logged out, before it asks GitHub anything', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ ghInstalled: false })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('`gh` (GitHub CLI) is required')
			// Without this gate the first failure would be a raw spawn ENOENT, or a tag lookup that failed
			// on authentication and reported itself as a missing tag.
			expect(recorded.effects).toEqual(['has-gh'])
		})
	})

	test('a tag lookup that FAILED is never reported as a missing tag', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ tag: { state: 'unavailable', reason: '`gh api …` failed (exit 1).' } })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('could not be asked whether it carries `v0.2.0`')
			expect(recorded.effects).toEqual(['has-gh', 'verify-tag: v0.2.0'])
		})
	})

	test('a tag the public repository does not carry — the release pushes the tag last', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ tag: { state: 'missing' } })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v9.9.9', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('has no tag `v9.9.9`')
			expect(recorded.effects).toEqual(['has-gh', 'verify-tag: v9.9.9'])
			expect(await pinOf(dir)).toBe('v0.1.0\n')
		})
	})

	test('a directory that does not exist, and one that is not a checkout — naming both ways to point at a sidecar', async () => {
		const recorded = recorder()
		await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', '--sidecar=/nonexistent/sidecar-xyz']), recorded.collaborators))
			.rejects.toThrow('/nonexistent/sidecar-xyz does not exist')
		// A raw spawn ENOENT names neither the flag that supplied the path nor the alternative.
		expect(recorded.effects).toEqual(['has-gh', 'verify-tag: v0.2.0'])
		expect(recorded.lines.join('\n')).not.toContain('ENOENT')

		const plain = await mkdtemp(join(tmpdir(), 'fabrika-notcheckout-'))
		try {
			const second = recorder()
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', `--sidecar=${plain}`]), second.collaborators))
				.rejects.toThrow('is not a git checkout')
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', `--sidecar=${plain}`]), second.collaborators))
				.rejects.toThrow('--sidecar=<owner>/<name>')
		} finally {
			await rm(plain, { recursive: true, force: true })
		}
	})

	test('a dirty sidecar tree, because the commit stages `fabrika.ref` alone', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ dirty: true })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('uncommitted changes to tracked files')
			expect(recorded.effects).not.toContain('push')
			expect(await pinOf(dir)).toBe('v0.1.0\n')
		})
	})

	test('a branch the generated workflow does not trigger on', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ branch: { name: 'try-a-thing', ahead: 0 } })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('`push: branches: [main]`')
			expect(recorded.effects).not.toContain('push')
			expect(await pinOf(dir)).toBe('v0.1.0\n')
		})
	})

	test('a branch that tracks no upstream, where the push has nowhere to land', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder({ branch: { name: 'main', ahead: undefined } })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('tracks no upstream branch')
			expect(recorded.effects).not.toContain('commit: chore: roll test forward to fabrika v0.2.0')
		})
	})

	test('a pin already equal to --to, which would push nothing and therefore trigger nothing', async () => {
		await withSidecar('v0.2.0\n', async (dir) => {
			const recorded = recorder()
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow(`${REPO} already pins v0.2.0`)
			expect(recorded.effects).not.toContain('push')
		})
	})

	test('but a pin committed and NEVER PUSHED says so instead — the roll it claims never happened', async () => {
		// What a failed `git push` leaves behind. The plain "already pins it" refusal would be true of the
		// working tree and false of the installation, and the operator would stop looking.
		await withSidecar('v0.2.0\n', async (dir) => {
			const recorded = recorder({ branch: { name: 'main', ahead: 1 } })
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('already pins v0.2.0 in a commit that was never pushed, so nothing was deployed')
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow(`git -C ${dir} push`)
		})
	})

	test('a directory that is a checkout but not a sidecar', async () => {
		await withSidecar(undefined, async (dir) => {
			const recorded = recorder()
			await expect(runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`]), recorded.collaborators))
				.rejects.toThrow('is not a fabrika sidecar checkout')
		})
	})
})

describe('--dry-run', () => {
	test('reports the roll it would commit and writes nothing', async () => {
		await withSidecar('v0.1.0\n', async (dir) => {
			const recorded = recorder()
			await runUpgrade(parsePlatformUpgradeArgs(['--to=v0.2.0', 'test', `--sidecar=${dir}`, '--dry-run']), recorded.collaborators)

			expect(recorded.effects).toEqual(['has-gh', 'verify-tag: v0.2.0', 'describe', 'status', 'branch'])
			expect(await pinOf(dir)).toBe('v0.1.0\n')
			expect(recorded.lines.join('\n')).toContain('chore: roll test forward to fabrika v0.2.0')
		})
	})
})
