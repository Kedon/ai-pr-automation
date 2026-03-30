import { Injectable } from '@nestjs/common';
import { AgentJobsService } from '../agent-jobs/agent-jobs.service';
import { ExecutionResult } from '../execution/execution.types';
import { ExecutionOrchestratorService } from '../execution/execution-orchestrator.service';
import { ProjectConfigsService } from '../project-configs/project-configs.service';
import { SlackService } from '../slack/slack.service';

interface JiraWebhookPayload {
  issue?: {
    key?: string;
    self?: string;
    fields?: {
      summary?: string;
      description?: unknown;
      labels?: string[];
      issuetype?: {
        name?: string;
        subtask?: boolean;
      };
      parent?: {
        key?: string;
      };
      project?: {
        key?: string;
      };
    };
  };
  webhookEvent?: string;
}

export interface JiraWebhookResult {
  accepted: boolean;
  reason: string;
  jobId?: string;
  execution?: ExecutionResult;
}

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}

export interface JiraIssueTransition {
  id: string;
  name: string;
  to?: {
    id?: string;
    name?: string;
  };
}

@Injectable()
export class JiraService {
  constructor(
    private readonly projectConfigsService: ProjectConfigsService,
    private readonly agentJobsService: AgentJobsService,
    private readonly executionOrchestratorService: ExecutionOrchestratorService,
    private readonly slackService: SlackService,
  ) {}

  async handleWebhook(payload: JiraWebhookPayload): Promise<JiraWebhookResult> {
    const issueKey = payload.issue?.key?.trim();
    const projectKey = payload.issue?.fields?.project?.key?.trim().toUpperCase();
    const title = payload.issue?.fields?.summary?.trim();
    const parentIssueKey = payload.issue?.fields?.parent?.key?.trim();

    if (!issueKey || !projectKey || !title) {
      return {
        accepted: false,
        reason: 'Missing Jira issue key, project key, or summary.',
      };
    }

    let projectConfig;
    try {
      projectConfig = await this.projectConfigsService.findByJiraProjectKey(projectKey);
    } catch {
      return {
        accepted: false,
        reason: `Project "${projectKey}" is not mapped to a repository yet.`,
      };
    }

    if (!projectConfig.enabled) {
      return {
        accepted: false,
        reason: `Project "${projectKey}" is disabled for agent execution.`,
      };
    }

    const trigger = this.detectTrigger(payload);
    if (!trigger) {
      return {
        accepted: false,
        reason: 'Issue does not contain the ai-agent label or @agent mention.',
      };
    }

    if (this.isSubtask(payload)) {
      const reason = parentIssueKey
        ? `Issue "${issueKey}" is a subtask of "${parentIssueKey}". Only the parent task should open a pull request.`
        : `Issue "${issueKey}" is a subtask. Only parent tasks should open pull requests.`;

      await this.addSubtaskSkipComment(issueKey, {
        parentIssueKey,
        repositoryOwner: projectConfig.repositoryOwner,
        repositoryName: projectConfig.repositoryName,
      }).catch(() => null);

      return {
        accepted: false,
        reason,
      };
    }

    const existingJob = await this.agentJobsService.findActiveByIssueKey(issueKey);
    if (existingJob) {
      return {
        accepted: false,
        reason: `An active agent job already exists for "${issueKey}".`,
        jobId: existingJob.id,
      };
    }

    const branchName = this.buildBranchName(issueKey, title);
    const job = await this.agentJobsService.createQueuedJob({
      jiraIssueKey: issueKey,
      jiraIssueTitle: title,
      jiraIssueUrl: payload.issue?.self,
      promptTrigger: trigger,
      branchName,
      projectConfigId: projectConfig.id,
    });

    await this.moveIssueToAiAgent(issueKey).catch(() => null);
    await this.agentJobsService.markSentToCodex(job.id);
    await this.slackService.sendExecutionStarted({
      jiraIssueKey: issueKey,
      jiraIssueTitle: title,
      repositoryOwner: projectConfig.repositoryOwner,
      repositoryName: projectConfig.repositoryName,
      branchName,
      slackChannel: projectConfig.slackChannel,
    });

    let execution: ExecutionResult;

    try {
      execution = await this.executionOrchestratorService.execute(job.id);
    } catch (error) {
      execution = {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Unknown execution error.',
      };
    }

    const completedJob = await this.agentJobsService.findById(job.id);
    if (completedJob) {
      await this.addExecutionComment(issueKey, {
        status: completedJob.status,
        summary: completedJob.summary,
        branchName: completedJob.branchName,
        pullRequestUrl: completedJob.pullRequestUrl,
        repositoryOwner: completedJob.projectConfig.repositoryOwner,
        repositoryName: completedJob.projectConfig.repositoryName,
      }).catch(() => null);
    }

    return {
      accepted: true,
      reason: 'Issue accepted and sent to Codex execution flow.',
      jobId: job.id,
      execution,
    };
  }

  async testConnection() {
    const profile = await this.jiraRequest<{
      accountId: string;
      displayName: string;
      emailAddress?: string;
      self: string;
    }>('/rest/api/3/myself');

    return {
      connected: true,
      baseUrl: this.getBaseUrl(),
      accountId: profile.accountId,
      displayName: profile.displayName,
      emailAddress: profile.emailAddress ?? null,
      self: profile.self,
    };
  }

  async listProjects() {
    const response = await this.jiraRequest<{
      values?: JiraProjectSummary[];
    }>('/rest/api/3/project/search');

    return {
      baseUrl: this.getBaseUrl(),
      count: response.values?.length ?? 0,
      projects: response.values ?? [],
    };
  }

  async searchEligibleIssues(projectKey?: string) {
    const projectFilter = projectKey?.trim()
      ? `project = "${projectKey.trim().toUpperCase()}" AND `
      : '';
    const jql = `${projectFilter}(labels = "ai-agent" OR text ~ "@agent") AND issuetype NOT IN subTaskIssueTypes() ORDER BY updated DESC`;

    const response = await this.jiraRequest<{
      issues?: Array<{
        id: string;
        key: string;
        fields?: {
          summary?: string;
          status?: {
            name?: string;
          };
          issuetype?: {
            name?: string;
            subtask?: boolean;
          };
          parent?: {
            key?: string;
          };
          project?: {
            key?: string;
            name?: string;
          };
        };
      }>;
    }>('/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql,
        maxResults: 25,
        fields: ['summary', 'status', 'project', 'issuetype', 'parent'],
      },
    });

    return {
      jql,
      count: response.issues?.length ?? 0,
      issues:
        response.issues?.map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.fields?.summary ?? null,
          status: issue.fields?.status?.name ?? null,
          issueType: issue.fields?.issuetype?.name ?? null,
          isSubtask: issue.fields?.issuetype?.subtask ?? false,
          parentIssueKey: issue.fields?.parent?.key ?? null,
          projectKey: issue.fields?.project?.key ?? null,
          projectName: issue.fields?.project?.name ?? null,
        })) ?? [],
    };
  }

  async listIssueTransitions(issueKey: string) {
    const response = await this.jiraRequest<{
      transitions?: JiraIssueTransition[];
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);

    return {
      issueKey,
      transitions: response.transitions ?? [],
    };
  }

  async moveIssueToAiAgent(issueKey: string) {
    const targetName = process.env.JIRA_AI_AGENT_STATUS_NAME?.trim() || 'AI Agent';
    const transitions = await this.listIssueTransitions(issueKey);

    const targetTransition = transitions.transitions.find((transition) => {
      const transitionName = transition.name?.trim().toLowerCase();
      const targetStatus = transition.to?.name?.trim().toLowerCase();
      const normalizedTarget = targetName.toLowerCase();

      return transitionName === normalizedTarget || targetStatus === normalizedTarget;
    });

    if (!targetTransition) {
      return {
        moved: false,
        issueKey,
        targetStatus: targetName,
        reason: `Transition to "${targetName}" was not found for this issue.`,
        availableTransitions: transitions.transitions.map((transition) => ({
          id: transition.id,
          name: transition.name,
          to: transition.to?.name ?? null,
        })),
      };
    }

    await this.jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: {
        transition: {
          id: targetTransition.id,
        },
      },
    });

    return {
      moved: true,
      issueKey,
      targetStatus: targetName,
      transitionId: targetTransition.id,
      transitionName: targetTransition.name,
    };
  }

  async enqueueIssueByKey(issueKey: string) {
    const issue = await this.jiraRequest<{
      key: string;
      self: string;
      fields?: {
        summary?: string;
        description?: unknown;
        labels?: string[];
        issuetype?: {
          name?: string;
          subtask?: boolean;
        };
        parent?: {
          key?: string;
        };
        project?: {
          key?: string;
        };
      };
    }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,labels,project,issuetype,parent`,
    );

    return this.handleWebhook({
      webhookEvent: 'jira:issue_manual_enqueue',
      issue,
    });
  }

  async addExecutionComment(
    issueKey: string,
    input: {
      status: string;
      summary?: string | null;
      branchName?: string | null;
      pullRequestUrl?: string | null;
      repositoryOwner: string;
      repositoryName: string;
    },
  ) {
    const repositoryUrl = `https://github.com/${input.repositoryOwner}/${input.repositoryName}`;
    const statusLabel =
      input.status === 'completed'
        ? 'Concluida'
        : input.status === 'blocked'
          ? 'Bloqueada'
          : 'Finalizada com falha';
    const nextStep =
      input.status === 'completed'
        ? 'Proximo passo: revisar a Pull Request e aprovar manualmente se estiver correta.'
        : input.status === 'blocked'
          ? 'Proximo passo: complementar o contexto da tarefa para uma nova tentativa.'
          : 'Proximo passo: revisar o resumo tecnico e ajustar a tarefa antes de tentar novamente.';

    const lines = [
      `Resumo da automacao AI: ${statusLabel}.`,
      input.summary ? `Resumo tecnico: ${input.summary}` : null,
      input.branchName ? `Branch: ${input.branchName}` : null,
      `Repositorio: ${repositoryUrl}`,
      input.pullRequestUrl ? `Pull Request: ${input.pullRequestUrl}` : null,
      nextStep,
    ].filter((line): line is string => Boolean(line));

    await this.jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: {
        body: {
          type: 'doc',
          version: 1,
          content: lines.map((line) => ({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: line,
              },
            ],
          })),
        },
      },
    });

    return {
      issueKey,
      commented: true,
      lines,
    };
  }

  async addSubtaskSkipComment(
    issueKey: string,
    input: {
      parentIssueKey?: string;
      repositoryOwner: string;
      repositoryName: string;
    },
  ) {
    const repositoryUrl = `https://github.com/${input.repositoryOwner}/${input.repositoryName}`;
    const lines = [
      'Resumo da automacao AI: subtarefa ignorada para evitar uma Pull Request separada.',
      input.parentIssueKey
        ? `A automacao deve acontecer na tarefa principal ${input.parentIssueKey}.`
        : 'A automacao deve acontecer apenas na tarefa principal.',
      `Repositorio alvo: ${repositoryUrl}`,
    ];

    await this.jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: {
        body: {
          type: 'doc',
          version: 1,
          content: lines.map((line) => ({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: line,
              },
            ],
          })),
        },
      },
    });

    return {
      issueKey,
      commented: true,
      lines,
    };
  }

  private detectTrigger(payload: JiraWebhookPayload): string | null {
    const labels = payload.issue?.fields?.labels ?? [];
    if (labels.some((label) => label.trim().toLowerCase() === 'ai-agent')) {
      return 'label:ai-agent';
    }

    const summaryText = payload.issue?.fields?.summary ?? '';
    if (summaryText.toLowerCase().includes('@agent')) {
      return 'mention:@agent';
    }

    const descriptionText = this.extractDescriptionText(payload.issue?.fields?.description);
    if (descriptionText.toLowerCase().includes('@agent')) {
      return 'mention:@agent';
    }

    return null;
  }

  private isSubtask(payload: JiraWebhookPayload): boolean {
    return payload.issue?.fields?.issuetype?.subtask === true;
  }

  private extractDescriptionText(description: unknown): string {
    if (typeof description === 'string') {
      return description;
    }

    if (!description || typeof description !== 'object') {
      return '';
    }

    const root = description as {
      content?: Array<{
        content?: Array<{ text?: string }>;
      }>;
    };

    return (root.content ?? [])
      .flatMap((node) => node.content ?? [])
      .map((child) => child.text ?? '')
      .join(' ');
  }

  private buildBranchName(issueKey: string, summary: string): string {
    const slug = summary
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    return `ai/${issueKey.toLowerCase()}-${slug || 'task'}`;
  }

  private getBaseUrl(): string {
    const baseUrl = process.env.JIRA_BASE_URL?.trim();

    if (!baseUrl) {
      throw new Error('JIRA_BASE_URL is not configured.');
    }

    return baseUrl.replace(/\/+$/, '');
  }

  private getAuthHeader(): string {
    const email = process.env.JIRA_EMAIL?.trim();
    const token = process.env.JIRA_API_TOKEN?.trim();

    if (!email || !token) {
      throw new Error('JIRA_EMAIL or JIRA_API_TOKEN is not configured.');
    }

    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  private async jiraRequest<T = unknown>(
    path: string,
    options?: {
      method?: 'GET' | 'POST';
      body?: unknown;
    },
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.getBaseUrl()}${path}`, {
        method: options?.method ?? 'GET',
        headers: {
          authorization: this.getAuthHeader(),
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Jira connection error.';

      if (message.includes('ERR_TLS_CERT_ALTNAME_INVALID')) {
        throw new Error(
          `Jira TLS hostname validation failed. Please confirm the exact Jira Cloud base URL in JIRA_BASE_URL. Current value: ${this.getBaseUrl()}`,
        );
      }

      throw error;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jira API request failed with status ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
