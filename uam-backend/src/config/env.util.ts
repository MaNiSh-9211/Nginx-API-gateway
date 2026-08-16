/** Parse positive integer env vars with a safe fallback. */
export function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse boolean env vars (1/true/yes/on). */
export function envBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes' || raw.toLowerCase() === 'on';
}
