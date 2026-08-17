import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';

/**
 * Cleanup script to remove old email records after 5 days
 * This should be run as a scheduled job (cron) daily
 */
const cleanupExpiredMigrations = async (): Promise<void> => {
    try {
        await connectDatabase();
        console.log('✅ Connected to PostgreSQL');

        const now = new Date();
        const expiredUsers = await User.find({
            migrationExpiry: { $exists: true, $lt: now },
            previousEmail: { $exists: true, $ne: null }
        });

        console.log(`📊 Found ${expiredUsers.length} user(s) with expired migration periods`);

        if (expiredUsers.length === 0) {
            console.log('✅ No expired migrations to clean up');
            await disconnectDatabase();
            process.exit(0);
        }

        let cleanedCount = 0;
        for (const user of expiredUsers) {
            console.log(`\n🧹 Cleaning up user: ${user.email}`);
            console.log(`   Previous email: ${user.previousEmail}`);
            console.log(`   Migration expiry: ${user.migrationExpiry}`);

            user.previousEmail = undefined;
            user.migrationExpiry = undefined;
            await user.save();

            cleanedCount++;
            console.log(`   ✅ Cleaned up`);
        }

        console.log(`\n✅ Cleanup completed!`);
        console.log(`   Cleaned ${cleanedCount} user(s)`);

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

cleanupExpiredMigrations();