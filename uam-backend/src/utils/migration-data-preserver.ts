import { IUser } from '../models/User';
import { getAvatarUrl } from './gravatar';

/**
 * Flexible data preservation system for migrations
 * This can be extended to preserve posts, reels, and other user data
 */

export interface PreservedUserData {
    // Core user fields
    bio?: string;
    displayName: string;
    avatar?: string;
    loginCount: number;
    lastLogin?: Date;
    provider: 'local' | 'google' | 'github';
    providerId?: string;
    createdAt: Date;
    
    // Extended data (for future use - posts, reels, etc.)
    extendedData?: {
        [key: string]: any; // Flexible structure for future data types
    };
}

/**
 * Extract all user data that should be preserved during migration
 * This function can be extended to include posts, reels, etc.
 */
export const extractUserData = async (user: IUser): Promise<PreservedUserData> => {
    return {
        bio: user.bio || '',
        displayName: user.displayName,
        avatar: user.avatar,
        loginCount: user.loginCount || 0,
        lastLogin: user.lastLogin,
        provider: user.provider,
        providerId: user.providerId,
        createdAt: user.createdAt,
        // Extended data can be added here in the future
        // Example: extendedData: { posts: await getPosts(user._id), reels: await getReels(user._id) }
    };
};

/**
 * Apply preserved data to a user document
 * This ensures all data is properly restored after migration
 */
export const applyUserData = (user: IUser, preservedData: PreservedUserData, newEmail?: string): void => {
    // Apply core fields
    user.bio = preservedData.bio || '';
    user.displayName = preservedData.displayName;
    user.avatar = preservedData.avatar || (newEmail ? getAvatarUrl(newEmail) : undefined);
    user.loginCount = preservedData.loginCount;
    user.lastLogin = preservedData.lastLogin;
    user.provider = preservedData.provider;
    user.providerId = preservedData.providerId;
    // createdAt is automatically preserved by Mongoose
    
    // Mark bio as modified to ensure it's saved
    user.markModified('bio');
    
    // Apply extended data if present
    if (preservedData.extendedData) {
        // Future: Apply posts, reels, etc.
        // Example: await applyPosts(user._id, preservedData.extendedData.posts);
        // Example: await applyReels(user._id, preservedData.extendedData.reels);
    }
};

/**
 * Log preserved data for debugging
 */
export const logPreservedData = (preservedData: PreservedUserData, context: string = 'Migration'): void => {
    console.log(`📦 ${context} - Preserved Data:`);
    console.log(`   Bio: ${preservedData.bio || 'EMPTY'}`);
    console.log(`   Display Name: ${preservedData.displayName}`);
    console.log(`   Avatar: ${preservedData.avatar || 'None'}`);
    console.log(`   Provider: ${preservedData.provider}`);
    console.log(`   Login Count: ${preservedData.loginCount}`);
    if (preservedData.extendedData) {
        console.log(`   Extended Data Keys: ${Object.keys(preservedData.extendedData).join(', ')}`);
    }
};

/**
 * Verify that data was preserved correctly after migration
 */
export const verifyPreservedData = async (user: IUser, originalData: PreservedUserData): Promise<boolean> => {
    const issues: string[] = [];
    
    if (originalData.bio && user.bio !== originalData.bio) {
        issues.push(`Bio mismatch: original="${originalData.bio}", current="${user.bio}"`);
    }
    
    if (user.displayName !== originalData.displayName) {
        issues.push(`Display name mismatch`);
    }
    
    if (user.provider !== originalData.provider) {
        issues.push(`Provider mismatch`);
    }
    
    if (issues.length > 0) {
        console.error(`❌ Data preservation verification failed:`);
        issues.forEach(issue => console.error(`   - ${issue}`));
        return false;
    }
    
    console.log(`✅ Data preservation verified successfully`);
    return true;
};

