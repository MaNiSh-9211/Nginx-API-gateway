import mongoose, { Document, Schema } from 'mongoose';
import { hashPassword, verifyPassword } from '../utils/password.util';

export interface IUser extends Document {
    _id: mongoose.Types.ObjectId;
    email: string;
    password?: string;
    displayName: string;
    avatar?: string;
    bio?: string; // User bio/passage
    isEmailVerified: boolean;
    loginCount?: number;
    lastLogin?: Date;
    emailVerificationToken?: string;
    emailVerificationExpires?: Date;
    passwordResetToken?: string;
    passwordResetExpires?: Date;
    provider: 'local' | 'google' | 'github';
    providerId?: string;
    refreshTokens: string[];
    /** Recent access-token JTIs for gateway revocation on password reset / session kill. */
    activeAccessJtis?: string[];
    /** Monotonic version embedded as `tv` in access JWTs; bump invalidates all prior tokens via Redis. */
    tokenVersion?: number;
    // Account Migration fields
    previousEmail?: string;
    migrationExpiry?: Date;
    migrationToken?: string;
    migrationTokenExpires?: Date;
    newEmailPending?: string;
    lastMigrationDate?: Date;
    currentEmailVerified?: boolean; // Track if current email is verified for migration
    newEmailVerified?: boolean; // Track if new email is verified for migration
    currentEmailToken?: string; // Token for current email verification
    newEmailToken?: string; // Token for new email verification
    lastMigrationEmailSent?: Date; // Track when migration emails were last sent (for cooldown)
    migrationHistory?: Array<{
        fromEmail: string;
        toEmail: string;
        status: 'success' | 'failed' | 'pending' | 'reverted';
        initiatedAt: Date;
        completedAt?: Date;
        revertedAt?: Date;
        currentEmailVerified?: boolean; // Track if current email was verified
        newEmailVerified?: boolean; // Track if new email was verified
        pendingFrom?: 'current' | 'new' | 'both'; // Which email(s) are pending verification
    }>; // Track all migration attempts
    createdAt: Date;
    updatedAt: Date;
    comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        // Store previous email during 5-day migration window
        previousEmail: {
            type: String,
            lowercase: true,
            trim: true,
            index: true,
        },
        migrationExpiry: Date, // When the dual-login window expires
        migrationToken: String,
        migrationTokenExpires: Date,
        newEmailPending: {
            type: String,
            lowercase: true,
            trim: true,
        },
        lastMigrationDate: Date, // For 10-day cooldown
        currentEmailVerified: Boolean, // Track if current email is verified for migration
        newEmailVerified: Boolean, // Track if new email is verified for migration
        currentEmailToken: String, // Token for current email verification
        newEmailToken: String, // Token for new email verification
        lastMigrationEmailSent: Date, // Track when migration emails were last sent (for cooldown)
        migrationHistory: [{
            fromEmail: String,
            toEmail: String,
            status: { type: String, enum: ['success', 'failed', 'pending', 'reverted'], default: 'pending' },
            initiatedAt: Date,
            completedAt: { type: Date, required: false },
            revertedAt: { type: Date, required: false },
            currentEmailVerified: { type: Boolean, required: false },
            newEmailVerified: { type: Boolean, required: false },
            pendingFrom: { type: String, enum: ['current', 'new', 'both'], required: false }
        }], // Track all migration attempts
        password: {
            type: String,
            minlength: 8,
            select: false,
        },
        displayName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 50,
        },
        avatar: {
            type: String,
        },
        bio: {
            type: String,
            maxlength: 500,
            trim: true,
        },
        isEmailVerified: {
            type: Boolean,
            default: false,
        },
        loginCount: { type: Number, default: 0 },
        lastLogin: Date,
        emailVerificationToken: String,
        emailVerificationExpires: Date,
        passwordResetToken: String,
        passwordResetExpires: Date,
        provider: {
            type: String,
            enum: ['local', 'google', 'github'],
            default: 'local',
        },
        providerId: String,
        refreshTokens: {
            type: [String],
            default: [],
            select: false,
        },
        activeAccessJtis: {
            type: [String],
            default: [],
            select: false,
        },
        tokenVersion: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

// OAuth identity uniqueness — complements inverted oauth:* index rows.
userSchema.index(
    { provider: 1, providerId: 1 },
    {
        unique: true,
        sparse: true,
        partialFilterExpression: {
            provider: { $in: ['google', 'github'] },
            providerId: { $exists: true, $type: 'string' },
        },
    },
);

// Hash password before saving.
// hash string; PASSWORD_PEPPER (if set) is mixed in via HMAC in the util.
userSchema.pre('save', async function (next) {
    if (!this.isModified('password') || !this.password) {
        return next();
    }

    this.password = await hashPassword(this.password);
    next();
});

// Compare password. Accepts legacy un-peppered hashes and transparently
// re-hashes them to the current scheme on a successful login (best-effort).
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
    if (!this.password) return false;

    const { match, needsRehash } = await verifyPassword(candidatePassword, this.password);

    if (match && needsRehash) {
        try {
            // Setting the plaintext marks the field modified; the pre-save hook
            // re-hashes with the current (peppered) scheme.
            this.password = candidatePassword;
            await this.save();
        } catch {
            // Migration is best-effort and must never block a valid login.
        }
    }

    return match;
};

export const User = mongoose.model<IUser>('User', userSchema);
