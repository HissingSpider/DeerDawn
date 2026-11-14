// The y/N questions `setup` asks. Only a person at a terminal can answer them:
// with stdin or stdout not a TTY (an agent running setup for somebody, a script,
// CI) nobody is there, and `null` comes back so the caller can treat it as "not
// asked", which for every question setup asks means no.

import readline from 'readline';

export function canAsk(io: { stdinIsTTY: boolean; stdoutIsTTY: boolean } = {
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
}): boolean {
  return io.stdinIsTTY && io.stdoutIsTTY;
}

/** "y"/"yes" is yes, "n"/"no" is no, anything else (Enter included) is the default. */
export function parseYesNo(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return true;
  if (a === 'n' || a === 'no') return false;
  return defaultYes;
}

/** Ask once. null when there is nobody to ask. */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean | null> {
  if (!canAsk()) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, resolve));
    return parseYesNo(answer, defaultYes);
  } finally {
    rl.close();
  }
}
