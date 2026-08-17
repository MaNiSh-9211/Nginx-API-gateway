import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';

/**
 * Script to fix migration where bio was not preserved
 * This will find users who migrated but lost their bio
 */
const fixMigrationBio = async (): Promise<void> => {
    try {
        await connectDatabase();
        console.log('✅ Connected to PostgreSQL');

        const oldUser = await User.findOne({
            email: 'manish1217.be22@chitkarauniversity.edu.in'
        });

        const newUser = await User.findOne({
            email: 'at38157@gmail.com'
        });

        if (!oldUser) {
            console.log('❌ Old user not found');
            await disconnectDatabase();
            process.exit(1);
        }

        if (!newUser) {
            console.log('❌ New user not found');
            await disconnectDatabase();
            process.exit(1);
        }

        console.log(`\n📧 Old User (${oldUser.email}):`);
        console.log(`   Bio: ${oldUser.bio || 'No bio'}`);
        console.log(`   Display Name: ${oldUser.displayName}`);
        console.log(`   ID: ${oldUser._id}`);

        console.log(`\n📧 New User (${newUser.email}):`);
        console.log(`   Bio: ${newUser.bio || 'No bio'}`);
        console.log(`   Display Name: ${newUser.displayName}`);
        console.log(`   ID: ${newUser._id}`);
        console.log(`   Previous Email: ${newUser.previousEmail || 'None'}`);

        if (newUser.previousEmail === oldUser.email) {
            console.log(`\n✅ Migration detected: ${oldUser.email} -> ${newUser.email}`);

            if (!newUser.bio && oldUser.bio) {
                console.log(`\n🔄 Copying bio from old account to new account...`);
                newUser.bio = oldUser.bio;
                await newUser.save();
                console.log(`✅ Bio copied successfully!`);
                console.log(`   New bio: ${newUser.bio}`);
            } else if (newUser.bio) {
                console.log(`\n✅ New user already has bio: ${newUser.bio}`);
            } else {
                console.log(`\n⚠️  Old user also doesn't have bio`);
            }
        } else {
            console.log(`\n⚠️  No migration relationship found between these accounts`);
        }

        await disconnectDatabase();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

fixMigrationBio();