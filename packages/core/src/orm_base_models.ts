/**
 * The model-layer pieces every app writes once, plus the base model whose `orm()` statics go through `Orm`. An app
 * extends it to declare the columns every table has; what is app-specific (connections, clock, auth reader) lives in
 * the app's own module, as `Orm.configure({ … })`.
 */
import type { OrmQueryable } from './executor.ts';
import type { MutateOrm } from './orm_builder.ts';
import { Orm } from './orm_engine.ts';
import { OrmModelBase } from './orm_model_base.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { OrmCreateData, OrmUpdateData } from './orm_write.ts';

/** JSON column cast: parse on read (driver arrays or raw strings), stringify on write. */
export const jsonDec = {
    consume: (value: string | unknown[]) => (typeof value === 'string' ? JSON.parse(value) : value),
    prepare: (value: unknown) => JSON.stringify(value),
} as const;

/** Decorator marking a property as "not mapped": not persisted, not serialized. */
export const notMapped = () => {
    return (_target: unknown, _propertyKey: string): void => {
        // nothing to do — the marker is for TypeScript
    };
};

/**
 * The class an app extends: the engine's base model plus the builder statics (`orm()`, `ormCreate()`,
 * `ormUpdate()`).
 *
 * It declares no columns — an app's own base model adds the ones every table has.
 */
export class PlainBaseModel extends OrmModelBase {
    static orm<Model extends OrmModel>(this: Model, client?: OrmQueryable) {
        // The state placeholder is WIDE on purpose: an intersection can only narrow, so a `select(...)` naming a
        // hidden column must not meet an earlier `ColsOf<Model>` slot on the way in.
        const builder = Orm.for(this) as MutateOrm<Model, string, {}, {}, {}>;

        return client ? builder.withClient(client) : builder;
    }

    static ormCreate<Model extends OrmModel>(this: Model, data: OrmCreateData<Model>, options?: { client?: OrmQueryable }) {
        return Orm.create(this, data, options);
    }

    static ormUpdate<Model extends OrmModel>(this: Model, pkValue: number | string, data: OrmUpdateData<Model>, options?: { client?: OrmQueryable }) {
        return Orm.update(this, pkValue, data, options);
    }
}
