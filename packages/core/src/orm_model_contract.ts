/**
 * What a class has to provide to be a model here. The construct signature is what narrows every row type to the
 * model's own columns, and it must not be `abstract`.
 */
import type { OrmModelBase } from './orm_model_base.ts';

/** The statics the engine reads off a model — taken from the engine's own base, so it stays in step. */
type OrmModelStatics = Pick<typeof OrmModelBase, 'boot' | 'booted' | 'table' | 'primaryKey' | 'selfAssignPrimaryKey' | 'namingStrategy' | 'prototype'>;

/**
 * A model class the engine accepts: the statics above and a constructor.
 *
 * The constructor's parameters stay `any[]`, so a model may declare its own.
 */
export type OrmModel = OrmModelStatics & {
    readonly name: string;
} & (new (...args: any[]) => OrmModelBase);
