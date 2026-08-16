/**
 * Test MongoDB connection strings (one per line).
 * Usage:
 *   node dev/scripts/test-mongodb-uris.mjs dev/mongodb-uris.local.txt
 *   node dev/scripts/test-mongodb-uris.mjs   # uses MONGODB_URI from dev/.env
 *
 * File format: label|mongodb+srv://...  or just mongodb+srv://...
 * gitignored: dev/mongodb-uris.local.txt
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devRoot = resolve(__dirname, '..');
const repoRoot = resolve(devRoot, '..');

function loadDotEnv(path) {
    if (!existsSync(path)) return {};
    const out = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

function maskUri(uri) {
    return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

function ensureUamDb(uri) {
    const u = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'));
    if (!u.pathname || u.pathname === '/' || u.pathname === '') {
        u.pathname = '/uam';
    }
    const proto = uri.startsWith('mongodb+srv://') ? 'mongodb+srv' : 'mongodb';
    const auth = u.username
        ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}@`
        : '';
    const host = u.host;
    const path = u.pathname.replace(/^\//, '');
    const search = u.search || '?retryWrites=true&w=majority';
    return `${proto}://${auth}${host}/${path}${search}`;
}

function parseCandidates(argPath) {
    const candidates = [];
    if (argPath) {
        const full = resolve(process.cwd(), argPath);
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            if (trimmed.includes('|')) {
                const [label, uri] = trimmed.split('|').map((s) => s.trim());
                candidates.push({ label: label || maskUri(uri), uri });
            } else {
                candidates.push({ label: maskUri(trimmed), uri: trimmed });
            }
        }
        return candidates;
    }

    const devEnv = loadDotEnv(resolve(devRoot, '.env'));
    const devSecrets = loadDotEnv(resolve(devRoot, '.env.dev'));
    const backendEnv = loadDotEnv(resolve(repoRoot, 'uam-backend/.env'));
    const backendSecrets = loadDotEnv(resolve(repoRoot, 'uam-backend/.env.dev'));
    const uri = process.env.MONGODB_URI
        || devSecrets.MONGODB_URI
        || devEnv.MONGODB_URI
        || backendSecrets.MONGODB_URI
        || backendEnv.MONGODB_URI;
    if (uri) {
        candidates.push({ label: 'dev/.env.dev MONGODB_URI', uri });
    }
    return candidates;
}

async function tryConnect(label, rawUri) {
    const uri = ensureUamDb(rawUri);
    const started = Date.now();
    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 12_000,
            connectTimeoutMS: 12_000,
        });
        const ping = await mongoose.connection.db.admin().command({ ping: 1 });
        const dbName = mongoose.connection.db.databaseName;
        const collections = await mongoose.connection.db.listCollections().toArray();
        await mongoose.disconnect();
        return {
            ok: true,
            label,
            uri: maskUri(uri),
            ms: Date.now() - started,
            dbName,
            collectionCount: collections.length,
            collections: collections.map((c) => c.name).sort(),
            ping,
        };
    } catch (err) {
        try {
            await mongoose.disconnect();
        } catch {
            // ignore
        }
        return {
            ok: false,
            label,
            uri: maskUri(uri),
            ms: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

const arg = process.argv[2];
const candidates = parseCandidates(arg);

if (candidates.length === 0) {
    console.error('No URIs to test. Set MONGODB_URI in dev/.env.dev or pass dev/mongodb-uris.local.txt');
    process.exit(1);
}

console.log(`Testing ${candidates.length} MongoDB URI(s) (database forced to /uam if missing)...\n`);

const results = [];
for (const { label, uri } of candidates) {
    const result = await tryConnect(label, uri);
    results.push(result);
    if (result.ok) {
        console.log(`OK   ${result.label}`);
        console.log(`     ${result.uri}`);
        console.log(`     db=${result.dbName} collections=[${result.collections.join(', ')}] (${result.ms}ms)\n`);
    } else {
        console.log(`FAIL ${result.label}`);
        console.log(`     ${result.uri}`);
        console.log(`     ${result.error} (${result.ms}ms)\n`);
    }
}

const winner = results.find((r) => r.ok);
if (winner) {
    console.log(`Use: ${winner.label}`);
    process.exit(0);
}

console.error('No working URI found.');
process.exit(1);
