'use strict';

// What start_session says to the model when the account has NO projects.
//
// Session one used to be cold. On the hosted server (Claude.ai, ChatGPT and
// every remote connector, where most real users are) an empty account got the
// overview placeholder "What matters now / - No active workspace summary yet."
// and nothing else: no project, no brief, no next step. The "No DeerDawn
// context yet" fallback beneath it could never fire, because the placeholder
// clears its emptiness check. The local server did better, but only when a
// CLAUDE.md, AGENTS.md or .cursorrules was present.
//
// It used to open with a question: "is this for a codebase that already
// exists, or a new project?", then four interview questions. That is a
// questionnaire handed to a model that is in the middle of answering
// something else. Of the 8 real ChatGPT approvers from 09-25 to 10-02, the 2
// who connected were shown this guide after start_session and then made NO
// second tool call. The person had asked their own question, the model
// answered it, the setup questions went unasked or unanswered, and nothing
// was saved. An account with no saved project can never receive a brief, so
// first_sync_completed stayed at 0 by construction and the next session got
// the same guide again. E-035.
//
// So session one now starts the brief from what is already in front of the
// model, in the same turn, without stopping to ask:
//   * Files readable: the repo's own sources (context files, README, recent
//     commit subjects). Local, with a context file: import_local.
//   * No file access (Claude.ai, ChatGPT): what the user has said in this
//     conversation about the work.
// It then tells the user, in one line, what was saved, so the first session
// shows something and the user can correct it. The interview questions
// survive only as the fallback for a conversation that says nothing about the
// project yet, and are asked after the user's own request is answered.
//
// Voice: this is a TOOL RESULT describing how to set up the user's own account,
// not an app-level instruction field. Nothing here tells the model to prefer
// DeerDawn over other tools or to put a call ahead of answering the user.
//
// Both dispatchers render it from here, so the two cannot drift.

const INTERVIEW_QUESTIONS = [
  'What are you building, and who is it for?',
  'What stack are you using, or planning to?',
  'What are you working on first?',
  'Any decisions already made, and why?',
];

/**
 * @param {{ local?: boolean, readRepoWithoutAsking?: boolean }} [options]
 *   local: the stdio server, running in the user's checkout, where
 *   manage_memory(action:"import_local") can read the context files directly.
 *   readRepoWithoutAsking (local only): the person said yes at `setup` to the
 *   first brief being built from the README, context files and recent commit
 *   subjects. Without that yes, the local guide asks before it reads any of
 *   them (Thing 4.5): a file the person never chose to send is not read and
 *   sent on a guess. The hosted variant is unchanged.
 */
function buildFirstSessionGuide(options = {}) {
  const local = options.local === true;
  const askFirst = local && options.readRepoWithoutAsking !== true;
  const sources = askFirst
    ? [
      '1. Ask the user once before reading anything here: "Can DeerDawn start this project\'s brief from the README,',
      '   CLAUDE.md or AGENTS.md, and the last 20 commit subjects?" Read them only after a yes:',
      '   - This checkout has a CLAUDE.md, AGENTS.md or .cursorrules: call `manage_memory(action:"import_local")`',
      '     and go to step 3.',
      '   - Otherwise read the README and the last ~20 commit subjects (`git log --oneline -20`).',
      '   After a no, or with no codebase here: use what the user has said in this conversation about the work.',
    ]
    : local
    ? [
      '1. Take the project from what is already here, without stopping to ask:',
      '   - This checkout has a CLAUDE.md, AGENTS.md or .cursorrules: call `manage_memory(action:"import_local")`',
      '     and go to step 3.',
      '   - Otherwise read the README and the last ~20 commit subjects (`git log --oneline -20`).',
      '   - No codebase here: use what the user has said in this conversation about the work.',
    ]
    : [
      '1. Take the project from what is already here, without stopping to ask:',
      '   - You can read a codebase in this tool: read CLAUDE.md, AGENTS.md or .cursorrules if present, the README,',
      '     and the last ~20 commit subjects.',
      '   - You cannot read files (as in Claude.ai or ChatGPT): use what the user has said in this conversation',
      '     about what they are working on.',
      '   - The user asked you to add the projects they are working on: also use what you already know from their',
      '     earlier chats or memory, and create one project per project, each with its own brief.',
    ];
  return [
    'No DeerDawn context yet: this account has no projects, so there is no brief to load.',
    '',
    'Start the first brief in this conversation, so the next session opens already briefed:',
    ...sources,
    '2. Call `manage_projects(action:"create")` with the project or repo name, then `manage_memory(action:"update")`',
    '   with the current task and any stack, goals, decisions and open questions the user or the files actually state.',
    '3. In your reply to the user, add one line saying what DeerDawn saved (for example "DeerDawn saved: <project>,',
    '   working on <task>"), so they can see it and correct it.',
    '',
    'If nothing yet says what the project is, do not invent one. Answer the user, then ask these in one message:',
    ...INTERVIEW_QUESTIONS.map((q) => `   - ${q}`),
    '   and save the answers the same way.',
    '',
    'Save only what the user said or the files state; never fill gaps with guesses. A task and a name are enough',
    'to start. The brief grows as you work.',
  ].join('\n');
}

module.exports = { buildFirstSessionGuide, INTERVIEW_QUESTIONS };
