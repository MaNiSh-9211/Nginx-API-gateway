import { columnName, JSONB_FIELDS } from './columns';

export interface WhereClause {
    sql: string;
    params: unknown[];
}

type Scalar = string | number | boolean | Date | null | undefined;

type OpValue = Scalar | RegExp | Scalar[];

type OperatorFilter = Record<string, OpValue | Record<string, unknown>>;

export type Filter = Record<string, Scalar | OpValue | Record<string, unknown> | Filter[]>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof RegExp) && !Array.isArray(v);
}

function buildExpr(field: string, value: unknown, params: unknown[]): string {
    const col = columnName(field);
    const isJsonb = JSONB_FIELDS.has(field);

    if (isPlainObject(value)) {
        return buildOperatorExpr(field, value as OperatorFilter, params);
    }

    if (Array.isArray(value)) {
        if (isJsonb) {
            // Full-array containment (Mongoose treats array equality as subset match).
            const idx = params.length + 1;
            params.push(JSON.stringify(value));
            return `(${col} @> $${idx}::jsonb)`;
        }
        const idx = params.length + 1;
        params.push(value);
        return `(${col} = $${idx})`;
    }

    if (isJsonb) {
        // Scalar containment: refreshTokens: storedKey  ->  col @> to_jsonb('key')
        const idx = params.length + 1;
        params.push(value);
        return `(${col} @> to_jsonb($${idx}::text))`;
    }

    const idx = params.length + 1;
    params.push(value);
    return `(${col} = $${idx})`;
}

function buildOperatorExpr(field: string, ops: OperatorFilter, params: unknown[]): string {
    const col = columnName(field);
    const clauses: string[] = [];

    for (const [op, operand] of Object.entries(ops)) {
        if (op === '$not') {
            const notOps = operand as OperatorFilter;
            if (notOps && typeof notOps.$size === 'number') {
                const size = notOps.$size;
                clauses.push(`(jsonb_array_length(${col}) <> ${size})`);
                continue;
            }
            // Fallback: NOT (expr)
            const inner = buildExpr(field, notOps, params);
            clauses.push(`(NOT ${inner})`);
            continue;
        }

        switch (op) {
            case '$gt': {
                const idx = params.length + 1;
                params.push(operand);
                clauses.push(`(${col} > $${idx})`);
                break;
            }
            case '$gte': {
                const idx = params.length + 1;
                params.push(operand);
                clauses.push(`(${col} >= $${idx})`);
                break;
            }
            case '$lt': {
                const idx = params.length + 1;
                params.push(operand);
                clauses.push(`(${col} < $${idx})`);
                break;
            }
            case '$lte': {
                const idx = params.length + 1;
                params.push(operand);
                clauses.push(`(${col} <= $${idx})`);
                break;
            }
            case '$ne': {
                if (operand === null) {
                    clauses.push(`(${col} IS NOT NULL)`);
                } else {
                    const idx = params.length + 1;
                    params.push(operand);
                    clauses.push(`(${col} IS DISTINCT FROM $${idx})`);
                }
                break;
            }
            case '$exists': {
                clauses.push(operand ? `(${col} IS NOT NULL)` : `(${col} IS NULL)`);
                break;
            }
            case '$in': {
                const arr = operand as Scalar[];
                if (arr.length === 0) {
                    clauses.push('(FALSE)');
                    break;
                }
                const idx = params.length + 1;
                params.push(arr);
                clauses.push(`(${col} = ANY($${idx}))`);
                break;
            }
            case '$nin': {
                const arr = operand as Scalar[];
                if (arr.length === 0) {
                    clauses.push('(TRUE)');
                    break;
                }
                const idx = params.length + 1;
                params.push(arr);
                clauses.push(`(NOT (${col} = ANY($${idx})))`);
                break;
            }
            case '$regex': {
                let pattern: string;
                let insensitive = false;
                if (operand instanceof RegExp) {
                    pattern = operand.source;
                    insensitive = operand.flags.includes('i');
                } else {
                    pattern = String(operand);
                }
                const idx = params.length + 1;
                params.push(pattern);
                clauses.push(insensitive
                    ? `(${col} ~* $${idx})`
                    : `(${col} ~ $${idx})`);
                break;
            }
            case '$size': {
                const size = operand as number;
                clauses.push(`(jsonb_array_length(${col}) = ${size})`);
                break;
            }
            default:
                throw new Error(`Unsupported operator: ${op}`);
        }
    }

    return `(${clauses.join(' AND ')})`;
}

export function buildWhere(filter: Filter | undefined, params: unknown[] = []): WhereClause {
    if (!filter || Object.keys(filter).length === 0) {
        return { sql: '', params };
    }

    const clauses: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
        if (key === '$or') {
            const subFilters = value as Filter[];
            const orClauses: string[] = [];
            for (const sub of subFilters) {
                const subWhere = buildWhere(sub, params);
                orClauses.push(`(${subWhere.sql})`);
            }
            if (orClauses.length > 0) {
                clauses.push(`(${orClauses.join(' OR ')})`);
            }
            continue;
        }
        if (key === '$and') {
            const subFilters = value as Filter[];
            for (const sub of subFilters) {
                const subWhere = buildWhere(sub, params);
                if (subWhere.sql) clauses.push(`(${subWhere.sql})`);
            }
            continue;
        }
        clauses.push(buildExpr(key, value, params));
    }

    return { sql: clauses.join(' AND '), params };
}