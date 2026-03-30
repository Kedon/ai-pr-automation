import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';
import { SlackService } from '../slack/slack.service';
import { ExecutionProvider } from '../execution/execution.types';

const execFileAsync = promisify(execFile);

@Injectable()
export class AgentJobExecutorService implements ExecutionProvider {
  private readonly logger = new Logger(AgentJobExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackService: SlackService,
  ) {}

  async execute(jobId: string) {
    const job = await this.prisma.agentJob.findUnique({
      where: {
        id: jobId,
      },
      include: {
        projectConfig: true,
      },
    });

    if (!job) {
      throw new NotFoundException(`Agent job "${jobId}" was not found.`);
    }

    if (job.status !== JobStatus.queued && job.status !== JobStatus.sent_to_codex) {
      return {
        jobId,
        status: job.status,
        skipped: true,
        reason: 'Job is not ready for execution.',
      };
    }

    const workdirRoot = process.env.GIT_WORKDIR_ROOT?.trim() || join(tmpdir(), 'ai-pr-automation');
    const repoDir = join(
      workdirRoot,
      `${job.jiraIssueKey.toLowerCase()}-${job.id}`.replace(/[^a-z0-9-]/g, '-'),
    );

    await this.prisma.agentJob.update({
      where: { id: job.id },
      data: { status: JobStatus.running },
    });

    try {
      await rm(repoDir, { recursive: true, force: true });
      await mkdir(repoDir, { recursive: true });

      const token = process.env.GITHUB_TOKEN?.trim();
      if (!token) {
        throw new Error('GITHUB_TOKEN is not configured.');
      }

      const baseBranch = job.projectConfig.defaultBaseBranch;
      const branchName = job.branchName;

      if (!branchName) {
        throw new Error('Branch name is missing for this job.');
      }

      this.assertProtectedBranchPolicy(branchName, baseBranch);

      const remoteUrl = this.buildAuthenticatedRepoUrl(
        job.projectConfig.repositoryOwner,
        job.projectConfig.repositoryName,
        token,
      );

      await this.runGit(['clone', remoteUrl, repoDir], workdirRoot);
      await this.runGit(['checkout', baseBranch], repoDir);
      await this.runGit(['checkout', '-B', branchName, `origin/${baseBranch}`], repoDir);

      const artifactPath = join(
        repoDir,
        '.ai-pr-automation',
        'jobs',
        `${job.jiraIssueKey.toLowerCase()}.md`,
      );

      await mkdir(dirname(artifactPath), { recursive: true });

      const summary = [
        `# ${job.jiraIssueKey}`,
        '',
        `Title: ${job.jiraIssueTitle}`,
        `Trigger: ${job.promptTrigger}`,
        `Branch: ${branchName}`,
        '',
        'This bootstrap PR was created by the AI PR Automation orchestrator.',
        'It proves the end-to-end GitHub flow while the coding agent layer is still being integrated.',
      ].join('\n');

      await writeFile(artifactPath, summary, 'utf8');

      await this.runGit(['config', 'user.name', process.env.GIT_AUTHOR_NAME?.trim() || 'AI PR Automation'], repoDir);
      await this.runGit(
        ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL?.trim() || 'ai-pr-automation@example.com'],
        repoDir,
      );
      await this.runGit(['add', '.ai-pr-automation'], repoDir);
      await this.runGit(['commit', '-m', `chore(ai): bootstrap ${job.jiraIssueKey}`], repoDir);
      await this.runGit(['push', '--set-upstream', 'origin', branchName], repoDir);

      await this.prisma.agentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.pr_opened,
        },
      });

      const pullRequestUrl = await this.createPullRequest({
        token,
        owner: job.projectConfig.repositoryOwner,
        repo: job.projectConfig.repositoryName,
        title: `[AI] ${job.jiraIssueKey}: ${job.jiraIssueTitle}`,
        head: branchName,
        base: baseBranch,
        body: [
          `Automated branch for ${job.jiraIssueKey}.`,
          '',
          `- Trigger: ${job.promptTrigger}`,
          `- Branch: ${branchName}`,
          `- Review: human review required before merge`,
          '',
          'This PR is a bootstrap execution artifact while the autonomous coding layer is being integrated.',
        ].join('\n'),
      });

      await this.prisma.agentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.completed,
          pullRequestUrl,
          summary:
            'Bootstrap PR created successfully. Next step is replacing the artifact commit with real autonomous code changes.',
        },
      });

      await this.slackService.sendCompletionSummary({
        jiraIssueKey: job.jiraIssueKey,
        pullRequestUrl,
        summary:
          'Bootstrap PR criada com sucesso. O fluxo GitHub esta validado e pronto para receber a camada de execucao autonoma.',
        slackChannel: job.projectConfig.slackChannel,
      });

      return {
        jobId: job.id,
        status: 'completed',
        pullRequestUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown execution error.';
      this.logger.error(`Job execution failed for ${job.id}: ${message}`);

      await this.prisma.agentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.failed,
          summary: message,
        },
      });

      await this.slackService.sendFailureSummary({
        jiraIssueKey: job.jiraIssueKey,
        summary: message,
        slackChannel: job.projectConfig.slackChannel,
      });

      throw error;
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  }

  private assertProtectedBranchPolicy(branchName: string, baseBranch: string) {
    const protectedBranches = new Set(['main', 'master', 'trunk', baseBranch]);

    if (protectedBranches.has(branchName)) {
      throw new Error(`Refusing to operate directly on protected branch "${branchName}".`);
    }

    if (!branchName.startsWith('ai/')) {
      throw new Error(`Branch "${branchName}" does not comply with the required ai/ prefix.`);
    }
  }

  private buildAuthenticatedRepoUrl(owner: string, repo: string, token: string): string {
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }

  private async createPullRequest(input: {
    token: string;
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'ai-pr-automation',
        },
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub PR creation failed with status ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { html_url?: string };
    if (!data.html_url) {
      throw new Error('GitHub PR response did not include html_url.');
    }

    return data.html_url;
  }

  private async runGit(args: string[], cwd: string): Promise<void> {
    await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
    });
  }
}
