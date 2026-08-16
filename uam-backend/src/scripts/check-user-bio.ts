import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';

const checkUserBio = async (): Promise<void> => {
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

        // Find all users
        const users = await User.find({});
        console.log(`📊 Total users: ${users.length}\n`);

        users.forEach((user, index) => {
            console.log(`\n--- User ${index + 1} ---`);
            console.log(`Email: ${user.email}`);
            console.log(`Previous Email: ${user.previousEmail || 'None'}`);
            console.log(`Display Name: ${user.displayName}`);
            console.log(`Bio: ${user.bio || 'No bio'}`);
            console.log(`Avatar: ${user.avatar || 'No avatar'}`);
            console.log(`Provider: ${user.provider}`);
            console.log(`Is Verified: ${user.isEmailVerified}`);
            console.log(`Migration Expiry: ${user.migrationExpiry || 'None'}`);
            console.log(`Created At: ${user.createdAt}`);
        });

        await mongoose.connection.close();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

checkUserBio();

