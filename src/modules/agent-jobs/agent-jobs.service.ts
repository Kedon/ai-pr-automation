import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentJob, JobStatus, ProjectConfig } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SlackService } from '../slack/slack.service';

export interface CreateAgentJobInput {
  jiraIssueKey: string;
  jiraIssueTitle: string;
  jiraIssueUrl?: string;
  promptTrigger: string;
  branchName: string;
  projectConfigId: string;
}

@Injectable()
export class AgentJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentJobsService.name);
  private staleSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackService: SlackService,
  ) {}

  private readonly activeStatuses = [
    JobStatus.queued,
    JobStatus.sent_to_codex,
    JobStatus.running,
    JobStatus.pr_opened,
  ];

  onModuleInit(): void {
    const intervalMs = Number(process.env.AGENT_JOB_SWEEP_INTERVAL_MS ?? 60_000);
    this.staleSweepTimer = setInterval(() => {
      void this.failStaleActiveJobs().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown stale job sweep error.';
        this.logger.error(`Failed to sweep stale jobs: ${message}`);
      });
    }, intervalMs);

    if (typeof this.staleSweepTimer.unref === 'function') {
      this.staleSweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
  }

  async createQueuedJob(input: CreateAgentJobInput): Promise<AgentJob> {
    return this.prisma.agentJob.create({
      data: {
        jiraIssueKey: input.jiraIssueKey,
        jiraIssueTitle: input.jiraIssueTitle,
        jiraIssueUrl: input.jiraIssueUrl,
        promptTrigger: input.promptTrigger,
        branchName: input.branchName,
        projectConfigId: input.projectConfigId,
        status: JobStatus.queued,
      },
    });
  }

  async findAll(): Promise<(AgentJob & { projectConfig: ProjectConfig })[]> {
    await this.failStaleActiveJobs();

    return this.prisma.agentJob.findMany({
      include: {
        projectConfig: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findById(jobId: string): Promise<(AgentJob & { projectConfig: ProjectConfig }) | null> {
    await this.failStaleActiveJobs();

    return this.prisma.agentJob.findUnique({
      where: {
        id: jobId,
      },
      include: {
        projectConfig: true,
      },
    });
  }

  async findActiveByIssueKey(jiraIssueKey: string): Promise<AgentJob | null> {
    await this.failStaleActiveJobs(jiraIssueKey);

    return this.prisma.agentJob.findFirst({
      where: {
        jiraIssueKey,
        status: {
          in: this.activeStatuses,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async markSentToCodex(jobId: string): Promise<void> {
    await this.prisma.agentJob.update({
      where: { id: jobId },
      data: { status: JobStatus.sent_to_codex },
    });
  }

  async markFailed(jobId: string, summary: string): Promise<AgentJob> {
    return this.prisma.agentJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.failed,
        summary,
      },
    });
  }

  async failStaleActiveJobs(jiraIssueKey?: string): Promise<number> {
    const timeoutMinutes = this.getTimeoutMinutes();
    const staleBefore = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const timedOutSummary = `Execution timed out after ${timeoutMinutes} minutes without completion.`;

    const staleJobs = await this.prisma.agentJob.findMany({
      where: {
        ...(jiraIssueKey ? { jiraIssueKey } : {}),
        status: {
          in: this.activeStatuses,
        },
        updatedAt: {
          lt: staleBefore,
        },
      },
      include: {
        projectConfig: true,
      },
    });

    if (!staleJobs.length) {
      return 0;
    }

    await this.prisma.agentJob.updateMany({
      where: {
        id: {
          in: staleJobs.map((job) => job.id),
        },
      },
      data: {
        status: JobStatus.failed,
        summary: timedOutSummary,
      },
    });

    await Promise.all(
      staleJobs.map((job) =>
        this.slackService.sendFailureSummary({
          jiraIssueKey: job.jiraIssueKey,
          summary: timedOutSummary,
          slackChannel: job.projectConfig.slackChannel,
        }),
      ),
    );

    this.logger.warn(
      `Marked ${staleJobs.length} stale job(s) as failed after timeout of ${timeoutMinutes} minutes.`,
    );

    return staleJobs.length;
  }

  private getTimeoutMinutes(): number {
    return Number(process.env.AGENT_JOB_TIMEOUT_MINUTES ?? 20);
  }
}
