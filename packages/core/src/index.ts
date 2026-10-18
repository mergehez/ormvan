/**
 * The engine's public surface: what an app names in its own code.
 *
 * Everything else is internal — the engine's modules import each other directly, and an app that truly needs an
 * internal reaches it by deep import (`@mergehez/ormvan/orm_where`), which is also how the connector modules are used
 * (`@mergehez/ormvan/mysql2`). What an app's framework needs lives in that framework's adapter instead
 * (`@mergehez/ormvan-adonisjs` holds Adonis' session store and migrate command, and its validation rules).
 *
 * An app configures the engine once, in a module of its own (a connection per name, the clock, the auth reader):
 *
 * ```ts
 * Orm.configure({
 *     getExecutor: (connectionName) => connections.executor(connectionName),
 *     now: () => dt.unix(),
 *     getAuthUser: (ctx) => authUser(ctx),
 * });
 *
 * export { Orm };
 * ```
 *
 * App-specific chain helpers are MODEL SCOPES (`scope(...)`), so every flavour — a main query, a preload callback,
 * a count subquery — can call them.
 */

// --- Models: the base class, the decorators, and the pieces of a declaration ---
export { jsonDec, notMapped, PlainBaseModel } from './orm_base_models.ts';
export { modelHelpers, modelMeta } from './orm_helpers.ts';
export type { OrmModelMeta } from './orm_helpers.ts';
export { column } from './orm_model.ts';
export type { OrmColumn } from './orm_model.ts';
export type { OrmModel } from './orm_model_contract.ts';
export { belongsTo, hasMany, hasManyThrough, hasOne, manyToMany, relationsDeclaredByEngine } from './orm_relations.ts';
export type { BelongsTo, HasMany, HasManyThrough, HasOne, ManyToMany, OrmRelationOptions } from './orm_relations.ts';
export { hiddenColumns, omitHidden, visibleColumns } from './orm_serialization.ts';
export { defaultSoftDelete, SoftDeletes } from './orm_soft_delete.ts';
export { softDeleteScopes } from './orm_soft_delete.ts';
export type { SoftDeleteConfig, SoftDeletable, SoftDeleteToggles } from './orm_soft_delete.ts';

// --- The engine, its configuration, and the executor an app provides ---
export { OrmExecutorMissingError } from './executor.ts';
export type { OrmExecutor, OrmQueryable } from './executor.ts';
export type { OrmConfig, OrmMigrationsConfig } from './orm_config.ts';
export type { OrmContext } from './orm_context.ts';
export { Orm } from './orm_engine.ts';
export type { OrmConnection } from './orm_engine.ts';
export { OrmMigrationInvalidError, OrmMigrationsMissingError, OrmRowNotFoundError, OrmSoftDeleteMisconfiguredError } from './orm_errors.ts';

// --- The chain: what a scope, a hook or a helper names ---
export { colAs, scope, sqlAs } from './orm_builder.ts';
export type { ModelBuilder, OrmBuilderRow, OrmRow, RelationBuilder, RelationKeyOf, RelationQuery } from './orm_builder.ts';
export { CountQueryBuilder } from './orm_count_query_builder.ts';
export { dbRaw } from './orm_helpers.ts';
export { createPagination } from './orm_pagination.ts';
export type { PaginatedResult } from './orm_pagination.ts';
export type { WithAddedCounts, WithAddedPreloads } from './orm_rebuild.ts';
export { WhereHasQueryBuilder } from './orm_simple_builder.ts';
export { PreloadQueryBuilder, SubqueryBuilder } from './orm_subquery_builder.ts';
export type { SqlValue } from './orm_where.ts';

// --- Rows, writes and results ---
export type { OrmRowWithHidden, OrmRowWithRelations } from './orm_engine.ts';
export type { Mutable } from './orm_mutable.ts';
export type { OrmCreateData, OrmUpdateData } from './orm_write.ts';
export type { MergeUnion } from './shared/types.ts';

// --- Hooks ---
export type { OrmDeleteHookContext, OrmHookContext, OrmHookName, OrmHooks, OrmInsertIntent, OrmReadHookContext, OrmReadPhase, OrmUpdateHookContext, OrmUpdateIntent } from './orm_hooks.ts';

// --- Migrations: knex's job, driven by the engine's `orm:migrate` command ---
// Deliberately not re-exported: `orm_migrations.ts` names knex's types, and knex is an optional peer, so pulling it
// in here would make every app install it. Import the subpath (`@mergehez/ormvan/orm_migrations`) to drive it yourself.
