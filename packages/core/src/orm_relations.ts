/** Relations declared by the engine: one decorator per property. */
import type { OrmModel } from './orm_model_contract.ts';

/**
 * What a relation PROPERTY on a model looks like to the engine's types: the related model, the `subQuery` marker
 * `RelationKeys<T>` detects it by, and whether it is to-many. A model only ever DECLARES one, never assigns it.
 */
export interface OrmRelationProxy<M extends OrmModel> {
    relatedModel: () => M;
    subQuery: unknown;
}

/** A to-many relation (`hasMany`, `hasManyThrough`, `manyToMany`). */
export interface OrmToManyRelation<M extends OrmModel> extends OrmRelationProxy<M> {
    readonly __toMany: true;
}

/** A to-one relation (`hasOne`, `belongsTo`). */
export interface OrmToOneRelation<M extends OrmModel> extends OrmRelationProxy<M> {
    readonly __toMany?: false;
}

/** `declare entries: HasMany<typeof Entry>` */
export type HasMany<M extends OrmModel> = OrmToManyRelation<M>;
/** `declare entries: HasManyThrough<typeof EntryRating, typeof Entry>` */
export type HasManyThrough<M extends OrmModel, Through extends OrmModel = OrmModel> = OrmToManyRelation<M> & {
    throughModel?: () => Through;
};
/** `declare topics: ManyToMany<typeof Topic>` */
export type ManyToMany<M extends OrmModel> = OrmToManyRelation<M>;
/** `declare detail: HasOne<typeof UserDetail>` */
export type HasOne<M extends OrmModel> = OrmToOneRelation<M>;
/** `declare creator: BelongsTo<typeof User>` */
export type BelongsTo<M extends OrmModel> = OrmToOneRelation<M>;

/**
 * What the engine READS off a relation at runtime — the shape `getRelationFor` hands to the readers.
 */
export interface OrmRelationReader {
    readonly type: OrmRelationType;
    readonly relationName: string;
    readonly options: OrmRelationOptions;
    booted?: boolean;
    /** Called directly by the key readers (they boot lazily and derive keys from the schema). */
    boot(): void;
    /** Bound when the relation is looked up for a concrete model; a relation callback may read it. */
    model?: OrmModel;
    relatedModel: () => OrmModel;
    /** The middle model of a through relation — absent for every other kind, and for one whose factory needs code
     * that is not loaded yet. */
    throughModel?: () => OrmModel | undefined;
    /** Resolved during boot; the readers fall back to `options` when absent. */
    localKeyColumnName?: string;
    foreignKeyColumnName?: string;
    relatedKeyColumnName?: string;
    throughLocalKeyColumnName?: string;
    throughForeignKeyColumnName?: string;
    pivotTable?: string;
    /** The same keys in their unresolved form — the readers' fallback when nothing resolved them. */
    localKey?: string;
    foreignKey?: string;
    relatedKey?: string;
    throughLocalKey?: string;
    throughForeignKey?: string;
    pivotForeignKey?: string;
    pivotRelatedForeignKey?: string;
}

/** The runtime relation contract, under the name the readers use. */
export type OrmRelationContract = OrmRelationReader;

/** The relation kinds the engine understands. */
export type OrmRelationType = 'belongsTo' | 'hasOne' | 'hasMany' | 'hasManyThrough' | 'manyToMany';

/** The keys a relation may declare. The readers fall back per key, so none of them is required. */
export interface OrmRelationOptions {
    localKey?: string;
    foreignKey?: string;
    relatedKey?: string;
    throughLocalKey?: string;
    throughForeignKey?: string;
    pivotTable?: string;
    pivotForeignKey?: string;
    pivotRelatedForeignKey?: string;
    /** The through model factory, when a through relation declares it as an option rather than positionally. */
    throughModel?: () => OrmModel;
    /** Applied to the sub-builder of a preload/count/whereHas (`q.where('entries.status', …)`). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onQuery?: (query: any) => void;
}

/** What the engine reads off a relation. */
export class OrmRelation {
    booted = false;

    /**
     * The parent model, filled in when the relation is looked up for a concrete model, so a relation callback may
     * read it: `function () { return this.model.targetModel() }`.
     */
    model?: OrmModel;

    readonly #related: () => OrmModel;
    readonly #through: (() => OrmModel) | undefined;

    constructor(
        readonly type: OrmRelationType,
        readonly relationName: string,
        related: () => OrmModel,
        readonly options: OrmRelationOptions = {},
        through?: () => OrmModel
    ) {
        this.#related = related;
        this.#through = through;
    }

    /**
     * A copy of this relation bound to a concrete model. Required: a relation declared on a BASE class is ONE
     * instance shared by every subclass, each with its own `static targetModel`.
     */
    forModel(model: OrmModel): OrmRelation {
        const copy = new OrmRelation(this.type, this.relationName, this.#related, { ...this.options }, this.#through);
        copy.model = model;
        copy.booted = this.booted;
        return copy;
    }

    /**
     * The model on the far side. Boots it first: `table` is often not a literal, and a relation read before boot
     * would hand out a model with `table === undefined`.
     */
    relatedModel(): OrmModel {
        // Called on the relation (`this`): a callback that reads `this.model` needs the receiver.
        const model = this.#related.call(this);
        bootModel(model);
        return model;
    }

    /** The middle model of a `hasManyThrough`, when there is one — booted for the same reason. */
    throughModel(): OrmModel | undefined {
        const model = this.#through?.();
        bootModel(model);
        return model;
    }

    /** The readers boot a relation before deriving keys; nothing has to happen here. */
    boot(): void {
        this.booted = true;
    }

    // The keys the readers may look for first (`localKeyColumnName ?? localKey ?? …`). Nothing derives a
    // different column name, so they resolve to the declared key — present so a reader finds a value.
    get localKey(): string | undefined {
        return this.options.localKey;
    }

    get localKeyColumnName(): string | undefined {
        return this.options.localKey;
    }

    get foreignKey(): string | undefined {
        return this.options.foreignKey;
    }

    get foreignKeyColumnName(): string | undefined {
        return this.options.foreignKey;
    }

    get relatedKey(): string | undefined {
        return this.options.relatedKey;
    }

    get relatedKeyColumnName(): string | undefined {
        return this.options.relatedKey;
    }

    get throughLocalKey(): string | undefined {
        return this.options.throughLocalKey;
    }

    get throughLocalKeyColumnName(): string | undefined {
        return this.options.throughLocalKey;
    }

    get throughForeignKey(): string | undefined {
        return this.options.throughForeignKey;
    }

    get throughForeignKeyColumnName(): string | undefined {
        return this.options.throughForeignKey;
    }

    get pivotTable(): string | undefined {
        return this.options.pivotTable;
    }

    get pivotForeignKey(): string | undefined {
        return this.options.pivotForeignKey;
    }

    get pivotRelatedForeignKey(): string | undefined {
        return this.options.pivotRelatedForeignKey;
    }
}

const relationsByPrototype = new WeakMap<object, Map<string, OrmRelation>>();

/** `boot()` a model if it has not been booted — see `relatedModel()` for why this is not optional. */
function bootModel(model: OrmModel | undefined): void {
    if (!model || model.booted) return;
    try {
        model.boot();
    } catch {
        // A model whose relations reference code that is not loaded yet: its table and columns are
        // registered by then, and those are all a relation needs.
    }
}

function register(prototype: object, relation: OrmRelation): void {
    let relations = relationsByPrototype.get(prototype);
    if (!relations) {
        relations = new Map<string, OrmRelation>();
        relationsByPrototype.set(prototype, relations);
    }
    relations.set(relation.relationName, relation);
}

/** `@belongsTo(() => User, { foreignKey: 'created_by' })` */
export function belongsTo(related: () => OrmModel, options?: OrmRelationOptions): PropertyDecorator {
    return (prototype, key) => register(prototype, new OrmRelation('belongsTo', String(key), related, options));
}

/** `@hasOne(() => User, { foreignKey: 'user_id' })` */
export function hasOne(related: () => OrmModel, options?: OrmRelationOptions): PropertyDecorator {
    return (prototype, key) => register(prototype, new OrmRelation('hasOne', String(key), related, options));
}

/** `@hasMany(() => Entry, { foreignKey: 'topic_id' })` */
export function hasMany(related: () => OrmModel, options?: OrmRelationOptions): PropertyDecorator {
    return (prototype, key) => register(prototype, new OrmRelation('hasMany', String(key), related, options));
}

/**
 * `@hasManyThrough([related, through], options)` — the FIRST factory is the related model, the second the through
 * model:
 *
 * `@hasManyThrough([() => EntryRating, () => Entry], { foreignKey: 'topic_id', throughForeignKey: 'target_id' })`
 */
export function hasManyThrough(relatedAndThrough: [() => OrmModel, () => OrmModel], options?: OrmRelationOptions): PropertyDecorator {
    return (prototype, key) => register(prototype, new OrmRelation('hasManyThrough', String(key), relatedAndThrough[0], options, relatedAndThrough[1]));
}

/** `@manyToMany(() => Topic, { pivotTable: 'user_topic_interactions', localKey: 'id', … })` */
export function manyToMany(related: () => OrmModel, options?: OrmRelationOptions): PropertyDecorator {
    return (prototype, key) => register(prototype, new OrmRelation('manyToMany', String(key), related, options));
}

const relationsCache = new WeakMap<object, Map<string, OrmRelation>>();

/** The relations a model declares, base classes first. */
export function relationsDeclaredByEngine(model: OrmModel): Map<string, OrmRelation> | undefined {
    const cached = relationsCache.get(model);
    if (cached) return cached;

    const chain: object[] = [];
    for (let proto = model.prototype as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        if (relationsByPrototype.has(proto)) chain.unshift(proto);
    }
    if (chain.length === 0) return undefined;

    const merged = new Map<string, OrmRelation>();
    for (const proto of chain) {
        // A per-model copy: a callback like `function () { return this.model.targetModel() }` reads the parent
        // off the relation, so one instance cannot represent several subclasses.
        for (const [name, relation] of relationsByPrototype.get(proto)!) merged.set(name, relation.forModel(model));
    }

    relationsCache.set(model, merged);
    return merged;
}
