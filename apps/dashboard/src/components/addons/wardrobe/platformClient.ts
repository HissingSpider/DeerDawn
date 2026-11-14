// The Wardrobe page reaches the add-on platform only through this file. It was a
// local stand-in while the platform was built in parallel; it now re-exports the
// platform client so the page has one import site to change if that ever moves.
export {
  runAddonAction,
  uploadAddonAttachment,
  addonAttachmentUrl,
  deleteAddonAttachment,
  setAddonEnabled,
  listAddonAttachments,
} from '@/lib/addonsApi';
export type { AddonActionResult, AddonAttachment, AddonImage, AddonVariant } from '@/lib/addonsApi';
