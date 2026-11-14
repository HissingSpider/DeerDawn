export interface SkillSink {
  kind: 'dir' | 'file' | 'index';
  base: string;
}

export interface ToolProfile {
  tool: 'claude_web' | 'chatgpt_web' | 'cursor' | 'claude_code' | 'codex';
  surface: 'browser' | 'code' | 'cli';
  capture: string;
  injection: string;
  hostnames: string[];
  skill_sink?: SkillSink;
}

export declare function getToolProfile(tool: string): ToolProfile | null;
export declare function listSupportedTools(): ToolProfile[];
