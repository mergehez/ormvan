/**
 * A package's command is a *loader*: the kernel calls `getMetaData()` to list commands and `getCommand(metaData)` to
 * get the class. The app registers it where its other commands live (see the block comment on the default export).
 *
 * The command keeps no `@adonisjs/core/services/app` import: the engine resolves that service from its own
 * `node_modules`, so it would answer with an unbooted copy of the framework. `this.app` is the running app.
 */
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { ormConfig } from '@mergehez/ormvan/orm_config';
import { ormMigrator } from '@mergehez/ormvan/orm_migrations';
import '../context.ts';

export default class OrmMigrate extends BaseCommand {
    static commandName = 'orm:migrate';
    static description = "Run the app's migrations (database/migrations)";

    static options: CommandOptions = {
        startApp: true,
    };

    @flags.boolean({ description: 'List what is applied and what is pending, then stop' })
    declare status: boolean;

    @flags.boolean({ description: "Undo the last batch (each migration's `down`)" })
    declare rollback: boolean;

    @flags.string({ description: 'Create a migration with this name' })
    declare make: string;

    @flags.boolean({ description: 'Run the seeder the app configured, after migrating' })
    declare seed: boolean;

    async run(): Promise<void> {
        const migrations = ormConfig().migrations;

        if (!migrations) {
            this.logger.error('Nothing to run: configure `Orm.configure({ migrations: { connection } })` first.');
            this.exitCode = 1;

            return;
        }

        const directory = migrations.directory ?? this.app.makePath('database/migrations');
        const migrator = await ormMigrator({ connection: migrations.connection, directory });

        try {
            if (this.make) {
                this.logger.success(`Created ${await migrator.make(this.make)}`);

                return;
            }

            if (this.status) {
                const { applied, pending } = await migrator.status();

                this.logger.log(`${applied.length} applied, ${pending.length} pending`);
                for (const name of pending) {
                    this.logger.log(`pending: ${name}`);
                }

                return;
            }

            if (this.rollback) {
                const { batch, rolled } = await migrator.rollback();

                this.logger.success(rolled.length === 0 ? 'Nothing to roll back.' : `Rolled back ${rolled.length} migration(s) from batch ${batch}.`);

                return;
            }

            const { batch, ran } = await migrator.latest();

            this.logger.success(ran.length === 0 ? 'Nothing to migrate.' : `Ran ${ran.length} migration(s) in batch ${batch}.`);

            // The app's schema may be built from more than its own files (tables a folder owns): this
            // runs after them and before the seed, so one command builds everything.
            if (migrations.after) await migrations.after();

            if (this.seed && !(await this.runSeed())) {
                return;
            }
        } finally {
            await migrator.destroy();
        }
    }

    /** `--seed` without a configured seeder is a mistake worth naming, not a silent no-op. */
    private async runSeed(): Promise<boolean> {
        const seed = ormConfig().migrations?.seed;

        if (!seed) {
            this.logger.error('No seeder configured: add `seed` to `Orm.configure({ migrations: { … } })`.');
            this.exitCode = 1;

            return false;
        }

        await seed();
        this.logger.success('Seeded.');

        return true;
    }
}

/** The kernel's loader contract. */
export async function getMetaData() {
    return [OrmMigrate.serialize()];
}

/** The kernel's loader contract. */
export async function getCommand(metaData: { commandName: string }) {
    return metaData.commandName === OrmMigrate.commandName ? OrmMigrate : null;
}
