import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';

/**
 * Script to clear ALL migration-related data from all users
 * This removes:
 * - previousEmail
 * - migrationExpiry
 * - migrationToken
 * - migrationTokenExpires
 * - newEmailPending
 * - lastMigrationDate
 * - currentEmailVerified
 * - newEmailVerified
 * - currentEmailToken
 * - newEmailToken
 * - lastMigrationEmailSent
 * - migrationHistory
 */
const clearMigrationData = async (): Promise<void> => {
    try {
        await connectDatabase();
        console.log('✅ Connected to PostgreSQL');

        const usersWithMigration = await User.find({
            $or: [
                { previousEmail: { $exists: true, $ne: null } },
                { migrationExpiry: { $exists: true, $ne: null } },
                { migrationToken: { $exists: true, $ne: null } },
                { migrationTokenExpires: { $exists: true, $ne: null } },
                { newEmailPending: { $exists: true, $ne: null } },
                { lastMigrationDate: { $exists: true, $ne: null } },
                { currentEmailVerified: { $exists: true, $ne: null } },
                { newEmailVerified: { $exists: true, $ne: null } },
                { currentEmailToken: { $exists: true, $ne: null } },
                { newEmailToken: { $exists: true, $ne: null } },
                { lastMigrationEmailSent: { $exists: true, $ne: null } },
                { migrationHistory: { $exists: true, $not: { $size: 0 } } }
            ]
        });

        console.log(`📊 Found ${usersWithMigration.length} user(s) with migration data\n`);

        if (usersWithMigration.length === 0) {
            console.log('✅ No migration data to clear');
            await disconnectDatabase();
            process.exit(0);
        }

        let clearedCount = 0;
        for (const user of usersWithMigration) {
            console.log(`🧹 Clearing migration data for user: ${user.email}`);

            if (user.previousEmail) console.log(`   - Previous Email: ${user.previousEmail}`);
            if (user.migrationExpiry) console.log(`   - Migration Expiry: ${user.migrationExpiry}`);
            if (user.newEmailPending) console.log(`   - New Email Pending: ${user.newEmailPending}`);
            if (user.migrationHistory && user.migrationHistory.length > 0) {
                console.log(`   - Migration History: ${user.migrationHistory.length} entry/entries`);
            }

            user.previousEmail = undefined;
            user.migrationExpiry = undefined;
            user.migrationToken = undefined;
            user.migrationTokenExpires = undefined;
            user.newEmailPending = undefined;
            user.lastMigrationDate = undefined;
            user.currentEmailVerified = undefined;
            user.newEmailVerified = undefined;
            user.currentEmailToken = undefined;
            user.newEmailToken = undefined;
            user.lastMigrationEmailSent = undefined;
            user.migrationHistory = undefined;

            await user.save();
            clearedCount++;
            console.log(`   ✅ Migration data cleared\n`);
        }

        console.log(`\n✅ Migration data cleanup completed!`);
        console.log(`   Cleared migration data from ${clearedCount} user(s)`);

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

clearMigrationData();