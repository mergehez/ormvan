/**
 * The engine's own base model: `boot()`/`booted`, `table`, `primaryKey`, `selfAssignPrimaryKey`, `namingStrategy`,
 * its columns, relations and hooks.
 *
 * Rows are read with `.firstMutable()` and written through that row's `save()`.
 */
import { tableNameFromModelName } from './orm_strings.ts';

/**
 * Gives `self` its own value for a static: `'define'` always writes `initialValue`, `'inherit'` keeps an inherited
 * value when the subclass has one.
 */
function defineStaticProperty(self: object, name: string, initialValue: unknown, strategy: 'define' | 'inherit'): void {
    if (Object.hasOwn(self, name)) return;

    const target = self as Record<string, unknown>;
    const inherited = target[name];

    target[name] = strategy === 'define' || inherited === undefined ? initialValue : inherited;
}

/** What a naming strategy must answer. */
export interface OrmNamingStrategy {
    /** The table a model with no `static table` talks to. */
    tableName(model: { name: string }): string;
    /** The column a declared property maps to. */
    columnName(model: unknown, attributeName: string): string;
    /** The JSON key a declared property serializes as. */
    serializedName(model: unknown, attributeName: string): string;
}

/**
 * Table names are snake_cased and pluralized; a column/JSON name is NOT transformed — the model property name IS
 * the DB column name and the JSON key.
 */
export class NoTransformNamingStrategy implements OrmNamingStrategy {
    tableName(model: { name: string }): string {
        return tableNameFromModelName(model.name);
    }

    columnName(_model: unknown, attributeName: string): string {
        return attributeName;
    }

    serializedName(_model: unknown, attributeName: string): string {
        return attributeName;
    }
}

/**
 * The engine's base model. An app extends it through `PlainBaseModel` (`orm_base_models.ts`), which adds the
 * builder statics; everything that reads or writes rows goes through `Model.orm()`.
 */
export class OrmModelBase {
    /** Set by `boot()`; per class, never inherited as `true` from a booted parent. */
    static booted = false;

    /** The table the model talks to: declared, or derived from the class name on boot. */
    static table?: string;

    static primaryKey = 'id';

    static selfAssignPrimaryKey = false;

    static namingStrategy: OrmNamingStrategy = new NoTransformNamingStrategy();

    static boot(): void {
        // Per class, never inherited as `true`: a subclass of an already-booted model still boots itself.
        if (!Object.hasOwn(this, 'booted')) {
            this.booted = false;
        }
        if (this.booted) {
            return;
        }

        this.booted = true;

        if (!Object.hasOwn(this, 'table')) {
            defineStaticProperty(this, 'table', this.namingStrategy.tableName(this), 'define');
        }

        defineStaticProperty(this, 'primaryKey', 'id', 'inherit');
        defineStaticProperty(this, 'selfAssignPrimaryKey', false, 'inherit');
    }

    /**
     * This instance's primary key value — the only instance member here, because an app's auth guard reads
     * it off the user they are handed.
     */
    get $primaryKeyValue(): unknown {
        const model = this.constructor as typeof OrmModelBase;

        return (this as Record<string, unknown>)[model.primaryKey];
    }
}
