import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';

/**
 * Script to fix broken migration where a duplicate account was created
 * This merges the old account (with bio) into the new account
 */
const fixMigrationMerge = async (): Promise<void> => {
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

        // Find user with migration pending (old account)
        const oldAccount = await User.findOne({
            newEmailPending: { $exists: true, $ne: null },
            currentEmailVerified: true,
            newEmailVerified: true
        });

        if (!oldAccount) {
            console.log('❌ No pending migration found. Migration may already be complete or not started.');
            await mongoose.connection.close();
            process.exit(0);
        }

        console.log(`\n📧 Old Account (with bio):`);
        console.log(`   ID: ${oldAccount._id}`);
        console.log(`   Email: ${oldAccount.email}`);
        console.log(`   New Email Pending: ${oldAccount.newEmailPending}`);
        console.log(`   Bio: ${oldAccount.bio || 'No bio'}`);
        console.log(`   Display Name: ${oldAccount.displayName}`);
        console.log(`   Avatar: ${oldAccount.avatar || 'No avatar'}`);

        // Find user with new email (duplicate account)
        const newAccount = await User.findOne({
            email: oldAccount.newEmailPending
        });

        if (!newAccount) {
            console.log('\n❌ New account not found. Migration may have already completed.');
            await mongoose.connection.close();
            process.exit(0);
        }

        console.log(`\n📧 New Account (duplicate):`);
        console.log(`   ID: ${newAccount._id}`);
        console.log(`   Email: ${newAccount.email}`);
        console.log(`   Bio: ${newAccount.bio || 'No bio'}`);
        console.log(`   Display Name: ${newAccount.displayName}`);

        // Merge: Update old account with new email and preserve all data
        console.log(`\n🔄 Merging accounts...`);
        
        const preservedBio = oldAccount.bio;
        const preservedDisplayName = oldAccount.displayName;
        const preservedAvatar = oldAccount.avatar;
        const preservedLoginCount = oldAccount.loginCount || 0;
        const preservedLastLogin = oldAccount.lastLogin;
        const preservedProvider = oldAccount.provider;
        const preservedProviderId = oldAccount.providerId;
        const preservedCreatedAt = oldAccount.createdAt;

        // Update old account with new email
        oldAccount.previousEmail = oldAccount.email;
        oldAccount.email = oldAccount.newEmailPending!;
        oldAccount.migrationExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        oldAccount.lastMigrationDate = new Date();
        oldAccount.isEmailVerified = true;

        // Preserve all original data
        oldAccount.bio = preservedBio;
        oldAccount.displayName = preservedDisplayName;
        oldAccount.avatar = preservedAvatar;
        oldAccount.loginCount = preservedLoginCount;
        oldAccount.lastLogin = preservedLastLogin;
        oldAccount.provider = preservedProvider;
        oldAccount.providerId = preservedProviderId;
        // Keep original createdAt

        // Cleanup migration fields
        oldAccount.migrationToken = undefined;
        oldAccount.migrationTokenExpires = undefined;
        oldAccount.newEmailPending = undefined;
        oldAccount.currentEmailVerified = undefined;
        oldAccount.newEmailVerified = undefined;
        oldAccount.currentEmailToken = undefined;
        oldAccount.newEmailToken = undefined;

        // Save old account (now with new email)
        await oldAccount.save();
        console.log(`✅ Updated old account with new email: ${oldAccount.email}`);

        // Delete duplicate account
        await User.findByIdAndDelete(newAccount._id);
        console.log(`✅ Deleted duplicate account: ${newAccount._id}`);

        // Verify the merge
        const mergedUser = await User.findById(oldAccount._id);
        console.log(`\n✅ Merge Complete!`);
        console.log(`   Email: ${mergedUser?.email}`);
        console.log(`   Previous Email: ${mergedUser?.previousEmail}`);
        console.log(`   Bio: ${mergedUser?.bio || 'No bio'}`);
        console.log(`   Display Name: ${mergedUser?.displayName}`);

        await mongoose.connection.close();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

fixMigrationMerge();

