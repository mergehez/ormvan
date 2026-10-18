/**
 * The builder a `withCount` / `withCountOrdered` callback is handed: the where family (through `RelationSubquery`),
 * the count alias, and the relation's child model.
 *
 * It sits BESIDE the chain, never in it. The engine spawns one for the callback, so a main chain, a preload callback
 * and a `whereHas` callback cannot reach `.as(...)` — and nothing has to be attached to a builder at runtime to make
 * the count surface exist.
 */
import type { OrmModel } from './orm_model_contract.ts';
import { RelationSubquery } from './orm_relation_subquery.ts';

export class CountQueryBuilder<X extends OrmModel> extends RelationSubquery<X> {
    /** The alias `.as(...)` set — the count column's name, or `null` for the default `<relation>_count`. */
    public countAlias: string | null = null;

    /** Renames the count column; returns the alias so the row type tracks it. */
    public as<A extends string>(alias: A): A {
        this.countAlias = alias;
        return alias;
    }
}
