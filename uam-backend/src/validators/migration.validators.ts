import { z } from 'zod';

const emailSchema = z
    .string()
    .min(1, 'Email is required')
    .email('Invalid email format')
    .max(255, 'Email is too long');

const passwordSchema = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long');

const tokenSchema = z.string().min(32, 'Invalid token').max(128);

export const migrationInitSchema = z.object({
    newEmail: emailSchema,
    password: passwordSchema.optional(),
    confirmOverride: z.enum(['true']).optional(),
});

export const migrationVerifySchema = z.object({
    formToken: z.string().min(64, 'Invalid form token').max(128),
});

export type MigrationInitInput = z.infer<typeof migrationInitSchema>;
export type MigrationVerifyInput = z.infer<typeof migrationVerifySchema>;
