export interface ImportMessage {
  role: string;
  text: string;
}

export interface ImportConversation {
  title?: string;
  messages: ImportMessage[];
}

export interface ImportProject {
  name: string;
  conversations: ImportConversation[];
}

// ChatGPT data export: conversations.json array
export function parseChatGPTExport(raw: unknown): ImportProject[] {
  if (!Array.isArray(raw)) throw new Error('Expected an array of conversations');

  // Group by workspace_id (ChatGPT Projects) or treat as ungrouped
  const groups = new Map<string, { name: string; conversations: ImportConversation[] }>();

  for (const convo of raw) {
    if (!convo || typeof convo !== 'object') continue;

    const title: string = convo.title || 'Untitled';
    const workspaceId: string = convo.workspace_id || convo.gizmo_id || '__ungrouped__';
    const groupName = workspaceId === '__ungrouped__' ? 'Imported conversations' : (convo.workspace_name || `Project ${workspaceId.slice(-6)}`);

    const messages: ImportMessage[] = [];

    // mapping is a dict of node_id -> { message: { author, content } }
    const mapping = convo.mapping || {};
    for (const node of Object.values(mapping) as any[]) {
      const msg = node?.message;
      if (!msg) continue;
      const role: string = msg.author?.role;
      if (!role || role === 'system' || role === 'tool') continue;
      const parts: string[] = msg.content?.parts || [];
      const text = parts.filter((p: any) => typeof p === 'string').join(' ').trim();
      if (!text || text.length < 10) continue;
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', text });
    }

    if (messages.length === 0) continue;

    if (!groups.has(workspaceId)) {
      groups.set(workspaceId, { name: groupName, conversations: [] });
    }
    groups.get(workspaceId)!.conversations.push({ title, messages });
  }

  return Array.from(groups.values()).filter((g) => g.conversations.length > 0);
}

// Claude data export — similar structure with different field names
export function parseClaudeExport(raw: unknown): ImportProject[] {
  if (!Array.isArray(raw)) throw new Error('Expected an array of conversations');

  const conversations: ImportConversation[] = [];

  for (const convo of raw) {
    if (!convo || typeof convo !== 'object') continue;
    const title: string = convo.name || convo.title || 'Untitled';
    const chatMessages: any[] = convo.chat_messages || convo.messages || [];
    const messages: ImportMessage[] = [];

    for (const msg of chatMessages) {
      const role = msg.sender === 'human' || msg.role === 'human' || msg.role === 'user' ? 'user' : 'assistant';
      const text: string = typeof msg.text === 'string'
        ? msg.text
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join(' ')
          : '';
      if (!text || text.trim().length < 10) continue;
      messages.push({ role, text: text.trim() });
    }

    if (messages.length > 0) conversations.push({ title, messages });
  }

  if (conversations.length === 0) return [];
  return [{ name: 'Imported from Claude', conversations }];
}

// Plain text paste — split on common role prefixes
export function parsePaste(text: string, projectName = 'Pasted conversation'): ImportProject[] {
  const lines = text.split('\n');
  const messages: ImportMessage[] = [];
  let currentRole = 'user';
  let currentText: string[] = [];

  const flush = () => {
    const t = currentText.join('\n').trim();
    if (t.length >= 10) messages.push({ role: currentRole, text: t });
    currentText = [];
  };

  for (const line of lines) {
    const lower = line.toLowerCase().trimStart();
    if (/^(human|user|you)\s*:/.test(lower)) {
      flush();
      currentRole = 'user';
      currentText.push(line.replace(/^(human|user|you)\s*:/i, '').trim());
    } else if (/^(assistant|claude|chatgpt|ai|gpt|gemini)\s*:/.test(lower)) {
      flush();
      currentRole = 'assistant';
      currentText.push(line.replace(/^(assistant|claude|chatgpt|ai|gpt|gemini)\s*:/i, '').trim());
    } else {
      currentText.push(line);
    }
  }
  flush();

  if (messages.length === 0) {
    // No role markers — treat whole thing as a single user message
    const t = text.trim();
    if (t.length >= 10) messages.push({ role: 'user', text: t });
  }

  if (messages.length === 0) return [];
  return [{ name: projectName, conversations: [{ messages }] }];
}

// Detect file type from filename and content
export async function parseImportFile(file: File): Promise<ImportProject[]> {
  const text = await file.text();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON — treat as paste
    return parsePaste(text);
  }

  // Claude export is typically { conversations: [...] }
  if (json && typeof json === 'object' && !Array.isArray(json) && Array.isArray((json as any).conversations)) {
    return parseClaudeExport((json as any).conversations);
  }

  // ChatGPT export is a top-level array
  if (Array.isArray(json)) {
    // Heuristic: ChatGPT has 'mapping' field, Claude has 'chat_messages'
    const first = json[0];
    if (first && typeof first === 'object') {
      if ('mapping' in first) return parseChatGPTExport(json);
      if ('chat_messages' in first || 'sender' in (first as any)) return parseClaudeExport(json);
    }
    // Fallback: try ChatGPT
    return parseChatGPTExport(json);
  }

  throw new Error('Unrecognised file format. Try a ChatGPT or Claude data export, or paste a conversation.');
}
