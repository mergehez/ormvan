import type { Obj, SelectedOf } from './orm_builder.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { SelectExtras, SelectItem, SelectSelected } from './orm_select.ts';
/**
 * What a builder carries right now — the state its chain has built up, read off the receiver.
 *
 * A slot still holding its class-wide `string` means no `select` narrowed it, i.e. every column — never a bare
 * `string`, which would make a row type pick up relation properties (`TSelected & keyof Row` matches every key).
 */
export type StateOf<B> = B extends { __state?: { selected: infer S; preloads: infer P; counts: infer C; extras: infer E }; __hidden?: infer Hd }
    ? {
          S: SelectedOf<StateOfModel<B>, S>;
          P: P extends Obj ? P : {};
          C: C extends Obj ? C : {};
          E: E extends Obj ? E : {};
          H: Hd extends Obj ? Hd : {};
      }
    : { S: string; P: {}; C: {}; E: {}; H: {} };

/** The model class a builder was built on. */
export type StateOfModel<B> = B extends { model: infer M extends OrmModel } ? M : never;

/** The same builder with a new state: same class, same members, a different row. */
type Rebuild<B, S extends string, P extends Obj, C extends Obj, E extends Obj> = B & {
    __state?: { selected: S; preloads: P; counts: C; extras: E };
};

/** `withCount(...)` — the counts the receiver already has, plus the new ones. */
export type WithAddedCounts<B, NewCounts extends Obj> = Rebuild<B, StateOf<B>['S'], StateOf<B>['P'], StateOf<B>['C'] & NewCounts, StateOf<B>['E']>;

/** The count `withCount('comments')` adds by default: `comments_count`. */
export type RelationCount<K extends string> = { [Key in `${K}_count`]: number };

/** The count `withCount('comments', 'total')` adds under the alias the caller named. */
export type AliasCount<A extends string> = { [Key in A]: number };

/** `preload(...)` / `preloadCb(...)` — the preloads the receiver already has, plus the new one. */
export type WithAddedPreloads<B, NewPre extends Obj> = Rebuild<B, StateOf<B>['S'], StateOf<B>['P'] & NewPre, StateOf<B>['C'], StateOf<B>['E']>;

/**
 * A row key that comes from a raw select fragment, not from a named column (`withCountOrdered`). The selection is
 * left alone: a raw fragment names no columns, and narrowing the slot to `never` would make every later `select`
 * unable to widen it back.
 */
export type WithAddedExtras<B, NewExtras extends Obj> = Rebuild<B, StateOf<B>['S'], StateOf<B>['P'], StateOf<B>['C'], StateOf<B>['E'] & NewExtras>;

/**
 * `withHidden(...)` — a hidden column is opted in. Hidden-ness is tracked in its own slot, because it only ever
 * grows: the selection narrows (`select`) while the opt-in accumulates, and an intersection can do exactly that.
 */
export type WithHidden<B, H extends string> = B & { __hidden?: StateOf<B>['H'] & { [K in H]: true } };

/** `select(...)` — the selection is replaced, and the aliases it introduces join the extras. */
export type WithSelect<B, C extends readonly SelectItem<StateOfModel<B>>[]> = Rebuild<
    B,
    SelectSelected<StateOfModel<B>, StateOf<B>['S'], C>,
    StateOf<B>['P'],
    StateOf<B>['C'],
    StateOf<B>['E'] & SelectExtras<StateOfModel<B>, C>
>;

/** The state a scope's own return type declares (`__state` is every builder's phantom). */
type ScopeState<R> = R extends { __state?: { selected: infer Sel; preloads: infer Pre; counts: infer Cnt; extras: infer Ext } }
    ? {
          S: Sel extends string ? Sel : never;
          P: Pre extends Obj ? Pre : {};
          C: Cnt extends Obj ? Cnt : {};
          E: Ext extends Obj ? Ext : {};
      }
    : { S: never; P: {}; C: {}; E: {} };
// Prettify<A & B>
/** A scope's result: the receiver's state merged with the state the scope's return type carries. */
export type WithScopeState<B, R> = Rebuild<
    B,
    StateOf<B>['S'] | ScopeState<R>['S'],
    StateOf<B>['P'] & ScopeState<R>['P'],
    StateOf<B>['C'] & ScopeState<R>['C'],
    StateOf<B>['E'] & ScopeState<R>['E']
>;
