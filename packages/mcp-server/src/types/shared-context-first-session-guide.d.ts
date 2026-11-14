declare module '*shared-context/src/firstSessionGuide.js' {
  export const INTERVIEW_QUESTIONS: string[];
  export function buildFirstSessionGuide(options?: { local?: boolean; readRepoWithoutAsking?: boolean }): string;
}
