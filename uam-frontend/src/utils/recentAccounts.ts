export interface RecentAccount {
    email: string;
    displayName: string;
    avatar?: string;
    provider: string;
    lastUsed: number;
}

const RECENT_ACCOUNTS_KEY = 'recent_accounts';
const MAX_RECENT_ACCOUNTS = 5;

export const getRecentAccounts = (): RecentAccount[] => {
    try {
        const stored = localStorage.getItem(RECENT_ACCOUNTS_KEY);
        if (!stored) return [];
        return JSON.parse(stored).sort((a: RecentAccount, b: RecentAccount) => b.lastUsed - a.lastUsed);
    } catch (error) {
        console.error('Error reading recent accounts:', error);
        return [];
    }
};

export const saveRecentAccount = (user: { email: string; displayName: string; avatar?: string; provider: string }) => {
    try {
        const accounts = getRecentAccounts();
        const existingIndex = accounts.findIndex(a => a.email === user.email);

        const newAccount: RecentAccount = {
            ...user,
            lastUsed: Date.now(),
        };

        if (existingIndex !== -1) {
            accounts.splice(existingIndex, 1);
        }

        accounts.unshift(newAccount);

        const updated = accounts.slice(0, MAX_RECENT_ACCOUNTS);
        localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(updated));
    } catch (error) {
        console.error('Error saving recent account:', error);
    }
};

export const clearAllRecentAccounts = (): void => {
    try {
        localStorage.removeItem(RECENT_ACCOUNTS_KEY);
    } catch {
        // ignore storage errors
    }
};

export const removeRecentAccount = (email: string) => {
    try {
        const accounts = getRecentAccounts().filter(a => a.email !== email);
        localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(accounts));
    } catch (error) {
        console.error('Error removing recent account:', error);
    }
};
