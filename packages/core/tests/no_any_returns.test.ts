/**
 * Nothing in the engine's public surface may hand back `any`. The assertions below walk a builder's members and the
 * class statics an app calls, and name the ones whose return type is `any`.
 */
import { test } from '@japa/runner';
import { Orm, PlainBaseModel, colAs, column, dbRaw, scope, sqlAs, type ModelBuilder } from '../src/index.js';
import { User } from './support/models.js';

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** Names of the members of `B` that are callable and whose return type is `any`. */
type AnyReturning<B> = {
    [K in keyof B]-?: B[K] extends (...args: never[]) => infer R ? (IsAny<R> extends true ? K : never) : never;
}[keyof B];

/** `true`, or the offending member names — so a failure says *which* method regressed. */
type NoAnyReturns<B> = AnyReturning<B> extends never ? true : `returns any: ${AnyReturning<B> & string}`;

class ScopedUser extends PlainBaseModel {
    static table = 'users';

    @column() declare id: number;
    @column() declare name: string;

    /** A filter scope, so the check also covers a chain carrying scope methods. */
    static named = scope((b: ModelBuilder<typeof ScopedUser>, name: string) => b.where('name', name));
}

const id: any = 1;

const builder = User.orm();
const chained = User.orm().withTrashed().withHidden('password').where('id', id).whereIn('id', [id]).limit(1).orderBy('id');
const withScope = ScopedUser.orm().named('x').where('id', 1);

export type BuilderReturnsNoAny = Expect<Equal<NoAnyReturns<typeof builder>, true>>;
export type ChainedReturnsNoAny = Expect<Equal<NoAnyReturns<typeof chained>, true>>;
export type ScopedReturnsNoAny = Expect<Equal<NoAnyReturns<typeof withScope>, true>>;

/** The statics an app calls directly — `Orm.runQuery(...)`, `Orm.create(...)`, `Orm.transaction(...)`. */
export type OrmStaticsReturnNoAny = Expect<Equal<NoAnyReturns<typeof Orm>, true>>;

/** The raw-value helpers return plain objects, not `any`. */
export type RawHelpersReturnNoAny = Expect<Equal<IsAny<ReturnType<typeof dbRaw>>, false>>;
export type TypedAliasReturnsNoAny = Expect<Equal<IsAny<ReturnType<typeof sqlAs>>, false>>;
export type ColumnAliasReturnsNoAny = Expect<Equal<IsAny<ReturnType<typeof colAs>>, false>>;
export type ScopeHelperReturnsNoAny = Expect<Equal<IsAny<ReturnType<typeof scope>>, false>>;

test.group('no any', () => {
    test('the checks above are compiled, and the chains they name still work', ({ assert }) => {
        assert.isFunction(builder.where);
        assert.isFunction(builder.limit);
        assert.isFunction(withScope.where);
        assert.isString(withScope.toSQL().sql);
    });
});

/**
 * A terminal whose ROW type collapses is the same bug: both are asserted to keep the model's columns.
 */
type RowOfTerminal<Q> = NonNullable<Awaited<Q>>;
type FirstRow = RowOfTerminal<ReturnType<typeof builder.first>>;
type FailRow = RowOfTerminal<ReturnType<typeof builder.firstOrFail>>;
type Rows = Awaited<ReturnType<typeof builder.get>>;

export type FirstRowIsNotAny = Expect<Equal<IsAny<FirstRow>, false>>;
export type FirstOrFailRowIsNotAny = Expect<Equal<IsAny<FailRow>, false>>;
export type RowsAreNotAny = Expect<Equal<IsAny<Rows[number]>, false>>;

/** …and the row still names the model's columns (`{}` would pass an `any` check). */
export type FirstRowKeepsColumns = Expect<Equal<'id' extends keyof FirstRow ? true : false, true>>;
export type FirstRowKeepsMoreColumns = Expect<Equal<'username' extends keyof FirstRow ? true : false, true>>;
const selected = User.orm().select('id');
export type SelectedRowNarrows = Expect<Equal<keyof RowOfTerminal<ReturnType<typeof selected.first>>, 'id'>>;

/** The engine's own model statics are typed too (`Model.orm()`, `Model.ormCreate()`). */
export type ModelOrmReturnsNoAny = Expect<Equal<IsAny<ReturnType<typeof User.orm>>, false>>;
export type ModelOrmCreateReturnsNoAny = Expect<Equal<IsAny<ReturnType<typeof User.ormCreate>>, false>>;

/** Raw statements say `unknown` on purpose (the caller names the row), never `any`. */
export type RunExecIsNotAny = Expect<Equal<IsAny<ReturnType<typeof Orm.runExec>>, false>>;
export type RunQueryRowIsNotAny = Expect<Equal<IsAny<Awaited<ReturnType<typeof Orm.runQuery>>[number]>, false>>;
