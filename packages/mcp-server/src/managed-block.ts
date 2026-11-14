// DeerDawn's instruction block in a file that is the person's, typed for the
// TypeScript side. The rules live in shared-context's setup-status.js (which
// block is ours, how it is refreshed and removed) and are shared with
// apply_setup, so a boot, apply_setup and the CLI can never disagree about which
// bytes are DeerDawn's. That module is CommonJS and its declaration shim names
// only what older callers use, so what is read here is typed at the point of use,
// and read at call time.

import * as setupStatus from '../../shared-context/src/setup-status.js';

type OwnedBlock = { start: number; end: number; legacy: boolean };
type RemoveResult = { surface: string; removed: boolean; path: string | null; backup_path?: string; reason: string | null; remaining?: 'owned' | 'other_install'; note?: string };
type AdoptResult = { surface: string; adopted: boolean; path: string | null; backup_path?: string; reason: string | null };
type KeyRemoval = { path: string; removed: boolean; backup_path?: string; redacted_backups?: number; reason: string | null };
export type PlainTextKey = { path: string; tool: string; entry: string | null; readable?: boolean; remove_with: string | null; summary: string };

const api = setupStatus as unknown as {
  getBlockToken(options?: { create?: boolean }): string | null;
  findOwnedBlock(text: string, token: string | null): OwnedBlock | null;
  upsertOwnedBlock(text: string, block: string, token: string | null): string;
  removeOwnedBlock(text: string, token: string | null): string | null;
  removeStaleBlock(surface: string, options?: { runningSurface?: string | null }): RemoveResult;
  adoptForeignBlock(surface: string): AdoptResult;
  removePlainTextKeys(): KeyRemoval[];
  findPlainTextKeys(home: string): PlainTextKey[];
};

/** This install's block token; made on first use unless `create` is false. null when it cannot be stored. */
export const getBlockToken = (options?: { create?: boolean }): string | null => api.getBlockToken(options);

/** DeerDawn's block in `text` (this install's token, or the older shape once), or null. */
export const findOwnedBlock = (text: string, token: string | null): OwnedBlock | null => api.findOwnedBlock(text, token);

/** `text` with DeerDawn's block refreshed to `block`, or `block` added. */
export const upsertOwnedBlock = (text: string, block: string, token: string | null): string => api.upsertOwnedBlock(text, block, token);

/** On request: take a stale block out of a tool's instruction file. */
export const removeStaleBlock = (surface: string, options?: { runningSurface?: string | null }): RemoveResult => api.removeStaleBlock(surface, options);

/** On request: make a block another install wrote this install's own (the token was lost with ~/.deerdawn). */
export const adoptForeignBlock = (surface: string): AdoptResult => api.adoptForeignBlock(surface);

/** On request: delete the plain-text API key from the files that hold one where the tool reads none. */
export const removePlainTextKeys = (): KeyRemoval[] => api.removePlainTextKeys();

export const findPlainTextKeys = (home: string): PlainTextKey[] => api.findPlainTextKeys(home);
