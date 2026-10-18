import type { OrmModel } from './orm_model_contract.ts';
import { SimpleBuilder } from './orm_simple_builder.ts';

/** What a `whereHas` callback is handed. */
export abstract class RelationSubquery<X extends OrmModel> extends SimpleBuilder<X> {}
