import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';

/**
 * Script to verify that all migration data has been cleared
 */
const verifyMigrationCleared = async (): Promise<void> => {
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
            console.log('✅ SUCCESS: All migration data has been cleared!');
            console.log('   No users have any migration-related fields set.');
        } else {
            console.log('⚠️  WARNING: Some users still have migration data:');
            for (const user of usersWithMigration) {
                console.log(`\n📧 User: ${user.email}`);
                if (user.previousEmail) console.log(`   ❌ Previous Email: ${user.previousEmail}`);
                if (user.migrationExpiry) console.log(`   ❌ Migration Expiry: ${user.migrationExpiry}`);
                if (user.migrationToken) console.log(`   ❌ Migration Token: exists`);
                if (user.migrationTokenExpires) console.log(`   ❌ Migration Token Expires: ${user.migrationTokenExpires}`);
                if (user.newEmailPending) console.log(`   ❌ New Email Pending: ${user.newEmailPending}`);
                if (user.lastMigrationDate) console.log(`   ❌ Last Migration Date: ${user.lastMigrationDate}`);
                if (user.currentEmailVerified !== undefined) console.log(`   ❌ Current Email Verified: ${user.currentEmailVerified}`);
                if (user.newEmailVerified !== undefined) console.log(`   ❌ New Email Verified: ${user.newEmailVerified}`);
                if (user.currentEmailToken) console.log(`   ❌ Current Email Token: exists`);
                if (user.newEmailToken) console.log(`   ❌ New Email Token: exists`);
                if (user.lastMigrationEmailSent) console.log(`   ❌ Last Migration Email Sent: ${user.lastMigrationEmailSent}`);
                if (user.migrationHistory && user.migrationHistory.length > 0) {
                    console.log(`   ❌ Migration History: ${user.migrationHistory.length} entry/entries`);
                }
            }
        }

        const allUsers = await User.find({});
        console.log(`\n📊 Total users in database: ${allUsers.length}`);

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(usersWithMigration.length === 0 ? 0 : 1);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

verifyMigrationCleared();