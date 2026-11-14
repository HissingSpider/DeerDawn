import type { DeerdawnClient } from '../client.js';
import { handleApiError } from '../utils/errors.js';
import { contextSyncAssistantPrompt } from './context-sync.js';

export const prompts = [
  {
    name: 'session-brief-assistant',
    description: 'Load DeerDawn session memory instructions so the AI is briefed with your project at conversation start — your task, decisions, and where you left off — and keeps the brief current as work progresses',
    arguments: [],
  },
];

export function listPrompts() {
  return prompts;
}

export async function getPrompt(name: string, args: any, client: DeerdawnClient) {
  try {
    if (name !== 'session-brief-assistant') throw new Error(`Unknown prompt: ${name}`);
    const content = await contextSyncAssistantPrompt(client);
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: content },
      }],
    };
  } catch (error) {
    handleApiError(error);
  }
}
