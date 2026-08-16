import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';

const randomPassages = [
    "The journey of a thousand miles begins with a single step. Every great achievement starts with the decision to try.",
    "In the depths of winter, I finally learned that there was in me an invincible summer. The human spirit is resilient beyond measure.",
    "The only way to do great work is to love what you do. Passion drives excellence and transforms ordinary into extraordinary.",
    "Success is not final, failure is not fatal: it is the courage to continue that counts. Perseverance is the key to victory.",
    "The future belongs to those who believe in the beauty of their dreams. Vision and determination create tomorrow's reality.",
    "It is during our darkest moments that we must focus to see the light. Adversity reveals our true strength and character.",
    "The only impossible journey is the one you never begin. Taking action is the first step toward any meaningful change.",
    "Life is what happens to you while you're busy making other plans. Embrace the present moment and live fully.",
    "The way to get started is to quit talking and begin doing. Action speaks louder than words in achieving goals.",
    "Innovation distinguishes between a leader and a follower. Creativity and forward thinking drive progress.",
    "Your limitation—it's only your imagination. Break free from self-imposed boundaries and reach for the stars.",
    "Great things never come from comfort zones. Growth requires stepping into the unknown with courage and determination.",
    "Dream it. Wish it. Do it. Dreams become reality through persistent effort and unwavering commitment.",
    "The harder you work for something, the greater you'll feel when you achieve it. Effort multiplies satisfaction.",
    "Don't wait for opportunity. Create it. Proactive individuals shape their own destiny through initiative and action."
];

const cleanupUsers = async (): Promise<void> => {
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
        const allUsers = await User.find({});
        console.log(`📊 Total users found: ${allUsers.length}`);

        // Find user with email containing "mmk605"
        const targetUser = await User.findOne({
            email: { $regex: /mmk605/i }
        });

        if (!targetUser) {
            console.log('⚠️  No user found with email containing "mmk605"');
            console.log('📧 Available emails:');
            allUsers.forEach(u => console.log(`   - ${u.email}`));
            
            // Ask if we should create one or exit
            console.log('\n❌ Cannot proceed without target user. Exiting...');
            await mongoose.connection.close();
            process.exit(1);
        }

        console.log(`✅ Found target user: ${targetUser.email}`);
        console.log(`   Display Name: ${targetUser.displayName}`);
        console.log(`   ID: ${targetUser._id}\n`);

        // Add random passage/bio if not exists
        if (!targetUser.bio) {
            const randomPassage = randomPassages[Math.floor(Math.random() * randomPassages.length)];
            targetUser.bio = randomPassage;
            await targetUser.save();
            console.log(`📝 Added random passage to target user:\n   "${targetUser.bio}"\n`);
        } else {
            console.log(`📝 User already has bio:\n   "${targetUser.bio}"\n`);
        }

        // Store target user ID
        const targetUserId = targetUser._id;

        // Delete all other users
        const deleteResult = await User.deleteMany({
            _id: { $ne: targetUserId }
        });

        console.log(`🗑️  Deleted ${deleteResult.deletedCount} user(s)`);

        // Verify only target user remains
        const remainingUsers = await User.find({});
        console.log(`\n✅ Remaining users: ${remainingUsers.length}`);
        remainingUsers.forEach(u => {
            console.log(`   - ${u.email} (${u.displayName})`);
            if (u.bio) {
                console.log(`     Bio: "${u.bio.substring(0, 60)}..."`);
            }
        });

        // Add random passages to any remaining users (should only be target user)
        for (const user of remainingUsers) {
            if (!user.bio) {
                const randomPassage = randomPassages[Math.floor(Math.random() * randomPassages.length)];
                user.bio = randomPassage;
                await user.save();
                console.log(`\n📝 Added random passage to ${user.email}:\n   "${user.bio}"`);
            }
        }

        console.log('\n✅ Cleanup completed successfully!');
        console.log(`\n📌 Database: ${dbName}`);
        console.log(`📌 Collection: users`);
        console.log(`📌 Remaining user: ${targetUser.email}`);

        await mongoose.connection.close();
        console.log('\n✅ Connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

cleanupUsers();

