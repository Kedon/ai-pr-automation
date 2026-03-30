import { Injectable, Logger } from '@nestjs/common';

export interface SlackApprovalMessageInput {
  jiraIssueKey: string;
  jiraIssueTitle: string;
  repositoryOwner: string;
  repositoryName: string;
  branchName: string;
  slackChannel: string;
  approveUrl: string;
  rejectUrl: string;
}

export interface SlackCompletionMessageInput {
  jiraIssueKey: string;
  pullRequestUrl: string;
  summary: string;
  slackChannel: string;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  async sendApprovalRequest(input: SlackApprovalMessageInput): Promise<void> {
    const text = [
      `AI agent request for *${input.jiraIssueKey}*`,
      input.jiraIssueTitle,
      `Repository: ${input.repositoryOwner}/${input.repositoryName}`,
      `Branch: ${input.branchName}`,
      `Channel: ${input.slackChannel}`,
      `Approve: ${input.approveUrl}`,
      `Reject: ${input.rejectUrl}`,
    ].join('\n');

    await this.postMessage(text);
  }

  async sendExecutionStarted(input: {
    jiraIssueKey: string;
    jiraIssueTitle: string;
    repositoryOwner: string;
    repositoryName: string;
    branchName: string;
    slackChannel: string;
  }): Promise<void> {
    const text = [
      `AI agent started *${input.jiraIssueKey}*`,
      input.jiraIssueTitle,
      `Repository: ${input.repositoryOwner}/${input.repositoryName}`,
      `Branch: ${input.branchName}`,
      `Channel: ${input.slackChannel}`,
    ].join('\n');

    await this.postMessage(text);
  }

  async sendCompletionSummary(input: SlackCompletionMessageInput): Promise<void> {
    const text = [
      `AI agent completed *${input.jiraIssueKey}*`,
      `PR: ${input.pullRequestUrl}`,
      `Summary: ${input.summary}`,
      `Channel: ${input.slackChannel}`,
    ].join('\n');

    await this.postMessage(text);
  }

  async sendFailureSummary(input: {
    jiraIssueKey: string;
    summary: string;
    slackChannel: string;
  }): Promise<void> {
    const text = [
      `AI agent failed *${input.jiraIssueKey}*`,
      `Summary: ${input.summary}`,
      `Channel: ${input.slackChannel}`,
    ].join('\n');

    await this.postMessage(text);
  }

  private async postMessage(text: string): Promise<void> {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();

    if (!webhookUrl) {
      this.logger.log(`Slack webhook not configured. Message preview:\n${text}`);
      return;
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Slack webhook failed with status ${response.status}: ${body}`);
    }
  }
}
