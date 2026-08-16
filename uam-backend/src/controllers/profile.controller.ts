import { Request, Response } from 'express';
import { User, IUser } from '../models/User';

// Update user bio
export const updateBio = async (req: Request, res: Response): Promise<void> => {
    try {
        const user = (req as any).user as IUser;
        const { bio } = req.body;

        if (bio && bio.length > 500) {
            res.status(400).json({ success: false, message: 'Bio must be 500 characters or less' });
            return;
        }

        // IMPORTANT: Find user by email OR previousEmail (during grace period)
        // This ensures changes from either email reflect in both
        const userDoc = await User.findOne({
            $or: [
                { _id: user._id },
                { email: user.email },
                { previousEmail: user.email }
            ]
        });
        
        if (!userDoc) {
            res.status(404).json({ success: false, message: 'User not found' });
            return;
        }

        // Update bio - changes will be visible from both emails during grace period
        userDoc.bio = bio || undefined;
        await userDoc.save();

        res.json({
            success: true,
            message: 'Bio updated successfully',
            user: {
                id: userDoc._id,
                email: userDoc.email,
                displayName: userDoc.displayName,
                avatar: userDoc.avatar,
                bio: userDoc.bio,
                isEmailVerified: userDoc.isEmailVerified,
            },
        });
    } catch (error) {
        console.error('Update bio error:', error);
        res.status(500).json({ success: false, message: 'Failed to update bio' });
    }
};

