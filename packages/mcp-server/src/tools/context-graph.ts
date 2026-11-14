import { z } from 'zod';
import type { DeerdawnClient } from '../client.js';
import { handleApiError } from '../utils/errors.js';
import { formatJson } from '../utils/formatting.js';

const InspectContextGraphSchema = z.object({
  project_id: z.string().min(1).optional().describe('Project id to inspect'),
  session_id: z.string().min(1).optional().describe('Session id to inspect'),
  node_id: z.string().min(1).optional().describe('Graph node id to inspect'),
}).refine((value) => value.project_id || value.session_id || value.node_id, {
  message: 'project_id, session_id, or node_id is required',
});

export const contextGraphTools = [
  {
    name: 'inspect_context_graph',
    description: 'Read the Deerdawn context knowledge web for a project, session, or specific graph node.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id to inspect' },
        session_id: { type: 'string', description: 'Session id to inspect' },
        node_id: { type: 'string', description: 'Specific graph node id to inspect' },
      },
    },
  },
];

export async function handleContextGraphTool(name: string, args: any, client: DeerdawnClient) {
  try {
    switch (name) {
      case 'inspect_context_graph': {
        const validated = InspectContextGraphSchema.parse(args);
        const result = validated.node_id
          ? await client.getContextGraphNode(validated.node_id)
          : validated.session_id
          ? await client.getContextGraphSession(validated.session_id)
          : await client.getContextGraphProject(validated.project_id!);
        return {
          content: [{
            type: 'text',
            text: formatJson(result),
          }],
        };
      }
      default:
        throw new Error(`Unknown context graph tool: ${name}`);
    }
  } catch (error) {
    handleApiError(error);
  }
}
