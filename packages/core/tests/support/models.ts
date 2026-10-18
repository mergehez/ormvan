/**
 * Example models for the engine's own tests — the shapes both hosts have, so a generic test can be written once
 * here instead of twice in the hosts.
 */
import { belongsTo, column, defaultSoftDelete, hasMany, PlainBaseModel, SoftDeletes, softDeleteScopes } from '../../src/index.js';
import type { OrmModel } from '../../src/orm_model_contract.js';
import type { BelongsTo, HasMany } from '../../src/orm_relations.js';

/** What the hosts' `dt.unix()` gives the stamping helpers. */
export const now = () => Math.floor(Date.now() / 1000);

/** An `id`-keyed model with no timestamps. */
export class MyBaseModel extends PlainBaseModel {
    @column({ isPrimary: true }) declare id: number;
}

/** A model with no `id` at all — its primary key is whatever the subclass declares. */
export class MyKeyedBaseModel extends PlainBaseModel {}

export class MyBaseModelWithCreatedAt extends MyBaseModel {
    @column() declare created_at: number;
    @column() declare created_by: number;

    @belongsTo(() => User, { foreignKey: 'created_by' })
    declare creator: BelongsTo<typeof User>;
}

export class MyBaseModelWithUpdatedAt extends MyBaseModelWithCreatedAt {
    @column() declare updated_at: number;
    @column() declare updated_by?: number | null;

    @belongsTo(() => User, { foreignKey: 'updated_by' })
    declare updater: BelongsTo<typeof User>;

    public setUpdateValues(userId?: number | null) {
        this.updated_at = now();
        this.updated_by = userId ?? null;
    }
}

export class MyBaseModelSoftDeletable extends SoftDeletes(MyBaseModelWithUpdatedAt) {
    @column() declare deleted_at: number | null;
    @column() declare deleted_by: number | null;

    @belongsTo(() => User, { foreignKey: 'deleted_by' })
    declare deleter: BelongsTo<typeof User>;

    public setDeletedValues(userId?: number | null) {
        this.deleted_at = now();
        this.deleted_by = userId ?? null;
    }
}

export class MyBaseModelSoftDeletableNoUpdate extends MyBaseModelWithCreatedAt {
    /**
     * The config-only opt-in: the engine reads this and nothing else infers a soft delete. The chain methods are
     * scopes, so this route takes them by hand — `SoftDeletes(Base)` installs all four.
     */
    static softDelete = defaultSoftDelete;
    static withTrashed = softDeleteScopes.withTrashed;
    static ignoreSoftDeleteGuard = softDeleteScopes.ignoreSoftDeleteGuard;
    static restore = softDeleteScopes.restore;
    static forceDelete = softDeleteScopes.forceDelete;

    @column() declare deleted_at: number | null;
    @column() declare deleted_by: number | null;

    @belongsTo(() => User, { foreignKey: 'deleted_by' })
    declare deleter: BelongsTo<typeof User>;
}

/** Hidden columns: three, including a legacy `password_sha`. */
export class User extends MyBaseModelSoftDeletable {
    static table = 'users';

    /** Never selected unless a query opts in with `.withHidden()`. */
    static readonly hiddenColumns = ['password', 'password_sha', 'remember_token'] as const;

    @column() declare username: string;
    @column() declare name: string;
    @column() declare email: string;
    @column() declare avatar: string | null;
    @column() declare last_seen_at: number | null;

    @column() declare password: string;
    @column() declare password_sha: string | null;
    @column() declare remember_token: string | null;

    @hasMany(() => ChatMessage, { foreignKey: 'created_by' })
    declare messages: HasMany<typeof ChatMessage>;

    /** A self-referencing audit relation, so a to-many preload has hidden columns on the far side too. */
    @hasMany(() => User, { foreignKey: 'created_by' })
    declare created_users: HasMany<typeof User>;
}

/** One hidden column. */
export class Topic extends MyBaseModelWithCreatedAt {
    static table = 'topics';

    static readonly hiddenColumns = ['mentions'] as const;

    @column() declare title: string;
    @column() declare status: number;
    @column() declare mentions: string | null;
}

/** No hidden columns. */
export class ChatMessage extends MyBaseModelSoftDeletableNoUpdate {
    static table = 'chat_messages';

    @column() declare content: string;
    @column() declare receiver_id: number;
    @column() declare read_at: number | null;
}

/** A model with a string primary key that is not `id` (Laravel's `cache` table). */
export class Cache extends MyKeyedBaseModel {
    static table = 'cache';
    static primaryKey = 'key';

    @column({ isPrimary: true }) declare key: string;
    @column() declare value: string;
    @column() declare expiration: number;
    @column() declare type: number;
}

/**
 * The rateable family: one generic base declares the `target` belongsTo, and each subclass names its own target
 * (`static targetModel = () => Book`). `tests/model_relations.test.ts` covers the resolution.
 */
export interface RateableContract<TTarget extends OrmModel> {
    target_id: number;
    target: BelongsTo<TTarget>;
}

export class MyBaseModelRateable<TTarget extends OrmModel> extends MyBaseModel implements RateableContract<TTarget> {
    static targetModel: () => OrmModel;

    @column() declare target_id: number;

    @belongsTo(
        function (this: { model: { targetModel: () => TTarget } }): TTarget {
            return this.model.targetModel();
        },
        { foreignKey: 'target_id' }
    )
    declare target: BelongsTo<TTarget>;
}

/** Rates a topic. */
export class TopicRating extends MyBaseModelRateable<typeof Topic> {
    static table = 'topic_ratings';
    static targetModel = () => Topic;

    @column() declare value: number;
}

/** Rates a user — the same base, a different target. */
export class UserRating extends MyBaseModelRateable<typeof User> {
    static table = 'user_ratings';
    static targetModel = () => User;

    @column() declare value: number;
}
