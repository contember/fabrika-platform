// The framework's own file jobs, in a module of their own: the build recipe schedules them without the file stack.

/** The reserved name of the scan job: a `c.cron` job name cannot contain `-`, so no application job takes it. */
export const FILE_SCAN_JOB = 'fabrika-file-scan'
export const FILE_SCAN_SCHEDULE = '* * * * *'

/**
 * The framework's sweep job: hourly, it deletes the files no declared column references and the pending ones past the
 * grace, so none waits for the next request. A reserved name with `-`, which no `c.cron` name can take.
 */
export const FILE_SWEEP_JOB = 'fabrika-file-sweep'
export const FILE_SWEEP_SCHEDULE = '41 * * * *'
