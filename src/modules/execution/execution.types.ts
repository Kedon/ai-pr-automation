export interface ExecutionResult {
  jobId?: string;
  status: string;
  skipped?: boolean;
  reason?: string;
  pullRequestUrl?: string;
}

export interface ExecutionProvider {
  execute(jobId: string): Promise<ExecutionResult>;
}

