import { Injectable } from '@nestjs/common';
import { AgentJobExecutorService } from '../agent-jobs/agent-job-executor.service';
import { CodexExecutionService } from './codex-execution.service';
import { ExecutionResult } from './execution.types';

@Injectable()
export class ExecutionOrchestratorService {
  constructor(
    private readonly bootstrapExecutionService: AgentJobExecutorService,
    private readonly codexExecutionService: CodexExecutionService,
  ) {}

  async execute(jobId: string): Promise<ExecutionResult> {
    const provider = (process.env.EXECUTION_PROVIDER?.trim() || 'bootstrap').toLowerCase();

    if (provider === 'codex') {
      return this.codexExecutionService.execute(jobId);
    }

    return this.bootstrapExecutionService.execute(jobId);
  }
}

