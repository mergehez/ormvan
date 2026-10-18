import type { ColsOf, HiddenOf, RowOf } from './orm_builder.ts';
import { OrmModel } from './orm_model_contract.ts';
import { visibleColumns } from './orm_serialization.ts';
import type { SqlValue } from './orm_where.ts';

// Raw SQL with a typed alias: `sqlAs('(SELECT COUNT(*) ...)', 'answers_count', 0)`
// → SQL `(SELECT COUNT(*) ...) AS answers_count`; the row type gains `answers_count: number`.
export type RawAsExpr<As extends string, Type> = { sql: string; as: As; type: Type };

/** One selectable item: all columns, `*`, a raw expression, or a typed alias. */
export type SelectItem<X extends OrmModel> =
    | '*'
    | ColsOf<X>
    | HiddenOf<X> // hidden columns may be named explicitly — naming them IS the opt-in
    | `distinct ${ColsOf<X>}`
    | `${ColsOf<X> | (string & {})} as ${string}`
    | `${number} as ${string}` // `'1 as answers_count'` — a numeric literal alias
    | `${boolean} as ${string}` // `'true as is_x'` — a boolean literal alias
    | { sql: `${string}.*`; bindings?: readonly unknown[] } // wildcard select (`chat_messages.*`) keeps base columns in the inferred row type
    | SqlValue // a raw select expression with optional bindings — the same raw value `where` takes (`dbRaw(...)`, `q.ref(...)`, `countSql()`)
    | { column: ColsOf<X>; as: string } // `colAs('id', 'target_id')` → `id AS target_id` gains `target_id` with the source column's type
    | RawAsExpr<string, unknown>;

// Element type of a collection generic (avoids `C[number]`, which TS forbids on type params)
type ElemOf<C> = C extends readonly (infer E)[] ? E : never;
// Removes a `distinct ` prefix from a string select item: `'distinct user_id'` → `'user_id'`
type StripDistinct<S> = S extends `distinct ${infer Col}` ? Col : S;
// String columns a select call contributes (raw exprs / `*` / aliases contribute nothing)
type SelectColsOf<C> = Exclude<Extract<ElemOf<C>, string>, '*' | `${string} as ${string}`>;
// Whether a select call includes an all-columns wildcard, either `*` or a raw `table.*` fragment.
type HasWildcardSelect<C> = Extract<ElemOf<C>, '*' | { sql: `${string}.*` }> extends never ? false : true;
// Column keys actually selected; empty → all columns
type SelectedCols<X extends OrmModel, C> = [C] extends [readonly []]
    ? ColsOf<X>
    : [SelectColsOf<C>] extends [never]
      ? HasWildcardSelect<C> extends true
          ? ColsOf<X>
          : never
      : NewCols<X, C>;
// Normalize an alias item into `{ as, value }`:
//  - `colAs('id', 'target_id')` / `'id as target_id'` → the source column's type
//  - `'1 as answers_count'` / `'true as is_x'`       → number / boolean
//  - `sqlAs('(SELECT ...)', 'x', 0)`                 → the anchored type (from the example value)
//  - `{ sql, as: 'x' }` (bare raw alias)             → unknown
// Non-aliases → never (dropped).
type AliasParts<X extends OrmModel, Item> = Item extends { column: infer Col; as: infer As }
    ? { as: As; value: RowOf<X>[Col & keyof RowOf<X>] }
    : Item extends { sql: string; as: infer As; type: infer T }
      ? { as: As; value: T }
      : Item extends { sql: string; as: infer As }
        ? { as: As; value: unknown }
        : Item extends `${infer Col} as ${infer As}`
          ? { as: As; value: Col extends `${number}` ? number : Lowercase<Col> extends 'true' | 'false' ? boolean : RowOf<X>[Col & keyof RowOf<X>] }
          : never;
// Alias key (the `as` name) of one select item — `{ as }` objects or `'col as alias'` strings;
// non-aliases → never (dropped)
type AliasKeyOf<Item> = Item extends { as: infer As } ? (As extends string ? As : never) : Item extends `${infer _Col} as ${infer As}` ? As : never;
// The `as` aliases contributed to the row type: `{ [alias]: value-type }`
type SelectedAs<X extends OrmModel, C> = {
    [Item in ElemOf<C> as AliasKeyOf<Item>]: AliasParts<X, Item> extends { value: infer V } ? V : never;
};
// Whether two types are identical (mutually assignable)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Column keys a select call contributes (aliases / `*` contribute nothing).
type NewCols<X extends OrmModel, C> = HasWildcardSelect<C> extends true ? ColsOf<X> : StripDistinct<SelectColsOf<C>> & (ColsOf<X> | HiddenOf<X>);

/** The new selected-columns type after a `select(...)` call (for the builder's `TSelected`). */
export type SelectSelected<X extends OrmModel, TSelected extends string, C> =
    Same<TSelected, ColsOf<X>> extends true ? SelectedCols<X, C> & string : TSelected | (NewCols<X, C> & string);
/** The new extras (aliases) type after a `select(...)` call (for the builder's `TExtras`). */
export type SelectExtras<X extends OrmModel, C> = SelectedAs<X, C>;

/** The ORM-specific behaviors the select engine needs but cannot provide itself. */
export interface OrmSelectDeps {
    tableName: () => string;
}

/** The select engine: owns the `selectCols` array + the runtime compilation. */
export class OrmSelect {
    private cols: { sql: string; bindings: any[] }[] = [];

    public constructor(public deps: OrmSelectDeps) {}

    /** The recorded select fragments (owned by this engine). */
    public all(): { sql: string; bindings: any[] }[] {
        return this.cols;
    }

    /** The `as` name of each recorded fragment, in order (`undefined` where an item has no alias) — see `OrmBuilder.selectedAliases`. */
    public aliases(): (string | undefined)[] {
        return this.cols.map((c) => /\sAS\s+([^\s,]+)\s*$/i.exec(c.sql)?.[1]);
    }

    /** Replaces the whole select list (used when re-hydrating a captured sub-builder). */
    public replaceAll(cols: { sql: string; bindings: any[] }[]): void {
        this.cols = [...cols];
    }

    /**
     * The default select fragment when no explicit selection was made: the model's visible
     * columns (declared columns minus `static hiddenColumns`) plus any column opted in via
     * `withHidden(...)`. Falls back to `<table>.*`.
     */
    public defaultFragment(model?: OrmModel, extraColumns: readonly string[] = []): string {
        const tableName = this.deps.tableName();
        const visible = model ? visibleColumns(model) : [];
        if (visible.length === 0) return `${tableName}.*`;
        return [...visible, ...extraColumns].map((column) => `${tableName}.` + '`' + column + '`').join(', ');
    }

    /** All bindings across the recorded select fragments, in order. */
    public bindings(): any[] {
        return this.cols.flatMap((c) => c.bindings);
    }

    /** The SELECT list (comma-joined fragments), or the model's visible columns when empty. */
    public selectList(model?: OrmModel, extraColumns: readonly string[] = []): string {
        return this.cols.length ? this.cols.map((c) => c.sql).join(', ') : this.defaultFragment(model, extraColumns);
    }

    /**
     * Compiles a `select(...)` call into `{ sql, bindings }` fragments (replace on the first call, append on
     * chained ones, reset to all-columns on `select()` / `select('*')`).
     */
    public select<X extends OrmModel>(tableName: string, ...cols: Array<SelectItem<X>>): void {
        const items = cols as Array<SelectItem<X>>;
        const flat: Array<SelectItem<X>> = items.length === 1 && Array.isArray(items[0]) ? (items[0] as Array<SelectItem<X>>) : items;
        const newCols =
            flat.length === 0 || (flat.length === 1 && flat[0] === '*')
                ? []
                : flat.map((c) => {
                      if (typeof c === 'string') {
                          const asIdx = c.indexOf(' as ');
                          if (asIdx !== -1) {
                              const col = c.slice(0, asIdx);
                              const alias = c.slice(asIdx + 4);
                              // `1 as x` / `true as x` are literals; anything else is a column to qualify.
                              const colSql = /^\d+$/.test(col) || /^(true|false)$/i.test(col) ? col : `${tableName}.${col}`;
                              return { sql: `${colSql} AS ${alias}`, bindings: [] };
                          }
                          // `distinct <col>` → `DISTINCT table.<col>` (SQL DISTINCT applies to the select list)
                          const distinct = c.startsWith('distinct ');
                          const col = distinct ? c.slice('distinct '.length) : c;
                          return { sql: `${distinct ? 'DISTINCT ' : ''}${tableName}.${col}`, bindings: [] };
                      }
                      if ('column' in c) return { sql: `${tableName}.${c.column} AS ${c.as}`, bindings: [] };
                      if ('as' in c) return { sql: `${c.sql} AS ${c.as}`, bindings: [] }; // sqlAs
                      return { sql: c.sql, bindings: [...(c.bindings ?? [])] };
                  });

        if (newCols.length === 0) {
            this.cols = []; // explicit `select('*')` / `select()` → all columns
        } else if (this.cols.length === 0) {
            this.cols = newCols; // no prior explicit selection → replace
        } else {
            this.cols = [...this.cols, ...newCols]; // chained select → accumulate
        }
    }
}
