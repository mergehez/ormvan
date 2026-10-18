/**
 * The NestJS adapter for `@mergehez/ormvan`. It is empty for now: the framework-agnostic engine is re-exported so an app
 * can depend on the package before any NestJS-specific wiring exists. What will live here — a module that installs
 * `Orm.configure` from NestJS providers, and whatever NestJS needs of the request context — is not written yet.
 */
export * from '@mergehez/ormvan';
