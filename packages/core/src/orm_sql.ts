/**
 * MySQL — everything dialect-specific the engine emits, in one place: identifier quoting, the `?` placeholder,
 * `INSERT … ON DUPLICATE KEY UPDATE`, `JSON_OBJECT`/`JSON_ARRAYAGG`/`JSON_ARRAY`, `EXPLAIN`, `NOW()`, the
 * `LIMIT … OFFSET` tail, `[ResultSetHeader, fields]`.
 *
 * The `SELECT`/`WHERE`/`JOIN`/`GROUP BY` assemblers are not here: they are ANSI SQL built from model metadata.
 */

/** `` `name` `` — MySQL quotes an identifier with backticks. */
export const quoteId = (name: string) => `\`${name}\``;

/** `` `a`, `b` `` — an identifier list (an INSERT's columns, an ON DUPLICATE KEY update's). */
export const quoteIds = (names: readonly string[]) => names.map(quoteId).join(', ');

/** `?, ?, ?` — one placeholder per value (mysql2 binds positionally; pg would want `$1`). */
export const placeholders = (count: number) => Array.from({ length: count }).fill('?').join(', ');

/**
 * `` `a` = ?, `b` = ? `` — the SET list of an UPDATE, and of an ON DUPLICATE KEY UPDATE.
 *
 * `valueSqls` writes an expression for a column instead of a bound `?` (`dbRaw('(SELECT COUNT(*) …)')`).
 */
export const assignments = (names: readonly string[], valueSqls?: readonly string[]) => names.map((name, i) => `${quoteId(name)} = ${valueSqls?.[i] ?? '?'}`).join(', ');

/** `(?, (SELECT …))` — the VALUES list, one expression per column (see `assignments`). */
export const valuesList = (expressions: readonly string[]) => expressions.join(', ');

/** `INSERT INTO `t` (`a`, `b`) VALUES (?, ?)` */
export const insertSql = (table: string, columns: readonly string[], useIgnore: boolean, valueSqls?: readonly string[]) =>
    `INSERT ${useIgnore ? 'IGNORE ' : ''}INTO ${quoteId(table)} (${quoteIds(columns)}) VALUES (${valueSqls ? valuesList(valueSqls) : placeholders(columns.length)})`;

/**
 * `INSERT INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)` — several rows in one statement, one tuple each.
 *
 * The columns are stated once, so every tuple must carry the same number of expressions in the same order.
 */
export const insertManySql = (table: string, columns: readonly string[], tuples: readonly string[], useIgnore: boolean) =>
    `INSERT ${useIgnore ? 'IGNORE ' : ''}INTO ${quoteId(table)} (${quoteIds(columns)}) VALUES ${tuples.join(', ')}`;
/** `INSERT INTO `t` (`a`, `b`) SELECT …` — the rows come from a query instead of a VALUES list. */
export const insertSelectSql = (table: string, columns: readonly string[], useIgnore: boolean, selectSql: string) =>
    `INSERT ${useIgnore ? 'IGNORE ' : ''}INTO ${quoteId(table)} (${quoteIds(columns)}) ${selectSql}`;
/** `REPLACE INTO `t` (`a`, `b`) VALUES (?, ?)` */
export const replaceIntoSql = (table: string, columns: readonly string[], valueSqls?: readonly string[]) =>
    `REPLACE INTO ${quoteId(table)} (${quoteIds(columns)}) VALUES (${valueSqls ? valuesList(valueSqls) : placeholders(columns.length)})`;

/** `UPDATE `t` SET `a` = ?, `b` = ?` — the SET half; the WHERE is compiled by the builder (bulk update). */
export const updateSetSql = (table: string, columns: readonly string[], valueSqls?: readonly string[]) => `UPDATE ${quoteId(table)} SET ${assignments(columns, valueSqls)}`;

/** `UPDATE `t` SET `a` = ?, `b` = ? WHERE `pk` = ?` */
export const updateSql = (table: string, columns: readonly string[], primaryKey: string, valueSqls?: readonly string[]) =>
    `${updateSetSql(table, columns, valueSqls)} WHERE ${quoteId(primaryKey)} = ?`;

/** The tail of an upsert: ` ON DUPLICATE KEY UPDATE `a` = ?` */
export const onDuplicateKeyUpdate = (columns: readonly string[]) => ` ON DUPLICATE KEY UPDATE ${assignments(columns)}`;

/** `DELETE FROM `t`` */
export const deleteSql = (table: string) => `DELETE FROM ${quoteId(table)}`;

/** `EXPLAIN <sql>` — the plan of a compiled query, for validating joins/subqueries. */
export const explainSql = (sql: string) => `EXPLAIN ${sql}`;

/** The session flag MySQL checks foreign keys by — see `Orm.transaction({ disableForeignKeyChecks: true })`. */
export const foreignKeyChecksSql = (enabled: boolean) => `SET SESSION FOREIGN_KEY_CHECKS=${enabled ? 1 : 0}`;

/** `JSON_OBJECT('k', v, …)` — MySQL's row-to-JSON constructor, used to nest a preload's rows. */
export const jsonObject = (pairs: readonly string[]) => `JSON_OBJECT(${pairs.join(', ')})`;

/** `COALESCE(JSON_ARRAYAGG(<json>), JSON_ARRAY())` — a to-many preload: its rows as JSON, `[]` if none. */
export const jsonArrayAggregate = (json: string) => `COALESCE(JSON_ARRAYAGG(${json}), JSON_ARRAY())`;

/** ` LIMIT n [OFFSET m]` — MySQL's tail form (an offset without a limit is not a thing here). */
export const limitOffset = (limit?: number, offset?: number) => `${limit ? ` LIMIT ${limit}` : ''}${offset ? ` OFFSET ${offset}` : ''}`;

/** mysql2 hands back `[ResultSetHeader, fields]`; that header carries `affectedRows`/`insertId`. */
export function resultHeader(result: unknown): { affectedRows?: number; insertId?: number } {
    const header = Array.isArray(result) ? result[0] : result;
    return (header ?? {}) as { affectedRows?: number; insertId?: number };
}
