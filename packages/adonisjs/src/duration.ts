/**
 * Duration expressions the session store accepts for a session's age: a number of seconds, or a string such as
 * `'2 hours'`, `'30m'`, `'15s'`. AdonisJS writes a session's age this way, and the parsing is the same one
 * `@lukeed/ms` does, so an app's session config passes straight through.
 */

/** The duration units `@lukeed/ms` accepts. */
const DURATION =
    /^(-?(?:\d+)?\.?\d+) *(m(?:illiseconds?|s(?:ecs?)?))?(s(?:ec(?:onds?|s)?)?)?(m(?:in(?:utes?|s)?)?)?(h(?:ours?|rs?)?)?(d(?:ays?)?)?(w(?:eeks?|ks?)?)?(y(?:ears?|rs?)?)?$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365.25 * DAY;

/** Milliseconds from a number, or from `'2 hours'`, `'30m'`, `'15s'`; `undefined` when it makes no sense. */
function parseMilliseconds(duration: string | number): number | undefined {
    if (typeof duration === 'number') return duration;

    const match = duration.toLowerCase().match(DURATION);
    const value = match ? Number.parseFloat(match[1]) : Number.NaN;
    if (!value) return undefined;

    const [, , milliseconds, seconds, minutes, hours, days, weeks, years] = match!;
    const unit = milliseconds ? 1 : seconds ? SECOND : minutes ? MINUTE : hours ? HOUR : days ? DAY : weeks ? WEEK : years ? YEAR : 1;

    return value * unit;
}

/** The same, in seconds — the unit a session age is stored and reported in. */
export function parseSeconds(duration: string | number): number {
    if (typeof duration === 'number') return duration;

    const milliseconds = parseMilliseconds(duration);
    if (milliseconds === undefined) throw new Error(`Invalid duration expression "${duration}"`);

    return Math.floor(milliseconds / SECOND);
}
