import { pool } from './client';
import { Filter } from './filter';

/**
 * PostgreSQL-backed replacement for the old Mongoose `UserIdentityIndex` model.
 *
 * Data model: the inverted identity index maps lookup keys
 * (primary_email:<hmac>, previous_email:<hmac>, pending_migration:<hmac>,
 * oauth:<provider>:<id>) to a userId. Existence checks are O(1) indexed reads.
 *
 * Postgres notes vs Mongo:
 * - `syncIndexes()` is a no-op — indexes come from migrations (001_init).
 * - `expiresAt` TTL is enforced by the background sweeper in migrations.ts.
 * - MongoDB `ObjectId` userIds become plain `string` ids.
 */

export type IdentityIndexKind = 'primary_email' | 'previous_email' | 'pending_migration' | 'oauth';

export interface IUserIdentityIndex {
    key: string;
    kind: IdentityIndexKind;
    userId: string;
    provider?: 'google' | 'github';
    verified?: boolean;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const COLUMNS: Record<string, string> = {
    key: 'key',
    kind: 'kind',
    userId: 'user_id',
    provider: 'provider',
    verified: 'verified',
    expiresAt: 'expires_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
};

function rowToDoc(row: Record<string, unknown>): IUserIdentityIndex {
    return {
        key: row.key as string,
        kind: row.kind as IdentityIndexKind,
        userId: row.user_id as string,
        provider: row.provider as 'google' | 'github' | undefined,
        verified: row.verified as boolean | undefined,
        expiresAt: row.expires_at as Date | undefined,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
    };
}

function buildWhere(filter: Filter, params: unknown[]): string {
    const clauses: string[] = [];
    for (const [field, value] of Object.entries(filter)) {
        const col = COLUMNS[field] ?? field;
        if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
            for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
                switch (op) {
                    case '$gt': {
                        params.push(operand);
                        clauses.push(`${col} > $${params.length}`);
                        break;
                    }
                    case '$gte': {
                        params.push(operand);
                        clauses.push(`${col} >= $${params.length}`);
                        break;
                    }
                    case '$lt': {
                        params.push(operand);
                        clauses.push(`${col} < $${params.length}`);
                        break;
                    }
                    case '$lte': {
                        params.push(operand);
                        clauses.push(`${col} <= $${params.length}`);
                        break;
                    }
                    case '$ne': {
                        if (operand === null) {
                            clauses.push(`${col} IS NOT NULL`);
                        } else {
                            params.push(operand);
                            clauses.push(`${col} <> $${params.length}`);
                        }
                        break;
                    }
                    case '$in': {
                        const arr = operand as unknown[];
                        params.push(arr);
                        clauses.push(`${col} = ANY($${params.length})`);
                        break;
                    }
                    case '$nin': {
                        const arr = operand as unknown[];
                        params.push(arr);
                        clauses.push(`NOT (${col} = ANY($${params.length}))`);
                        break;
                    }
                    default:
                        throw new Error(`Unsupported operator for identity index: ${op}`);
                }
            }
        } else {
            params.push(value);
            clauses.push(`${col} = $${params.length}`);
        }
    }
    return clauses.join(' AND ');
}

class IdentityIndexQuery implements PromiseLike<IUserIdentityIndex | null> {
    constructor(private readonly filter: Filter) {}

    lean(): this {
        return this;
    }

    then<TResult1 = IUserIdentityIndex | null, TResult2 = never>(
        onfulfilled?: ((value: IUserIdentityIndex | null) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        const params: unknown[] = [];
        const where = buildWhere(this.filter, params);
        const sql = `SELECT * FROM user_identity_indexes WHERE ${where} LIMIT 1`;
        return pool.query(sql, params).then(({ rows }) => {
            const doc = rows[0] ? rowToDoc(rows[0]) : null;
            return onfulfilled ? onfulfilled(doc) : (doc as TResult1);
        }).catch(onrejected ?? ((err) => { throw err; }));
    }
}

interface UpdateResult {
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
}

interface DeleteResult {
    deletedCount: number;
}

export const UserIdentityIndex = {
    findOne(filter: Filter): IdentityIndexQuery {
        return new IdentityIndexQuery(filter);
    },

    async updateOne(
        filter: Filter,
        update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
        options?: { upsert?: boolean },
    ): Promise<UpdateResult> {
        const $set = update.$set ?? {};
        const $unset = update.$unset ?? {};

        // Normalize to camelCase doc shape the column mapper understands.
        const setDoc: Record<string, unknown> = {};
        for (const [k, v] of Object.entries($set)) setDoc[k] = v;

        const unsetKeys = Object.keys($unset);

        const params: unknown[] = [];
        const where = buildWhere(filter, params);
        const existing = await pool.query(
            `SELECT key FROM user_identity_indexes WHERE ${where} LIMIT 1`,
            params,
        );
        const exists = existing.rowCount !== null && existing.rowCount > 0;

        if (exists) {
            const setParams: unknown[] = [];
            const sets: string[] = [];
            for (const [field, value] of Object.entries(setDoc)) {
                const col = COLUMNS[field] ?? field;
                setParams.push(value ?? null);
                sets.push(`${col} = $${setParams.length}`);
            }
            for (const field of unsetKeys) {
                const col = COLUMNS[field] ?? field;
                setParams.push(null);
                sets.push(`${col} = $${setParams.length}`);
            }
            sets.push('updated_at = NOW()');
            const keyIdx = setParams.length + 1;
            setParams.push(existing.rows[0].key);
            const sql = `UPDATE user_identity_indexes SET ${sets.join(', ')} WHERE key = $${keyIdx}`;
            const { rowCount } = await pool.query(sql, setParams);
            return { matchedCount: rowCount ?? 0, modifiedCount: rowCount ?? 0, upsertedCount: 0 };
        }

        if (options?.upsert) {
            const doc: Record<string, unknown> = { key: filter.key, ...setDoc, ...Object.fromEntries(unsetKeys.map((k) => [k, null])) };
            const key = doc.key as string;
            const kind = (doc.kind as string) ?? 'oauth';
            const userId = doc.userId as string;
            if (!key || !kind || !userId) {
                throw new Error('identity index upsert requires key, kind, userId');
            }
            const insertParams: unknown[] = [];
            const insertCols: string[] = [];
            const insertVals: string[] = [];
            for (const [field, value] of Object.entries(doc)) {
                if (field === 'createdAt' || field === 'updatedAt') continue;
                const col = COLUMNS[field] ?? field;
                insertCols.push(col);
                insertParams.push(value ?? null);
                insertVals.push(`$${insertParams.length}`);
            }
            const sql = `INSERT INTO user_identity_indexes (${insertCols.join(', ')})
                         VALUES (${insertVals.join(', ')})`;
            await pool.query(sql, insertParams);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }

        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },

    async deleteOne(filter: Filter): Promise<DeleteResult> {
        const params: unknown[] = [];
        const where = buildWhere(filter, params);
        const { rowCount } = await pool.query(
            `DELETE FROM user_identity_indexes WHERE ${where}`,
            params,
        );
        return { deletedCount: rowCount ?? 0 };
    },

    async deleteMany(filter: Filter): Promise<DeleteResult> {
        const params: unknown[] = [];
        const where = buildWhere(filter, params);
        const { rowCount } = await pool.query(
            `DELETE FROM user_identity_indexes WHERE ${where}`,
            params,
        );
        return { deletedCount: rowCount ?? 0 };
    },

    /** No-op — indexes are created by migrations, not at runtime. */
    async syncIndexes(): Promise<void> {
        return;
    },

    /** No-op — kept for API compatibility with the old Mongo driver error path. */
    collection: {
        async dropIndex(): Promise<void> {
            return;
        },
    },
};

export type { Filter };