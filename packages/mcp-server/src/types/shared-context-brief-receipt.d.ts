declare module '*shared-context/src/briefReceipt.js' {
  export type BriefReceiptInput = {
    projectName: string;
    decisions?: number | null;
    openQuestions?: number | null;
    lastSavedAt?: string | Date | null;
    lastSavedTool?: string | null;
    nextAction?: string | null;
    now?: string | number | Date;
  };
  export function formatBriefReceipt(input?: BriefReceiptInput): string | null;
  export function briefReceiptInputs(project: unknown, options?: { now?: string | number | Date }): BriefReceiptInput | null;
  export function receiptToolLabel(tool: unknown): string | null;
  export function receiptWhen(at: unknown, now?: unknown): string | null;
}
