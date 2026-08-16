import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';

/**
 * Cleanup script to remove old email records after 5 days
 * This should be run as a scheduled job (cron) daily
 */
const cleanupExpiredMigrations = async (): Promise<void> => {
    try {
        // Connect to MongoDB
        await mongoose.connect(config.mongodb.uri);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;
        if (!db) {
            throw new Error('Database connection not available');
        }

        const dbName = db.databaseName;
        console.log(`📦 Database: ${dbName}`);
        console.log(`📋 Collection: users\n`);

        // Find users with expired migration (migrationExpiry < now)
        const now = new Date();
        const expiredUsers = await User.find({
            migrationExpiry: { $exists: true, $lt: now },
            previousEmail: { $exists: true, $ne: null }
        });

        console.log(`📊 Found ${expiredUsers.length} user(s) with expired migration periods`);

        if (expiredUsers.length === 0) {
            console.log('✅ No expired migrations to clean up');
            await mongoose.connection.close();
            process.exit(0);
        }

        // Remove previousEmail and migrationExpiry for expired migrations
        let cleanedCount = 0;
        for (const user of expiredUsers) {
            console.log(`\n🧹 Cleaning up user: ${user.email}`);
            console.log(`   Previous email: ${user.previousEmail}`);
            console.log(`   Migration expiry: ${user.migrationExpiry}`);

            // Remove previous email and migration expiry
            user.previousEmail = undefined;
            user.migrationExpiry = undefined;
            await user.save();

            cleanedCount++;
            console.log(`   ✅ Cleaned up`);
        }

        console.log(`\n✅ Cleanup completed!`);
        console.log(`   Cleaned ${cleanedCount} user(s)`);
        console.log(`\n📌 Database: ${dbName}`);
        console.log(`📌 Collection: users`);

        await mongoose.connection.close();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

cleanupExpiredMigrations();

