/**
 * The string helpers the engine needs, so `@poppinss/utils` (which brings `@poppinss/string`, and with it
 * `pluralize`, `slugify` and `case-anything`) is not a dependency of the package.
 */

/** `UserBlock` → `user_block`. */
function snakeCase(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase();
}

/** The plural of one lowercase word, by the rules a table name needs. */
function pluralOf(word: string): string {
    // `city` → `cities`, `key` → `keys`; `box`/`class`/`dish`/`quiz` take `es`.
    if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
    if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;

    return `${word}s`;
}

/**
 * The table a model class with no `static table` talks to: `UserBlock` → `user_blocks`. A trailing `Model` is
 * not part of the name (`UserModel` → `users`), since the suffix exists to leave the bare name free for the row
 * type. Only the regular English plural applies — a name the rules get wrong says so with `static table`.
 */
export function tableNameFromModelName(modelName: string): string {
    const name = snakeCase(modelName.replace(/Model$/, ''));
    // Only the last word is inflected: `missing_word` → `missing_words`.
    const word = /([a-z]+)$/.exec(name);
    if (!word) return name;

    return name.slice(0, word.index) + pluralOf(word[1]);
}

