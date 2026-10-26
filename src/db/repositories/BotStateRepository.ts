/** Generic key/value store for process-wide bot state (issue #47). */
export interface BotStateRepository {
    /** The stored value, or null when the key was never set. */
    get(key: string): Promise<string | null>;

    /** Stores the value, replacing any existing one for the key. */
    set(key: string, value: string): Promise<void>;
}
