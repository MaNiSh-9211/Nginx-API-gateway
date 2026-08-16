# Migration System Extension Guide

## Overview
The migration system has been refactored to be flexible and extensible. You can easily add support for migrating posts, reels, and other user data with minimal code changes.

## Architecture

### Core Components

1. **`migration-data-preserver.ts`** - Flexible data preservation system
2. **`migration.controller.ts`** - Migration logic using the preserver

### How It Works

The system uses a **data extraction → preservation → application** pattern:

1. **Extract**: `extractUserData()` - Gets all data to preserve
2. **Preserve**: Data is stored in a `PreservedUserData` object
3. **Apply**: `applyUserData()` - Restores data after migration

## Adding New Data Types (Posts, Reels, etc.)

### Step 1: Update the PreservedUserData Interface

Edit `server/src/utils/migration-data-preserver.ts`:

```typescript
export interface PreservedUserData {
    // ... existing fields ...
    
    // Add your new data types here
    extendedData?: {
        posts?: Post[];      // Add posts
        reels?: Reel[];      // Add reels
        // Add more as needed
    };
}
```

### Step 2: Update extractUserData Function

```typescript
export const extractUserData = async (user: IUser): Promise<PreservedUserData> => {
    return {
        // ... existing fields ...
        
        extendedData: {
            // Add your data extraction here
            posts: await Post.find({ userId: user._id }),  // Example
            reels: await Reel.find({ userId: user._id }),  // Example
        }
    };
};
```

### Step 3: Update applyUserData Function

```typescript
export const applyUserData = async (user: IUser, preservedData: PreservedUserData, newEmail?: string): Promise<void> => {
    // ... existing code ...
    
    // Apply extended data
    if (preservedData.extendedData) {
        // Migrate posts
        if (preservedData.extendedData.posts) {
            await Post.updateMany(
                { userId: user._id },
                { $set: { userId: user._id } }  // Update user reference
            );
        }
        
        // Migrate reels
        if (preservedData.extendedData.reels) {
            await Reel.updateMany(
                { userId: user._id },
                { $set: { userId: user._id } }
            );
        }
    }
};
```

### Step 4: Update Verification (Optional)

Add verification for your new data types:

```typescript
export const verifyPreservedData = async (user: IUser, originalData: PreservedUserData): Promise<boolean> => {
    // ... existing verification ...
    
    // Verify posts
    if (originalData.extendedData?.posts) {
        const currentPosts = await Post.find({ userId: user._id });
        if (currentPosts.length !== originalData.extendedData.posts.length) {
            issues.push(`Posts count mismatch`);
        }
    }
    
    // ... rest of verification ...
};
```

## Key Features

### 1. Account Existence Check (BEFORE Migration)
- Checks if account exists **before** starting migration
- Shows warning immediately if account exists
- Requires user confirmation before proceeding

### 2. Placeholder Account Creation
- If new email doesn't have an account, creates a placeholder
- Placeholder is automatically merged/deleted during finalization
- Ensures smooth migration flow

### 3. Flexible Data Preservation
- All user data (bio, displayName, avatar, etc.) is preserved
- Easy to extend for posts, reels, and other data
- Automatic verification after migration

## Migration Flow

1. **Initiate Migration**
   - Check if account exists → Show warning if yes
   - Verify password
   - Send verification emails

2. **Verify Emails**
   - Current email verification
   - New email verification (creates placeholder if needed)

3. **Finalize Migration**
   - Extract all user data
   - Merge/update account
   - Apply preserved data
   - Verify data preservation

## Example: Adding Posts Migration

```typescript
// 1. Import Post model
import { Post } from '../models/Post';

// 2. Update extractUserData
export const extractUserData = async (user: IUser): Promise<PreservedUserData> => {
    const posts = await Post.find({ userId: user._id });
    
    return {
        // ... existing fields ...
        extendedData: {
            posts: posts.map(p => p.toObject())  // Convert to plain object
        }
    };
};

// 3. Update applyUserData
export const applyUserData = async (user: IUser, preservedData: PreservedUserData, newEmail?: string): Promise<void> => {
    // ... existing code ...
    
    if (preservedData.extendedData?.posts) {
        // Update all posts to reference the migrated user
        await Post.updateMany(
            { userId: user._id },
            { $set: { userId: user._id } }
        );
    }
};
```

That's it! The migration system will now automatically preserve and restore posts.

## Benefits

✅ **Minimal Code Changes** - Only modify the preserver utility
✅ **Type Safe** - TypeScript ensures data integrity
✅ **Automatic Verification** - Built-in verification system
✅ **Extensible** - Easy to add new data types
✅ **Maintainable** - Centralized data preservation logic

## Notes

- Always use `await` when extracting/applying data
- Convert Mongoose documents to plain objects when storing in `extendedData`
- Update user references in related collections during `applyUserData`
- Add verification checks for new data types

