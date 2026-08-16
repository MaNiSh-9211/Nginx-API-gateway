import mongoose, { Document, Schema } from 'mongoose';

export type IdentityIndexKind = 'primary_email' | 'previous_email' | 'pending_migration' | 'oauth';

/**
 * Inverted identity index — maps lookup keys (HMAC email digests, OAuth ids) to userId.
 * Separate from User documents so existence checks are O(1) indexed point reads.
 */
export interface IUserIdentityIndex extends Document {
    /** Unique lookup key, e.g. primary_email:<hmac> or oauth:google:<providerId> */
    key: string;
    kind: IdentityIndexKind;
    userId: mongoose.Types.ObjectId;
    provider?: 'google' | 'github';
    verified?: boolean;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const userIdentityIndexSchema = new Schema<IUserIdentityIndex>(
    {
        key: { type: String, required: true, unique: true },
        kind: {
            type: String,
            required: true,
            enum: ['primary_email', 'previous_email', 'pending_migration', 'oauth'],
        },
        userId: { type: Schema.Types.ObjectId, required: true, ref: 'User', index: true },
        provider: { type: String, enum: ['google', 'github'] },
        verified: { type: Boolean },
        expiresAt: { type: Date },
    },
    { timestamps: true },
);

userIdentityIndexSchema.index({ userId: 1, kind: 1 });
userIdentityIndexSchema.index(
    { expiresAt: 1 },
    {
        name: 'identity_expires_ttl',
        expireAfterSeconds: 0,
        partialFilterExpression: { expiresAt: { $exists: true } },
    },
);

export const UserIdentityIndex = mongoose.model<IUserIdentityIndex>(
    'UserIdentityIndex',
    userIdentityIndexSchema,
);
