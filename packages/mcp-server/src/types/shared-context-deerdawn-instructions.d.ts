declare module '../../shared-context/src/deerdawnInstructions.js' {
  export const OPEN_MARKER: string;
  export const CLOSE_MARKER: string;
  export function buildDeerdawnInstructionLines(): string[];
  export const MARKER_NAME_PREFIX: string;
  export const BLOCK_NOTICE: string;
  export function isBlockToken(value: unknown): value is string;
  export function openMarkerFor(token: string): string;
  export function closeMarkerFor(token: string): string;
  export function ownedMarkersFor(token: string): { open: string; openPattern: RegExp; close: string };
  export function buildDeerdawnInstructionBlock(token?: string | null): string;
  export function buildCursorInstructionBlock(token?: string | null): string;
}

declare module '*shared-context/src/deerdawnInstructions.js' {
  export const OPEN_MARKER: string;
  export const CLOSE_MARKER: string;
  export function buildDeerdawnInstructionLines(): string[];
  export const MARKER_NAME_PREFIX: string;
  export const BLOCK_NOTICE: string;
  export function isBlockToken(value: unknown): value is string;
  export function openMarkerFor(token: string): string;
  export function closeMarkerFor(token: string): string;
  export function ownedMarkersFor(token: string): { open: string; openPattern: RegExp; close: string };
  export function buildDeerdawnInstructionBlock(token?: string | null): string;
  export function buildCursorInstructionBlock(token?: string | null): string;
}
