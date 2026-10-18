/**
 * What `if()` hands back, type-wise: the result is whatever the callback returned, so each branch contributes its
 * own type.
 */
import { test } from '@japa/runner';
import { column } from '../src/index.js';
import type { ColsOf } from '../src/orm_builder.js';
import type { StateOf } from '../src/orm_rebuild.js';
import { MyBaseModel } from './support/models.js';

const { Orm: OrmBuilder } = await import('./support/executor.js');

class FakeTopic extends MyBaseModel {
    static table = 'topics';
    @column() declare title: string;
    @column() declare created_by: number;
}

test.group('if() types', () => {
    test('a callback that filters keeps the receiver', ({ assert, expectTypeOf }) => {
        const b = new OrmBuilder(FakeTopic).if(true, (q) => q.where('id', 1));
        type State = StateOf<typeof b>;

        expectTypeOf(b).toEqualTypeOf(new OrmBuilder(FakeTopic));
        expectTypeOf<State['S']>().toEqualTypeOf<ColsOf<typeof FakeTopic>>();
        assert.isFunction(b.first);
    });

    test('a callback that selects keeps that selection', ({ assert, expectTypeOf }) => {
        const b = new OrmBuilder(FakeTopic).if(true, (q) => q.select('id'));
        type State = StateOf<typeof b>;

        expectTypeOf<State['S']>().toEqualTypeOf<'id'>();
        assert.isFunction(b.first);
    });

    test('an else branch contributes its own type — both states are admitted', ({ assert, expectTypeOf }) => {
        const b = new OrmBuilder(FakeTopic).if(
            true,
            (q) => q.select('id'),
            (q) => q.select('title')
        );
        type State = StateOf<typeof b>;

        expectTypeOf<State['S']>().toEqualTypeOf<'id' | 'title'>();
        assert.isFunction(b.first);
    });

    test('an else branch doing the same thing collapses back to one state', ({ assert, expectTypeOf }) => {
        const b = new OrmBuilder(FakeTopic).if(
            true,
            (q) => q.where('id', 1),
            (q) => q.where('title', 'a')
        );
        type State = StateOf<typeof b>;

        expectTypeOf<State['S']>().toEqualTypeOf<ColsOf<typeof FakeTopic>>();
        assert.isFunction(b.first);
    });
});
