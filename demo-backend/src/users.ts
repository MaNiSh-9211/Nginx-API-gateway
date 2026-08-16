/**
 * User credential store — bcrypt + per-hash salt + server pepper (ADR-0049).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';

const DEFAULT_STORE = path.join(__dirname, '..', 'data', 'users.json');
const DEFAULT_COST = 12;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;

const DEV_PEPPERS = new Set([
    '',
    'dev_pepper_change_in_production',
    'change_me_use_a_long_random_pepper_at_least_32_chars',
]);

interface UserRecord {
    password_hash: string;
    home_region: string;
    created_at: string;
}

interface UserStore {
    users: Record<string, UserRecord>;
}

export type RegisterResult =
    | { ok: true; username: string; home_region: string }
    | { ok: false; status: number; error: string };

export type AuthResult =
    | { ok: true; username: string; home_region: string }
    | { ok: false; status: number; error: string };

function storePath(): string {
    return process.env.USER_STORE_PATH || DEFAULT_STORE;
}

export function bcryptCost(): number {
    const n = parseInt(process.env.BCRYPT_COST || String(DEFAULT_COST), 10);
    if (!Number.isFinite(n) || n < 10 || n > 15) return DEFAULT_COST;
    return n;
}

export function getPepper(): string {
    return process.env.PASSWORD_PEPPER || '';
}

export function pepperedMaterial(password: string, pepper: string): string {
    return crypto.createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
    const material = pepperedMaterial(password, pepper);
    return bcrypt.hash(material, bcryptCost());
}

export async function verifyPassword(
    password: string,
    pepper: string,
    storedHash: string,
): Promise<boolean> {
    const material = pepperedMaterial(password, pepper);
    return bcrypt.compare(material, storedHash);
}

export function warnInsecurePepper(): void {
    const pepper = getPepper();
    if (!DEV_PEPPERS.has(pepper)) return;
    console.warn(
        'backend-test-service: PASSWORD_PEPPER is empty or a known dev default — rotate before production (ADR-0049)',
    );
}

function loadStore(): UserStore {
    const file = storePath();
    try {
        if (!fs.existsSync(file)) return { users: {} };
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as Partial<UserStore>;
        return parsed && typeof parsed.users === 'object' ? { users: parsed.users } : { users: {} };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`user store read failed: ${message}`);
    }
}

function saveStore(data: UserStore): void {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function validateUsername(username: string): string | null {
    if (!USERNAME_RE.test(username)) {
        return 'username must be 3–64 chars (letters, digits, . _ -)';
    }
    return null;
}

export function validatePassword(password: string): string | null {
    if (typeof password !== 'string') return 'password required';
    if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
        return `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters`;
    }
    return null;
}

const DUMMY_HASH = bcrypt.hashSync('no-such-user-dummy', bcryptCost());

export async function registerUser({
    username,
    password,
    homeRegion,
    pepper,
}: {
    username: string;
    password: string;
    homeRegion: string;
    pepper: string;
}): Promise<RegisterResult> {
    const userErr = validateUsername(username);
    if (userErr) return { ok: false, status: 400, error: userErr };
    const passErr = validatePassword(password);
    if (passErr) return { ok: false, status: 400, error: passErr };
    if (!pepper) {
        return { ok: false, status: 500, error: 'PASSWORD_PEPPER not configured' };
    }

    const store = loadStore();
    if (store.users[username]) {
        return { ok: false, status: 409, error: 'username already exists' };
    }

    const passwordHash = await hashPassword(password, pepper);
    store.users[username] = {
        password_hash: passwordHash,
        home_region: homeRegion || 'US',
        created_at: new Date().toISOString(),
    };
    saveStore(store);
    return { ok: true, username, home_region: store.users[username].home_region };
}

export async function authenticateUser({
    username,
    password,
    pepper,
}: {
    username: string;
    password: string;
    pepper: string;
}): Promise<AuthResult> {
    if (!username || !password) {
        return { ok: false, status: 400, error: 'username and password required' };
    }
    if (!pepper) {
        return { ok: false, status: 500, error: 'PASSWORD_PEPPER not configured' };
    }

    const store = loadStore();
    const record = store.users[username];
    const hash = record ? record.password_hash : DUMMY_HASH;
    const match = await verifyPassword(password, pepper, hash);
    if (!record || !match) {
        return { ok: false, status: 401, error: 'invalid username or password' };
    }
    return {
        ok: true,
        username,
        home_region: record.home_region || 'US',
    };
}
