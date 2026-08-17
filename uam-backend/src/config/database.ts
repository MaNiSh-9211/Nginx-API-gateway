import { pool } from '../db/client';
import { runMigrations, startTtlSweeper } from '../db/migrations';
import { backfillIdentityIndexes } from '../services/identity-index.service';
import { config } from './index';

let ttlSweeper: NodeJS.Timeout | null = null;

export const connectDatabase = async (): Promise<void> => {
    try {
        await pool.query('SELECT 1');
        console.log(
            `✅ PostgreSQL connected (pool max=${config.postgres.pool.max})`,
        );

        await runMigrations();

        // Best-effort identity-index backfill from User rows (safe on boot).
        try {
            const { scanned, synced } = await backfillIdentityIndexes();
            if (scanned > 0) {
                console.log(`✅ Identity index backfill: ${synced}/${scanned} users`);
            }
        } catch (err) {
            console.warn('Identity index backfill skipped:', (err as Error).message);
        }

        ttlSweeper = startTtlSweeper();
    } catch (error) {
        console.error('❌ PostgreSQL connection error:', error);
        process.exit(1);
    }
};

export const disconnectDatabase = async (): Promise<void> => {
    if (ttlSweeper) {
        clearInterval(ttlSweeper);
        ttlSweeper = null;
    }
    await pool.end();
    console.log('PostgreSQL pool closed');
};

/** Readiness probe — verifies the pool can serve a command. */
export const pingDatabase = async (): Promise<boolean> => {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch {
        return false;
    }
};