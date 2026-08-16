import mongoose, { ConnectOptions } from 'mongoose';
import { config } from './index';
import {
    backfillIdentityIndexes,
    ensureIdentityIndexIndexes,
} from '../services/identity-index.service';

export function getMongoConnectOptions(): ConnectOptions {
    const { pool } = config.mongodb;
    return {
        maxPoolSize: pool.maxPoolSize,
        minPoolSize: pool.minPoolSize,
        maxIdleTimeMS: pool.maxIdleTimeMS,
        waitQueueTimeoutMS: pool.waitQueueTimeoutMS,
        serverSelectionTimeoutMS: pool.serverSelectionTimeoutMS,
        socketTimeoutMS: pool.socketTimeoutMS,
        connectTimeoutMS: pool.connectTimeoutMS,
        heartbeatFrequencyMS: pool.heartbeatFrequencyMS,
        retryWrites: pool.retryWrites,
        retryReads: pool.retryReads,
        appName: pool.appName,
    };
}

export const connectDatabase = async (): Promise<void> => {
    const options = getMongoConnectOptions();
    try {
        await mongoose.connect(config.mongodb.uri, options);
        console.log(
            `✅ MongoDB connected (pool min=${options.minPoolSize} max=${options.maxPoolSize})`,
        );

        await ensureIdentityIndexIndexes();
        const { scanned, synced } = await backfillIdentityIndexes();
        if (scanned > 0) {
            console.log(`✅ Identity index backfill: ${synced}/${scanned} users`);
        }
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
};

export const disconnectDatabase = async (): Promise<void> => {
    if (mongoose.connection.readyState === 0) return;
    await mongoose.connection.close();
    console.log('MongoDB pool closed');
};

/** Readiness probe — verifies the driver pool can serve a command. */
export const pingDatabase = async (): Promise<boolean> => {
    if (mongoose.connection.readyState !== 1) return false;
    try {
        await mongoose.connection.db?.admin().command({ ping: 1 });
        return true;
    } catch {
        return false;
    }
};

mongoose.connection.on('connected', () => {
    console.log('MongoDB driver pool ready');
});

mongoose.connection.on('disconnected', () => {
    console.log('⚠️ MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB error:', err);
});

mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconnected');
});
