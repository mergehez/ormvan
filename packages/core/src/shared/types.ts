type AllKeys<T> = T extends any ? keyof T : never;
type ExtractValue<T, K extends PropertyKey> = T extends any ? (K extends keyof T ? T[K] : never) : never;
export type MergeUnion<T> = {
    // Required keys: present in ALL union members (keyof T)
    [K in keyof T]: ExtractValue<T, K>;
} & {
    // Optional keys: present in SOME union members
    [K in Exclude<AllKeys<T>, keyof T>]?: ExtractValue<T, K>;
} extends infer O
    ? // 4. Flatten the intersection of required and optional keys into a single object
      { [K in keyof O]: O[K] }
    : never;

/** A class constructor — what a mixin's base has to be. */
export type Constructor<T, Arguments extends unknown[] = any[]> = new (...args: Arguments) => T;

/**
 * A constructor normalized for a mixin base class. `SoftDeletes(Base)` needs this so `class extends Base` carries
 * Base's statics back out; without it TypeScript narrows a mixin's base to the plain constructor type (issue #37142).
 * The type mirrors the one AdonisJS re-exports from `@poppinss/types`, kept here so core needs no framework package.
 */
export type NormalizeConstructor<T extends Constructor<any>> = Omit<T, 'constructor'> & {
    new (...args: any[]): InstanceType<T>;
};
