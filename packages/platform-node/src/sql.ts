// @fabrika/platform-node/sql — the SQL lexer and the migration classifier, RUNTIME-NEUTRAL: no Bun, no Node, no
// driver, so a Cloudflare Worker (Control reading a commit) loads it as the runner does. `sql-subpath.test.ts` holds
// the import graph to that.

export { applicationDatabaseSchema } from './application-schema'
export {
	FILE_SCAN_COLUMNS,
	FILE_STATUSES,
	FILE_TABLE_PREFIX,
	fileScanAlter,
	fileScanAlterTable,
	fileScanIndex,
	fileStatusCheck,
	fileTableScanReady,
	legacyStatusCheckName,
} from './file-table-ddl'
export {
	classifyMigration,
	type ClassifyMigrationOptions,
	classifyMigrations,
	type DatabaseObject,
	type DatabaseObjectKind,
	declaredFunctions,
	type DeviationKind,
	type FileAdoption,
	type ManifestChange,
	type MigrationClassification,
	type MigrationDeviation,
	type MigrationFile,
	migrationManifest,
	type MigrationRefusal,
	type MigrationSetClassification,
} from './migration-classify'
export { lexSql, type SqlToken, sqlTokens, type Statement, topLevelStatements, upperWord } from './migration-sql'
export { PG_CATALOG_FUNCTIONS, SQL_KEYWORDS } from './pg-catalog-names'
export {
	afterName,
	closingParenthesis,
	ddlForeignSchema,
	dmlForeignSchema,
	dmlRelations,
	frameworkReference,
	type FunctionUse,
	functionUse,
	isFrameworkName,
	isPunct,
	type NameReference,
	nameReferences,
	type NameRole,
	nameText,
	nestedStatement,
	objectNameAt,
	parenthesizedTarget,
	refusedFunctionCall,
	skipWords,
	splitAtCommas,
	statementKind,
	unicodeIdentifier,
} from './sql-names'
