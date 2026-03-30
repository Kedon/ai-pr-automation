import { Module } from '@nestjs/common';
import { AgentJobsModule } from '../agent-jobs/agent-jobs.module';
import { PrismaService } from '../../prisma/prisma.service';
import { SlackModule } from '../slack/slack.module';
import { CodexExecutionService } from './codex-execution.service';
import { ExecutionOrchestratorService } from './execution-orchestrator.service';
import { ExecutionWorkspaceService } from './execution-workspace.service';

@Module({
  imports: [AgentJobsModule, SlackModule],
  providers: [
    CodexExecutionService,
    ExecutionOrchestratorService,
    ExecutionWorkspaceService,
    PrismaService,
  ],
  exports: [ExecutionOrchestratorService],
})
export class ExecutionModule {}
