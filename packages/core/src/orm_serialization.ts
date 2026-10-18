import { modelMeta } from './orm_helpers.ts';
import type { OrmModel } from './orm_model_contract.ts';

/**
 * `omitHidden` is the response boundary: it strips hidden columns from a row that was deliberately fetched *with*
 * them.
 */
const hiddenColumnsCache = new WeakMap<OrmModel, ReadonlySet<string>>();

const EMPTY_COLUMNS: ReadonlySet<string> = new Set();

type ModelWithHidden = OrmModel & { hiddenColumns?: readonly string[] };

/** Columns a model declares in `static hiddenColumns`. */
export function hiddenColumns(model: OrmModel): ReadonlySet<string> {
    let hidden = hiddenColumnsCache.get(model);
    if (hidden) return hidden;

    const declared = (model as ModelWithHidden).hiddenColumns;
    hidden = declared?.length ? new Set(declared) : EMPTY_COLUMNS;
    hiddenColumnsCache.set(model, hidden);
    return hidden;
}

/** Columns a query selects by default: every declared column except the hidden ones. */
export function visibleColumns(model: OrmModel): string[] {
    const hidden = hiddenColumns(model);
    const meta = modelMeta(model);
    // `meta.columns` holds property names; the projection needs the DB columns they map to — they differ
    // only for a column declared with an explicit `columnName`.
    return meta.columns.filter((column) => !hidden.has(column)).map((column) => meta.columnNames.get(column) ?? column);
}

/**
 * The client-facing copy of a row: hidden columns removed, at the response boundary only.
 *
 * Only rows fetched WITH hidden columns (`.withHidden(...)`, an explicit `select('fcm_token')`) change; any other
 * row is returned untouched.
 */
export function omitHidden<T>(model: OrmModel, row: T): T {
    // A list of rows (e.g. `{ users: [...] }`) — strip each entry.
    if (Array.isArray(row)) return row.map((item) => omitHidden(model, item)) as T;

    const hidden = hiddenColumns(model);
    if (hidden.size === 0 || row === null || typeof row !== 'object') return row;

    const source = row as Record<string, unknown>;
    const present = Object.keys(source).filter((key) => hidden.has(key));
    if (present.length === 0) return row;

    const out: Record<string, unknown> = { ...source };
    for (const key of present) delete out[key];
    return out as T;
}
