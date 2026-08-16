/**
 * Standalone contract tests (no MongoDB required).
 *
 *   npx ts-node --transpile-only src/scripts/test-auth-contract.ts
 *
 * Covers:
 *   - bcrypt + pepper round-trip
 *   - legacy un-peppered hash acceptance + rehash signal (migration safety)
 *   - wrong password rejection
 *   - no-pepper fallback mode
 *   - access-token claim contract expected by the API gateway
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Ensure a deterministic pepper before importing the util (read at call time).
process.env.PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || 'unit_test_pepper_value_1234567890';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit_test_access_secret';
process.env.JWT_ISSUER = 'api-gateway-auth-server';
process.env.JWT_AUDIENCE = 'api-gateway-clients';
process.env.DEFAULT_HOME_REGION = 'US';

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { hashPassword, verifyPassword } from '../utils/password.util';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
    if (cond) {
        passed++;
        // eslint-disable-next-line no-console
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        // eslint-disable-next-line no-console
        console.error(`  FAIL  ${name}`);
    }
}

async function run(): Promise<void> {
    const password = 'S3cure!Passw0rd';

    // 1. Current scheme round-trip.
    const hash = await hashPassword(password);
    check('hash is a bcrypt string', /^\$2[aby]\$\d{2}\$/.test(hash));
    const ok = await verifyPassword(password, hash);
    check('correct password matches', ok.match === true);
    check('current-scheme hash does not need rehash', ok.needsRehash === false);

    // 2. Wrong password rejected.
    const bad = await verifyPassword('wrong-password', hash);
    check('wrong password rejected', bad.match === false);

    // 3. Pepper actually changes the digest (legacy plain hash must NOT match peppered compare directly).
    const legacyHash = await bcrypt.hash(password, 10); // pre-pepper style
    const legacy = await verifyPassword(password, legacyHash);
    check('legacy un-peppered hash still authenticates', legacy.match === true);
    check('legacy hash is flagged for rehash (migration)', legacy.needsRehash === true);

    // 4. No-pepper fallback mode.
    const savedPepper = process.env.PASSWORD_PEPPER;
    delete process.env.PASSWORD_PEPPER;
    const plainHash = await hashPassword(password);
    const plainVerify = await verifyPassword(password, plainHash);
    check('no-pepper mode: hash + verify works', plainVerify.match === true);
    check('no-pepper mode: no spurious rehash', plainVerify.needsRehash === false);
    process.env.PASSWORD_PEPPER = savedPepper;

    // 5. Access-token claim contract (gateway expectations).
    // Imported here so config picks up the env set above.
    const { generateAccessToken } = await import('../services/token.service');
    const fakeUser = { _id: { toString: () => 'user_abc123' }, email: 'tester@example.com' } as never;
    const token = generateAccessToken(fakeUser);
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET as string) as Record<string, unknown>;

    check('token has sub == userId', decoded.sub === 'user_abc123');
    check('token type is access', decoded.type === 'access');
    check('token issuer matches gateway', decoded.iss === 'api-gateway-auth-server');
    check('token audience matches gateway', decoded.aud === 'api-gateway-clients');
    check('token has home_region', decoded.home_region === 'US');
    check('token has jti', typeof decoded.jti === 'string' && (decoded.jti as string).length > 0);
    check('token has tv (token version)', decoded.tv === 0);
    check('token has exp', typeof decoded.exp === 'number');
    check('token has iat', typeof decoded.iat === 'number');

    // eslint-disable-next-line no-console
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
