/**
 * The vocabulary a chain's types are written in: columns, relations, rows, scopes, and the arithmetic that turns a
 * chain's state into a row. There is one chain class (`Orm`) and one extension point (a model scope); the surfaces
 * themselves are one class per flavour — see `orm_simple_builder.ts`, `orm_relation_subquery.ts`,
 * `orm_subquery_builder.ts` and `orm_main_query_builder.ts`.
 */
import type { CountQueryBuilder } from './orm_count_query_builder.ts';
import type { Orm } from './orm_engine.ts';
import type { ConvertNullable } from './orm_helpers.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { StateOfModel, WithScopeState } from './orm_rebuild.ts';
import type { RelationSubquery } from './orm_relation_subquery.ts';
import type { RawAsExpr } from './orm_select.ts';
import type { SimpleBuilder } from './orm_simple_builder.ts';
import type { PreloadQueryBuilder } from './orm_subquery_builder.ts';

export type Obj = Record<string, unknown>;

type StringKey<T> = Extract<keyof T, string>;
export type RelationKeys<T> = {
    [K in StringKey<T>]: T[K] extends { subQuery: unknown } ? K : never;
}[StringKey<T>];
// Member keys that are methods (functions) — not columns
type FunctionKeys<T> = {
    [K in StringKey<T>]: T[K] extends Function ? K : never;
}[StringKey<T>];

// Column keys of a row: everything except methods, relation properties, and the base model's own instance member.
// `$primaryKeyValue` is that one member (`orm_model_base.ts`) — an app's auth guard reads it off a user.
// `Omit<…> & { id: number }` rather than a plain `Exclude`: a row type carries a string index signature, so
// excluding keys from a generic `T` would collapse the result to `string`.
export type Cols<T> = Exclude<StringKey<Omit<T, '$primaryKeyValue' | 'id'> & { id: number }>, RelationKeys<T> | FunctionKeys<T>>;

// --- Chainable methods record their effect in the type params, so `get()` returns the exact row shape. ---

export type RowOf<X extends OrmModel> = InstanceType<X>;
/**
 * Columns the model declares in `static hiddenColumns` — never selected unless `.withHidden(...)` asks. The
 * `[H] extends [string]` guard keeps `infer` from stripping every column for a generic `X`.
 */
export type HiddenOf<X extends OrmModel> = X extends { hiddenColumns: readonly (infer H)[] } ? ([H] extends [string] ? H & keyof RowOf<X> : never) : never;
export type ColsOf<X extends OrmModel> = Exclude<Cols<RowOf<X>>, HiddenOf<X>>;
/**
 * Every column the model declares — `ColsOf` with the hidden ones put back. What a clause accepts when the engine
 * writes the column into the SQL itself (`COUNT(DISTINCT col)`, `ref(col)`) or when a predicate may name one: hiding
 * is about the projection and serialization, not about which columns a statement can mention.
 */
export type ModelColumn<X extends OrmModel> = ColsOf<X> | HiddenOf<X>;
/**
 * A column qualified by its table — a joined table in a main query, or the child/parent table inside a subquery:
 * `where('entries.status', …)`. The qualifier cannot be checked, so only the shape is; the where engine passes the
 * name through as written.
 */
export type QualifiedColumn = `${string}.${string}`;
/**
 * The columns a builder's selection names. A slot still holding its class-wide `string` means no `select(...)`
 * narrowed it, i.e. every column — never a bare `string`, which would make a row type pick up relation
 * properties (`TSelected & keyof Row` matches every key).
 */
export type SelectedOf<M extends OrmModel, S> = [string] extends [S] ? ColsOf<M> : S extends string ? S : ColsOf<M>;
export type RelationKeyOf<X extends OrmModel> = RelationKeys<RowOf<X>>;
export type PossiblePreloadKey<X extends OrmModel, Already extends Obj> = Exclude<RelationKeys<RowOf<X>>, keyof Already>;
export type PossibleCountsKey<X extends OrmModel, Already extends Obj> = Exclude<RelationKeys<RowOf<X>>, keyof Already>;

/**
 * A model's row: `OrmRow<typeof User>`. Its methods, `$`-state and relation properties are left out, and so are
 * its hidden columns — `OrmRowWithHidden<typeof User, …>` is the way back in. `Extras` adds what a call site
 * knows about the row beyond its columns (a preload it did, say).
 */
export type OrmRow<TModel extends OrmModel, Extras extends object = {}> = ConvertNullable<Pick<RowOf<TModel>, ColsOf<TModel> & keyof RowOf<TModel>> & Extras>;

// Shared relation ladders: the related model class and the to-many flag, derived structurally from the proxies in
// `orm_relations.ts`. `infer M extends OrmModel` is required — without it a generic `Relation` infers `unknown`.
export type ModelOfRelation<Relation> = Relation extends { relatedModel: () => infer M extends OrmModel } ? M : never;
export type IsToManyRelation<Relation> = Relation extends { readonly __toMany: true } ? true : false;
// Related MODEL class extracted from a relation property type.
export type RelationModelOf<Row, K extends RelationKeys<Row>> = ModelOfRelation<Row[K]>;
// Row type behind a relation property (instance of the related model).
export type RelationRow<Row, K extends RelationKeys<Row>> = InstanceType<RelationModelOf<Row, K>>;

// The related model class behind a relation key (`HasMany<typeof Answer>` → `typeof Answer`).
export type RelatedModel<X extends OrmModel, K extends RelationKeyOf<X>> = RelationModelOf<RowOf<X>, K>;

export type Prettify<T> = T extends object ? { [K in keyof T]: T[K] } : T;

/**
 * A chain class: what a sub-builder is spawned as (`this.constructor`, inherited by every sub-builder), and where
 * the write statics are reached from. There is one, so nothing has to be registered and every rebuild lands in the
 * same class.
 */
export type BuilderCtor = typeof Orm;

/**
 * A builder on `X` in a given state: `Orm` with the state its chain built up, plus the model's scopes. `Stated` is
 * the class-plus-state on its own, because a scope's methods are typed in terms of the builder they were called on —
 * which is what keeps a scope inside the flavour it was called in.
 */
type Stated<X extends OrmModel, S extends string, P extends Obj, C extends Obj, E extends Obj> = Orm<X> & {
    __state?: { selected: S; preloads: P; counts: C; extras: E };
};

/** A builder in a known state — the name apps already use for "the builder with this state". */
export type MutateOrm<X extends OrmModel, NewTSel extends string, NewTPre extends Obj, NewTCnt extends Obj, NewTExt extends Obj> = Stated<X, NewTSel, NewTPre, NewTCnt, NewTExt> &
    ScopeMethods<Stated<X, NewTSel, NewTPre, NewTCnt, NewTExt>>;

/** Marks a static as a scope — see `scope()`. */
export const ORM_SCOPE = Symbol('orm.scope');

/** What `scope()` returns: the function it was handed, plus the marker that makes the chain see it. */
export type OrmScope<F> = F & { [ORM_SCOPE]: true };

/**
 * Declares a model scope: `static withAllRelationships = scope((b: ModelBuilder<typeof Game>, authId?) => …)` is
 * chainable as `Game.orm().withAllRelationships(authId)`. The member key is kept unchanged, so "go to definition"
 * lands on the scope.
 */
export function scope<F>(fn: F): OrmScope<F> {
    (fn as Record<symbol, boolean>)[ORM_SCOPE] = true;
    return fn as OrmScope<F>;
}

/** A model's scope statics — the ones wrapped in `scope(...)`. */
type ScopeNames<X extends OrmModel> = {
    [K in StringKey<X>]: X[K] extends { [ORM_SCOPE]: true } ? K : never;
}[StringKey<X>];

/**
 * The receiver a scope's first parameter asks for. Only its MODEL requirement is kept: a whole builder instantiation
 * (`SubqueryBuilder<SomeModel>`) is never a supertype of a rebuilt chain — the same class with another model argument
 * is a different type — while `{ model: SomeModel }` is exactly the check a scope wants to make.
 */
type ScopeReceiver<Recv> = Recv extends { model: infer M } ? { model: M } : unknown;

type ScopeMethods<B, X extends OrmModel = StateOfModel<B>> = {
    [K in keyof X as K extends ScopeNames<X> ? K : never]: X[K] extends (b: infer Recv, ...args: infer A) => infer R
        ? <T extends B & ScopeReceiver<Recv>>(
              this: T,
              ...args: A
          ) => R extends Promise<unknown>
              ? R // a scope that awaits is a query, not a chain: it must not masquerade as a builder
              : WithScopeState<T, R>
        : never;
};

/** A fresh builder on `X` — the first parameter of a scope (`static ordered = scope((b: ModelBuilder<typeof X>, …) => …)`). */
export type ModelBuilder<X extends OrmModel> = MutateOrm<X, string, {}, {}, {}>;

export type RelationQuery<X extends OrmModel, K extends RelationKeyOf<X>> = RelationSubquery<RelationModelOf<RowOf<X>, K>> &
    ScopeMethods<RelationSubquery<RelationModelOf<RowOf<X>, K>>>;

/**
 * The preload flavour under its original name — `orm_preload.ts` declares the `preloadCb` callback with it, so a
 * host's `(q) => q.paginating(20)` keeps its receiver. `whereHas` uses the narrower `RelationQuery`.
 */
export type RelationBuilder<X extends OrmModel, K extends RelationKeyOf<X>> = PreloadQueryBuilder<RelationModelOf<RowOf<X>, K>> &
    ScopeMethods<PreloadQueryBuilder<RelationModelOf<RowOf<X>, K>>>;

/**
 * The count flavour, as `withCount` / `withCountOrdered` hand it out: `CountQueryBuilder` — a builder that lives
 * beside the chain, so no other flavour offers `.as(...)` and no member is attached to anything at runtime.
 *
 * The signatures name that class DIRECTLY rather than through this alias: an alias adds a resolution step, and a
 * chain whose scope returns a count would then exceed what TS will infer (TS7024 in a host scope).
 */
export type CountQuery<X extends OrmModel, K extends RelationKeyOf<X>> = CountQueryBuilder<RelationModelOf<RowOf<X>, K>>;

/** Typed select alias: `colAs('id', 'target_id')` → SQL `id AS target_id`; the row type gains `target_id` with `id`'s type. */
export const colAs = <Col extends string, As extends string>(column: Col, as: As): { column: Col; as: As } => ({ column, as });
/** Raw SQL with a typed alias — `sqlAs('(SELECT COUNT(*) ...)', 'answers_count', 0)`; the `value` anchors the result type. */
export const sqlAs = <Type, As extends string>(
    sql: string,
    as: As,
    value: Type extends number ? 0 : Type extends string ? '' : Type extends boolean ? true : Type
): RawAsExpr<As, Type> => ({
    sql,
    as,
    type: value as Type,
});

/** The stack frames outside the engine — where a builder was created from. */
export function appOnlyStack(extraSlice = 0) {
    return (
        '-> ' +
        new Error().stack
            ?.split('\n')
            .slice(2 + extraSlice)
            .filter((t) => !t.includes('packages/core/src/') && !t.includes('@mergehez/') && !t.includes('node:internal') && !t.includes('/node_modules/@adonisjs'))
            .map((t) => (t.includes('(') && t.endsWith(')') ? t.slice(t.lastIndexOf('(') + 1, t.length - 1) : t))
            .join('\n -> ')
    );
}

export type OrmBuilder<X extends OrmModel> = SimpleBuilder<X>;

// Final row type: selected columns + preloaded relations + `*_count` + `as` aliases.
export type FastRow<Row, TSelected, TPreloads, TCounts, TExtras> = ConvertNullable<
    Pick<Row, TSelected & keyof Row> & {
        [K in keyof TPreloads]: TPreloads[K];
    } & {
        [K in keyof TCounts]: number;
    } & {
        [K in keyof TExtras]: TExtras[K];
    }
>;
type TypeToString<T> = T extends string ? 'string' : T extends number ? 'number' : T extends boolean ? 'boolean' : T extends object ? 'object' : 'unknown';

/**
 * Final row type for a builder `B`'s *current* derived state (extracted from `this` at the call site).
 */
export type OrmBuilderRow<B> = B extends {
    model: infer M;
    __state?: { selected: infer S; preloads: infer P; counts: infer C; extras: infer E };
    __hidden?: infer Hd;
}
    ? M extends OrmModel
        ? P extends object
            ? C extends object
                ? E extends object
                    ? // Hidden columns are only in a row when `withHidden(...)` opted into them.
                      Omit<FastRow<RowOf<M>, SelectedOf<M, S>, P, C, E>, Exclude<HiddenOf<M>, SelectedOf<M, S> | OptedIn<Hd>>> &
                          ConvertNullable<Pick<RowOf<M>, HiddenOf<M> & (SelectedOf<M, S> | OptedIn<Hd>)>>
                    : `E is not an object but is ${TypeToString<E>}`
                : `C is not an object but is ${TypeToString<C>}`
            : `P is not an object but is ${TypeToString<P>}`
        : `M is not a OrmModel but is ${TypeToString<M>}`
    : `B is not an OrmBuilder but is ${TypeToString<B>}`;

/** The keys a hidden-column opt-in record holds. */
type OptedIn<Hd> = Hd extends object ? keyof Hd & string : never;
