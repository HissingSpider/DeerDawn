import { isApiError, apiErrorReason } from '@/lib/api';
import { runAddonAction } from './platformClient';

export const ADDON_ID = 'wardrobe';

export const CATEGORIES = ['top', 'bottom', 'outerwear', 'shoes', 'accessory', 'one-piece'] as const;
export const STATUSES = ['active', 'stored', 'laundry', 'repair', 'donated', 'wishlist'] as const;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export const VERDICTS = ['loved', 'fine', 'rejected'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Status = (typeof STATUSES)[number];
export type Season = (typeof SEASONS)[number];
export type Verdict = (typeof VERDICTS)[number];

export type WardrobeItem = {
  id: string;
  ref: string;
  name: string;
  category?: Category | null;
  subcategory?: string | null;
  colors?: string[];
  pattern?: string | null;
  material?: string | null;
  formality?: number | null;
  warmth?: number | null;
  seasons?: Season[];
  fit?: string | null;
  brand?: string | null;
  size?: string | null;
  notes?: string | null;
  status: Status;
  location?: string | null;
  acquired?: string | null;
  cost?: number | null;
  photo_ids?: string[];
  cover_photo_id?: string | null;
  wear_count?: number;
  last_worn?: string | null;
  description?: string | null;
  tags_confirmed?: boolean;
  tag_source?: 'vision' | 'agent' | 'user' | null;
  tag_error?: string | null;
};

export type OutfitItem = { id: string; ref?: string; name?: string; category?: string | null; cover_photo_id?: string | null; removed?: boolean };

export type WardrobeOutfit = {
  id: string;
  ref: string;
  name: string;
  item_ids: string[];
  items?: OutfitItem[];
  styles?: string[];
  occasions?: string[];
  verdict: Verdict;
  reason?: string | null;
  notes?: string | null;
  made_by?: 'agent' | 'user';
  worn_dates?: string[];
};

export type WardrobeStyle = {
  id: string;
  name: string;
  description?: string | null;
  do?: string[];
  dont?: string[];
  palette?: string[];
  outfit_count?: number;
};

export type WardrobeProfile = {
  id: string;
  preferences?: string[];
  sizes?: Record<string, string>;
  notes?: string | null;
};

// Every action answers { text, data }. A refusal is data.ok === false with the
// reason in text; surface that text rather than a generic error.
export class WardrobeRefusal extends Error {}

export async function wardrobe<T = Record<string, unknown>>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await runAddonAction<T & { ok?: boolean }>(ADDON_ID, action, args);
  const data = (res.data || {}) as T & { ok?: boolean };
  if (data.ok === false) throw new WardrobeRefusal(res.text);
  return data;
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Try again.';
}

export const label = (s: string) => (s === 'one-piece' ? 'One-piece' : s.charAt(0).toUpperCase() + s.slice(1));

// The platform answers 409 addon_disabled until the add-on is turned on for
// the workspace.
export function isAddonDisabled(err: unknown): boolean {
  return isApiError(err) && (apiErrorReason(err) === 'addon_disabled' || (err.status === 409 && /disabled|not enabled/i.test(err.message)));
}
