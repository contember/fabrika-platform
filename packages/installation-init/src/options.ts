// The reading rules every `fabrika platform … --provider=zerops` parser shares: a flag beats the
// environment variable beside it, a blank value is an absent one, and a flag given twice is refused.

export type CommandEnv = Record<string, string | undefined>

export const readFlag = (argv: readonly string[], name: string): string | undefined => {
	const prefix = `${name}=`
	const matches = argv.filter((arg) => arg.startsWith(prefix))
	if (matches.length > 1) {
		throw new Error(`${name} was given more than once`)
	}
	const value = matches[0]?.slice(prefix.length)
	return value === undefined || value.trim() === '' ? undefined : value.trim()
}

export const readEnv = (env: CommandEnv, name: string): string | undefined => {
	const value = env[name]
	return value === undefined || value.trim() === '' ? undefined : value.trim()
}

export const setting = (argv: readonly string[], env: CommandEnv, flag: string, variable: string): string | undefined =>
	readFlag(argv, flag) ?? readEnv(env, variable)

export const requiredSetting = (value: string | undefined, flag: string, variable: string): string => {
	if (value === undefined) {
		throw new Error(`${flag}=<value> or ${variable} is required`)
	}
	return value
}

/** How a refusal names an argument: a flag by its name only, never its value, which may be a pasted credential. */
export const describeArgument = (arg: string): string => arg.startsWith('-') ? `\`${arg.split('=')[0]}\`` : 'a positional argument'

/** One argument as a POSIX shell reads it back unchanged, for the rerun command a declined step prints. */
export const shellWord = (arg: string): string => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
