import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    registerUser,
    authenticateUser,
    hashPassword,
    verifyPassword,
    pepperedMaterial,
} from './users';

const PEPPER = 'test-pepper-secret-for-unit-tests';
const tmpStore = path.join(os.tmpdir(), `users-test-${process.pid}.json`);

process.env.USER_STORE_PATH = tmpStore;
process.env.PASSWORD_PEPPER = PEPPER;
process.env.BCRYPT_COST = '10';

function cleanup(): void {
    try {
        fs.unlinkSync(tmpStore);
    } catch {
        // ignore
    }
}

async function run(): Promise<void> {
    cleanup();
    let passed = 0;

    const peppered = pepperedMaterial('hunter2', PEPPER);
    assert.notStrictEqual(peppered, 'hunter2');
    passed++;

    const hash = await hashPassword('hunter2', PEPPER);
    assert(hash.startsWith('$2'));
    assert(await verifyPassword('hunter2', PEPPER, hash));
    assert(!(await verifyPassword('wrong', PEPPER, hash)));
    passed++;

    const reg = await registerUser({
        username: 'alice',
        password: 'password123',
        homeRegion: 'EU',
        pepper: PEPPER,
    });
    assert.strictEqual(reg.ok, true);
    passed++;

    const dup = await registerUser({
        username: 'alice',
        password: 'otherpass99',
        homeRegion: 'US',
        pepper: PEPPER,
    });
    assert.strictEqual(dup.ok, false);
    if (!dup.ok) assert.strictEqual(dup.status, 409);
    passed++;

    const bad = await authenticateUser({ username: 'alice', password: 'nope1234', pepper: PEPPER });
    assert.strictEqual(bad.ok, false);
    if (!bad.ok) assert.strictEqual(bad.status, 401);
    passed++;

    const good = await authenticateUser({
        username: 'alice',
        password: 'password123',
        pepper: PEPPER,
    });
    assert.strictEqual(good.ok, true);
    if (good.ok) assert.strictEqual(good.home_region, 'EU');
    passed++;

    const raw = JSON.parse(fs.readFileSync(tmpStore, 'utf8')) as {
        users: Record<string, { password_hash: string }>;
    };
    assert(raw.users.alice.password_hash.startsWith('$2'));
    assert.strictEqual(raw.users.alice.password_hash.includes('password123'), false);
    passed++;

    cleanup();
    console.log(`users.test.ts: ${passed} assertions passed`);
}

run().catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
});
