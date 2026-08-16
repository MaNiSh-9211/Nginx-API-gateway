import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';

/**
 * Script to fix migration where bio was not preserved
 * This will find users who migrated but lost their bio
 */
const fixMigrationBio = async (): Promise<void> => {
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

        // Find user with old email (manish1217.be22@chitkarauniversity.edu.in)
        const oldUser = await User.findOne({ 
            email: 'manish1217.be22@chitkarauniversity.edu.in' 
        });

        // Find user with new email (at38157@gmail.com)
        const newUser = await User.findOne({ 
            email: 'at38157@gmail.com' 
        });

        if (!oldUser) {
            console.log('❌ Old user not found');
            await mongoose.connection.close();
            process.exit(1);
        }

        if (!newUser) {
            console.log('❌ New user not found');
            await mongoose.connection.close();
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

        // Check if new user has previousEmail matching old user
        if (newUser.previousEmail === oldUser.email) {
            console.log(`\n✅ Migration detected: ${oldUser.email} -> ${newUser.email}`);
            
            // If new user doesn't have bio but old user does, copy it
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

        await mongoose.connection.close();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

fixMigrationBio();

