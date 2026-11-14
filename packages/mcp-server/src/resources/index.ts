import type { DeerdawnClient } from '../client.js';
import { handleApiError } from '../utils/errors.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  TASK_BOARD_WIDGET_URI,
  isTaskBoardUiEnabled,
  taskBoardResource,
  taskBoardWidgetHtml,
} from '../../../shared-context/src/index.js';

const SKILL_URI_RE = /^deerdawn:\/\/skills\/(.+)$/;

// Static URIs are an exact-match set; skill URIs are pattern-matched so a single
// deerdawn://skills/<slug> handler serves every skill without enumerating them.
const STATIC_RESOURCE_URIS = new Set([
  'deerdawn://context/projects',
  'deerdawn://skills/index',
]);

function isValidResourceUri(uri: string): boolean {
  if (isTaskBoardUiEnabled() && uri === TASK_BOARD_WIDGET_URI) return true;
  if (STATIC_RESOURCE_URIS.has(uri)) return true;
  return SKILL_URI_RE.test(uri);
}

export function listResources() {
  return [
    {
      uri: 'deerdawn://context/projects',
      name: 'My Projects',
      description: 'All projects in your DeerDawn context network — names, IDs, current status, and last updated',
      mimeType: 'application/json',
    },
    {
      uri: 'deerdawn://skills/index',
      name: 'Shared skills',
      description: 'Index of available DeerDawn shared skills (name, slug, description). Read deerdawn://skills/<slug> for one in full.',
      mimeType: 'application/json',
    },
    ...(isTaskBoardUiEnabled() ? [taskBoardResource()] : []),
  ];
}

export async function readResource(uri: string, client: DeerdawnClient) {
  try {
    if (typeof uri !== 'string' || uri.length > 200) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI format');
    }
    if (!isValidResourceUri(uri)) {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown resource type');
    }

    if (uri === TASK_BOARD_WIDGET_URI) {
      return {
        contents: [{
          uri,
          mimeType: taskBoardResource().mimeType,
          text: taskBoardWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
              widgetDescription: 'Interactive DeerDawn task board for the selected project.',
            },
          },
        }],
      };
    }

    // Skills index — JSON list of available shared skills.
    if (uri === 'deerdawn://skills/index') {
      const skills = await client.listSkills();
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(skills, null, 2),
        }],
      };
    }

    // Single skill — full markdown body for resource-capable clients.
    const skillMatch = SKILL_URI_RE.exec(uri);
    if (skillMatch) {
      const slug = decodeURIComponent(skillMatch[1]);
      const skill = await client.getSkill(slug);
      if (!skill) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${slug}`);
      }
      return {
        contents: [{
          uri,
          mimeType: 'text/markdown',
          text: skill.markdown_content || '',
        }],
      };
    }

    const projects = await client.listContextProjects();
    const summary = (projects || []).map((p: any) => ({
      project_id: p.project_id,
      project_name: p.project_name,
      current_status: p.context?.current_status,
      current_task: p.context?.current_task,
      updated_at: p.updated_at,
    }));

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(summary, null, 2),
      }],
    };
  } catch (error) {
    handleApiError(error);
  }
}
