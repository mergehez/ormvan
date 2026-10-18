/**
 * `firstOrFail()`'s error. It carries `code` and `status`, so an Adonis exception handler answers 404 without
 * knowing which ORM threw it:
 *
 * ```ts
 * if (error.code === 'E_ROW_NOT_FOUND') return response.notFound();
 * ```
 */
export class OrmRowNotFoundError extends Error {
    readonly code = 'E_ROW_NOT_FOUND';
    readonly status = 404;

    constructor(
        /** The model the lookup ran on — only used for the message. */
        readonly model?: unknown
    ) {
        const name = modelName(model);
        super(`Row not found${name ? ` for model '${name}'` : ''}`);
        this.name = 'OrmRowNotFoundError';
    }
}

/** A model class is a value, not a `{ name }` shape — read the name defensively. */
function modelName(model: unknown): string | undefined {
    const name = (model as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' ? name : undefined;
}

/**
 * A model declares a soft delete but the column its config names is not among the model's columns, so every read
 * of it would compile a predicate against a column that does not exist.
 */ export class OrmSoftDeleteMisconfiguredError extends Error {
    readonly code = 'E_ORM_SOFT_DELETE_MISCONFIGURED';

    constructor(
        /** The model whose config is wrong — only used for the message. */
        readonly model: unknown,
        /** The column the config names. */
        readonly column: string,
        /** The columns the model does declare. */
        readonly columns: readonly string[]
    ) {
        const name = modelName(model);
        super(`Soft delete misconfigured${name ? ` on model '${name}'` : ''}: column '${column}' is not one of its columns (${columns.join(', ') || 'none'}).`);
        this.name = 'OrmSoftDeleteMisconfiguredError';
    }
}

/** The migrator was pointed at a directory that is not there — a bad path, not an empty set of migrations. */
export class OrmMigrationsMissingError extends Error {
    readonly code = 'E_ORM_MIGRATIONS_MISSING';

    constructor(
        /** The directory that could not be read. */
        readonly directory: string
    ) {
        super(`No migration directory at '${directory}'`);
        this.name = 'OrmMigrationsMissingError';
    }
}

/** A migration file is not a module exporting `up` **and** `down`; knex would fail on it later with a vaguer message. */
export class OrmMigrationInvalidError extends Error {
    readonly code = 'E_ORM_MIGRATION_INVALID';

    constructor(
        /** The migration's name, without its extension. */
        readonly migration: string
    ) {
        super(`Migration '${migration}' must export both 'up' and 'down'`);
        this.name = 'OrmMigrationInvalidError';
    }
}
