/**
 * The request body the Memory page's "Add context" modal sends to /seed for a
 * pasted document or a chosen file (the "Paste text" and "From file" tabs).
 *
 * The source is `file_import`. /seed must list it: it was missing, and both
 * tabs were refused with a 400 (journey scan round 4, BLOCKED 26).
 */

export const FILE_IMPORT_SOURCE = 'file_import' as const;

export type SeedProject = { name: string; conversations: { messages: { role: string; text: string }[] }[] };

const oneProject = (name: string, text: string): SeedProject => ({
  name,
  conversations: [{ messages: [{ role: 'user', text }] }],
});

/**
 * Splits on numbered section headers like "1. PROJECT NAME\n=====" and names
 * each project from its header. Text with no such headers goes as one project.
 * Sections of 50 characters or fewer are dropped as too thin; if that leaves
 * none, the whole text goes as one project, since /seed refuses an empty list
 * and the person would be told only that something was "too small".
 */
export function parseContextText(text: string): SeedProject[] {
  const sections = text.split(/\n(?=\d+\.\s+[A-Z][^\n]{3,}(?:\n[=\-]{4,})?)/);
  if (sections.length > 1) {
    const projects = sections.map((s) => {
      const firstLine = s.match(/^\d+\.\s+(.+)/)?.[1]?.trim() || '';
      const name = firstLine
        .replace(/[/—-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ') || 'Imported project';
      return oneProject(name, s.trim());
    }).filter((p) => p.conversations[0].messages[0].text.length > 50);
    if (projects.length > 0) return projects;
  }
  return [oneProject('Imported context', text)];
}

export function fileImportBody(text: string): { source: typeof FILE_IMPORT_SOURCE; projects: SeedProject[] } {
  return { source: FILE_IMPORT_SOURCE, projects: parseContextText(text) };
}

/**
 * One line for the Paste text and From file tabs. Matches the pricing and
 * security pages: text is processed to build the brief, then discarded. With no
 * model answering, nothing is saved at all (see runExtractionForSeed).
 */
export const TEXT_NOT_STORED_NOTE = 'The extraction model summarises this text into your brief. The text itself is not stored.';
