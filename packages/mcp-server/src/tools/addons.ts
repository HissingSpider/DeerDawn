import type { DeerdawnClient } from '../client.js';

// ─── Add-ons: two fixed tools for every add-on ──────────────────────────────
//
// PARITY with apps/api/src/routes/mcp.js (read_addon / use_addon). Both sides
// are thin: they forward to POST /api/v1/addons/:id/actions/:action, where the
// one runner (apps/api/src/addons/runner.js) does everything — enablement,
// person scoping, the read/write split, argument validation. read_addon sends
// `via: "read"`, and the server refuses a write action on that path.
//
// Descriptions are kept short on purpose: tools/list is a budget
// (tests/tool-surface.test.ts), and `help` returns each add-on's actions on
// demand, so these two cost the same with one add-on or fifty.

const ADDON_INPUT = {
  type: 'object',
  required: ['addon', 'action'],
  properties: {
    addon: { type: 'string', description: 'Add-on id, e.g. "wardrobe".' },
    action: { type: 'string', description: 'The action to run; "help" lists them.' },
    args: { type: 'object', description: 'Arguments for the action (see help). include_data: true adds the structured result.' },
  },
} as const;

export const addonTools = [
  {
    name: 'read_addon',
    description: 'Run a read action of an enabled add-on, such as listing its records. Call action "help" first to see its actions and argument shapes. Reads only your own add-on data and does not create, change, or delete anything.',
    inputSchema: ADDON_INPUT,
  },
  {
    name: 'use_addon',
    description: 'Run any action of an enabled add-on, including writes that create, update or permanently delete your own add-on records. Call read_addon with action "help" first for the actions and argument shapes.',
    inputSchema: ADDON_INPUT,
  },
];

export const ADDON_TOOL_NAMES = new Set(addonTools.map((tool) => tool.name));

export async function handleAddonTool(name: string, args: any, client: DeerdawnClient) {
  const addon = typeof args?.addon === 'string' ? args.addon.trim() : '';
  const action = typeof args?.action === 'string' ? args.action.trim() : '';
  if (!addon || !action) {
    return { content: [{ type: 'text', text: `${name} needs both "addon" and "action". Call read_addon with action "help" to see an add-on's actions.` }], isError: true };
  }
  // PARITY with the hosted runner.splitIncludeData / forMcp: text (and images)
  // only, unless the caller passes include_data: true or the action returned
  // no text. `data` repeats the text and roughly doubles a large listing.
  const actionArgs: Record<string, unknown> = args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? { ...args.args } : {};
  const includeData = actionArgs.include_data === true;
  delete actionArgs.include_data;
  const outcome = await client.runAddonAction(addon, action, actionArgs, name === 'read_addon' ? 'read' : 'write');
  if (!outcome.ok) {
    return { content: [{ type: 'text', text: `${outcome.error}: ${outcome.message}` }], isError: true };
  }
  const { text, data, images } = outcome.result;
  const content: any[] = [{ type: 'text', text }];
  for (const image of images) content.push({ type: 'image', data: image.base64, mimeType: image.mime });
  const keepData = Boolean(data) && (includeData || !text);
  return { content, structuredContent: { text, ...(keepData ? { data } : {}) } };
}
