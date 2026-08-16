import mongoose from 'mongoose';
import { config } from '../config';

const dropUsersCollection = async (): Promise<void> => {
    try {
        // Connect to MongoDB
        await mongoose.connect(config.mongodb.uri);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;
        if (!db) {
            throw new Error('Database connection not available');
        }

        // Get the database name from the connection
        const dbName = db.databaseName;
        console.log(`📦 Database: ${dbName}`);

        // List all collections
        const collections = await db.listCollections().toArray();
        console.log('\n📋 Available collections:');
        collections.forEach(col => console.log(`  - ${col.name}`));

        // Drop users collection
        const usersCollection = db.collection('users');
        const collectionExists = collections.some(col => col.name === 'users');

        if (collectionExists) {
            await usersCollection.drop();
            console.log('\n✅ Successfully dropped "users" collection');
        } else {
            console.log('\n⚠️  "users" collection does not exist');
        }

        // Also try to drop from inventory-management database if it exists
        try {
            const inventoryDb = mongoose.connection.getClient().db('inventory-management');
            const inventoryCollections = await inventoryDb.listCollections().toArray();
            const inventoryUsersExists = inventoryCollections.some((col: { name: string }) => col.name === 'users');
            
            if (inventoryUsersExists) {
                await inventoryDb.collection('users').drop();
                console.log('✅ Successfully dropped "users" collection from inventory-management database');
            } else {
                console.log('ℹ️  No "users" collection in inventory-management database');
            }
        } catch (err) {
            console.log('ℹ️  Could not access inventory-management database (this is normal if it doesn\'t exist)');
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

dropUsersCollection();

