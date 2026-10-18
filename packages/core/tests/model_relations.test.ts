/**
 * Relations whose related model is resolved by a factory that reads the declaring class:
 *
 *     @belongsTo(function (this) { return this.model.targetModel() })
 *
 * The callback runs with the relation as its receiver, and it is bound to the subclass that asks —
 * `TopicRating.target` is a topic, `UserRating.target` a user.
 */
import { test } from '@japa/runner';
import { OrmBuilderRow, OrmRow } from '../src/index.ts';
import { Topic, TopicRating, User, UserRating } from './support/models.js';

/** The SQL a chain compiles to, so a spec can say which table a relation resolved to. */
const sqlOf = (chain: { toSQL(): { sql: string } }) => chain.toSQL().sql;

test.group('relations — a factory that reads the declaring model', () => {
    test('preload resolves the target of the subclass that is asking', ({ assert, expectTypeOf }) => {
        const qt = TopicRating.orm().preload('target');
        const qu = UserRating.orm().preload('target');

        // The related row is the related model's own row: its hidden columns are not in it (see the preload
        // projection specs in `hidden_columns.test.ts`).
        expectTypeOf<OrmBuilderRow<typeof qt>>().toExtend<{ target: OrmRow<typeof Topic> }>();
        expectTypeOf<OrmBuilderRow<typeof qu>>().toExtend<{ target: OrmRow<typeof User> }>();

        const topic = qt.toSQL().sql;
        const user = qu.toSQL().sql;

        assert.include(topic, 'FROM topics');
        assert.include(topic, 'topics.id = topic_ratings.target_id');

        assert.include(user, 'FROM users');
        assert.include(user, 'users.id = user_ratings.target_id');
    });

    test('the same relation on two subclasses does not leak the other target', ({ assert }) => {
        const topic = sqlOf(TopicRating.orm().preload('target'));
        const user = sqlOf(UserRating.orm().preload('target'));

        assert.notInclude(topic, 'FROM users');
        assert.notInclude(user, 'FROM topics');
    });

    test('preloadCb — where the parked note came from — compiles too', ({ assert }) => {
        const sql = sqlOf(TopicRating.orm().preloadCb('target', (target) => target.select('id', 'title')));

        assert.include(sql, 'FROM topics');
        assert.include(sql, 'title');
        // The callback narrows the projection, so the columns it did not ask for are gone.
        assert.notInclude(sql, 'mentions');
    });

    test('whereHas and withCount resolve it through the same factory', ({ assert }) => {
        const exists = sqlOf(TopicRating.orm().whereHas('target'));
        const counts = sqlOf(TopicRating.orm().withCount('target'));

        assert.include(exists, 'FROM topics');
        assert.include(counts, 'FROM topics');
        assert.notInclude(exists, 'FROM users');
        assert.notInclude(counts, 'FROM users');
    });

    test('async methods are not accepted in subqueries', ({ assert }) => {
        if (Date.now() > 0) {
            return; // always true, skip the real execution of the test since it is a compile-time type check only
        }
        TopicRating.orm().preloadCb('target', (q) => {
            q.paginating(1);
            // @ts-expect-error
            q.paginate(1);

            // @ts-expect-error
            q.first();

            // @ts-expect-error
            q.get();

            // @ts-expect-error
            q.delete(null);

            // @ts-expect-error
            q.deleteBy(1, null);

            q.select('id');
            // @ts-expect-error
            q.select('id').first();

            q.where('id', 1);
            // @ts-expect-error
            q.where('id', 1).first();

            q.whereHas('creator', (t) => {
                q.select('id');
                // @ts-expect-error
                t.first();

                t.where('id', 1);
                // @ts-expect-error
                t.where('id', 1).first();

                return t;
            });

            return q;
        });
    });
});
