// Single source of truth for the DeerDawn instruction block lives in
// shared-context so every surface (MCP, CLI files, setup) stays in sync — edit
// the lines there, not here. This module just re-exports for existing importers.
// See packages/shared-context/src/deerdawnInstructions.js
export {
  OPEN_MARKER,
  CLOSE_MARKER,
  MARKER_NAME_PREFIX,
  BLOCK_NOTICE,
  isBlockToken,
  openMarkerFor,
  closeMarkerFor,
  ownedMarkersFor,
  buildDeerdawnInstructionLines,
  buildDeerdawnInstructionBlock,
  buildCursorInstructionBlock,
} from '../../shared-context/src/deerdawnInstructions.js';

// Canonical instruction string injected via the MCP `initialize` response.
export { buildMcpInstructions } from '../../shared-context/src/mcpInstructions.js';
