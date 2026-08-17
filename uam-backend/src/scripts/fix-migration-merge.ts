import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';

/**
 * Script to fix broken migration where a duplicate account was created
 * This merges the old account (with bio) into the new account
 */
const fixMigrationMerge = async (): Promise<void> => {
    try {
        await connectDatabase();
        console.log('✅ Connected to PostgreSQL');

        const oldAccount = await User.findOne({
            newEmailPending: { $exists: true, $ne: null },
            currentEmailVerified: true,
            newEmailVerified: true
        });

        if (!oldAccount) {
            console.log('❌ No pending migration found. Migration may already be complete or not started.');
            await disconnectDatabase();
            process.exit(0);
        }

        console.log(`\n📧 Old Account (with bio):`);
        console.log(`   ID: ${oldAccount._id}`);
        console.log(`   Email: ${oldAccount.email}`);
        console.log(`   New Email Pending: ${oldAccount.newEmailPending}`);
        console.log(`   Bio: ${oldAccount.bio || 'No bio'}`);
        console.log(`   Display Name: ${oldAccount.displayName}`);
        console.log(`   Avatar: ${oldAccount.avatar || 'No avatar'}`);

        const newAccount = await User.findOne({
            email: oldAccount.newEmailPending
        });

        if (!newAccount) {
            console.log('\n❌ New account not found. Migration may have already completed.');
            await disconnectDatabase();
            process.exit(0);
        }

        console.log(`\n📧 New Account (duplicate):`);
        console.log(`   ID: ${newAccount._id}`);
        console.log(`   Email: ${newAccount.email}`);
        console.log(`   Bio: ${newAccount.bio || 'No bio'}`);
        console.log(`   Display Name: ${newAccount.displayName}`);

        console.log(`\n🔄 Merging accounts...`);

        const preservedBio = oldAccount.bio;
        const preservedDisplayName = oldAccount.displayName;
        const preservedAvatar = oldAccount.avatar;
        const preservedLoginCount = oldAccount.loginCount || 0;
        const preservedLastLogin = oldAccount.lastLogin;
        const preservedProvider = oldAccount.provider;
        const preservedProviderId = oldAccount.providerId;
        const preservedCreatedAt = oldAccount.createdAt;

        oldAccount.previousEmail = oldAccount.email;
        oldAccount.email = oldAccount.newEmailPending!;
        oldAccount.migrationExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        oldAccount.lastMigrationDate = new Date();
        oldAccount.isEmailVerified = true;

        oldAccount.bio = preservedBio;
        oldAccount.displayName = preservedDisplayName;
        oldAccount.avatar = preservedAvatar;
        oldAccount.loginCount = preservedLoginCount;
        oldAccount.lastLogin = preservedLastLogin;
        oldAccount.provider = preservedProvider;
        oldAccount.providerId = preservedProviderId;

        oldAccount.migrationToken = undefined;
        oldAccount.migrationTokenExpires = undefined;
        oldAccount.newEmailPending = undefined;
        oldAccount.currentEmailVerified = undefined;
        oldAccount.newEmailVerified = undefined;
        oldAccount.currentEmailToken = undefined;
        oldAccount.newEmailToken = undefined;

        await oldAccount.save();
        console.log(`✅ Updated old account with new email: ${oldAccount.email}`);

        await User.findByIdAndDelete(newAccount._id);
        console.log(`✅ Deleted duplicate account: ${newAccount._id}`);

        const mergedUser = await User.findById(oldAccount._id);
        console.log(`\n✅ Merge Complete!`);
        console.log(`   Email: ${mergedUser?.email}`);
        console.log(`   Previous Email: ${mergedUser?.previousEmail}`);
        console.log(`   Bio: ${mergedUser?.bio || 'No bio'}`);
        console.log(`   Display Name: ${mergedUser?.displayName}`);

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

fixMigrationMerge();