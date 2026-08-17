import { connectDatabase, disconnectDatabase } from '../config/database';
import { pool } from '../db/client';

/**
 * Drops the users and user_identity_indexes tables (dangerous — deletes all data).
 * Replaces the old Mongo "drop users collection" script.
 */
const dropUsersCollection = async (): Promise<void> => {
    try {
        await connectDatabase();
        console.log('✅ Connected to PostgreSQL');

        const tables = ['users', 'user_identity_indexes'];
        console.log('\n📋 Available tables:');
        const { rows } = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' ORDER BY table_name`,
        );
        rows.forEach(r => console.log(`  - ${r.table_name}`));

        let dropped = 0;
        for (const table of tables) {
            const exists = rows.some(r => r.table_name === table);
            if (exists) {
                await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
                console.log(`\n✅ Successfully dropped "${table}" table`);
                dropped += 1;
            } else {
                console.log(`\n⚠️  "${table}" table does not exist`);
            }
        }

        if (dropped === 0) {
            console.log('\n⚠️  No tables dropped.');
        }

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

dropUsersCollection();