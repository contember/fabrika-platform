import checkPackage from '../package.json' with { type: 'json' }

/** The version of this checker and reader, recorded with every snapshot Control reads with it. */
export const CHECKER_VERSION: string = checkPackage.version
