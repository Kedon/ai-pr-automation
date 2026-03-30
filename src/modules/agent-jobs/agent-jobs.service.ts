import { Injectable } from '@nestjs/common';
import { AgentJob, JobStatus, ProjectConfig } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateAgentJobInput {
  jiraIssueKey: string;
  jiraIssueTitle: string;
  jiraIssueUrl?: string;
  promptTrigger: string;
  branchName: string;
  projectConfigId: string;
}

@Injectable()
export class AgentJobsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.agentJob.findFirst({
      where: {
        jiraIssueKey,
        status: {
          in: [JobStatus.queued, JobStatus.sent_to_codex, JobStatus.running, JobStatus.pr_opened],
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
}
