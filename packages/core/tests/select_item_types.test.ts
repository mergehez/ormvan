/**
 * What `select(...)` accepts, and what it still has to REJECT: the engine's own `dbRaw(...)` compiles as a select
 * item, and everything that is not selectable stays a compile error. These functions exist so `tsc` checks them.
 */
import { colAs, dbRaw, sqlAs } from '../src/index.js';
import { User } from './support/models.js';

function _acceptsTheRawValueShapes() {
    return [
        User.orm().select(dbRaw('COUNT(*)')),
        // `q.ref(...)` and `countSql()` are the same shape — a raw value is a raw value, wherever it is used.
        User.orm().select({ sql: 'COUNT(*) AS total' }),
        User.orm().select({ sql: 'LOWER(name) AS lowered', bindings: [] }),
        User.orm().select('id', 'name'),
        User.orm().select(colAs('id', 'target_id')),
        User.orm().select(sqlAs('COUNT(*)', 'total', 0)),
    ];
}

function _rejectsEverythingElse() {
    // @ts-expect-error a number is not a select item
    User.orm().select(1);

    // @ts-expect-error an object without `sql` is not a raw item
    User.orm().select({ bindings: [] });

    // @ts-expect-error `sql` has to be a string
    User.orm().select({ sql: 1 });

    // @ts-expect-error a builder is not a raw item (it compiles: `.toSQL().sql`)
    User.orm().select(User.orm());

    // @ts-expect-error a column the model does not have
    User.orm().select('nope');

    // @ts-expect-error bindings are an array, not a single value
    User.orm().select({ sql: 'COUNT(*)', bindings: 1 });
}
