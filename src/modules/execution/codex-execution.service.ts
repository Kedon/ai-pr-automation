import { Injectable, Logger } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { SlackService } from '../slack/slack.service';
import { ExecutionWorkspaceService, WorkspaceSnapshot } from './execution-workspace.service';
import { ExecutionProvider, ExecutionResult } from './execution.types';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

interface FinishAction {
  summary?: string;
  commit_message?: string;
  tests_ran?: string[];
}

interface JiraIssueExecutionContext {
  description: string;
  subtasks: string[];
}

interface IssueStrategyContext {
  mode: 'architecture_replication' | 'targeted_change';
  reasoning: string[];
  focusHints: string[];
  executionPlan: string[];
  referenceFeature: string | null;
  targetFeature: string | null;
}

interface ValidationTracker {
  available: boolean;
  attempts: number;
  passed: boolean;
}

interface ValidationState {
  packageManager: 'npm' | 'pnpm' | 'yarn';
  build: ValidationTracker;
  test: ValidationTracker;
  lint: ValidationTracker;
}

interface ExecutionTrace {
  steps: string[];
  filesRead: string[];
  filesWritten: string[];
  searchQueries: string[];
  commands: string[];
}

interface FeatureBlueprint {
  featureName: string;
  files: string[];
  routeFiles: string[];
  serviceFiles: string[];
  interfaceFiles: string[];
  componentFiles: string[];
}

interface PlanState {
  submitted: boolean;
  summary: string | null;
  filesToCreate: string[];
  filesToUpdate: string[];
}

@Injectable()
export class CodexExecutionService implements ExecutionProvider {
  private readonly logger = new Logger(CodexExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackService: SlackService,
    private readonly executionWorkspaceService: ExecutionWorkspaceService,
  ) {}

  async execute(jobId: string): Promise<ExecutionResult> {
    const job = await this.prisma.agentJob.findUnique({
      where: { id: jobId },
      include: { projectConfig: true },
    });

    if (!job) {
      return {
        jobId,
        status: 'failed',
        reason: `Agent job "${jobId}" was not found.`,
      };
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      const reason = 'OPENAI_API_KEY is not configured for Codex execution.';
      await this.failJob(job.id, job.jiraIssueKey, job.projectConfig.slackChannel, reason);
      return { jobId, status: 'failed', reason };
    }

    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_CODEX_MODEL?.trim() || 'gpt-5.2-codex';
    const reasoningEffort =
      (process.env.OPENAI_CODEX_REASONING_EFFORT?.trim() as ReasoningEffort | undefined) ||
      'medium';

    await this.prisma.agentJob.update({
      where: { id: job.id },
      data: { status: JobStatus.running },
    });

    let snapshot: WorkspaceSnapshot | null = null;
    let validationState: ValidationState | null = null;
    const testsRun: string[] = [];
    const trace = this.createTrace();

    try {
      const jiraIssueContext = await this.loadJiraIssueContext(job.jiraIssueUrl);
      const issueStrategy = this.buildIssueStrategy({
        title: job.jiraIssueTitle,
        description: jiraIssueContext.description,
        subtasks: jiraIssueContext.subtasks,
      });

      snapshot = await this.executionWorkspaceService.prepareSnapshot({
        owner: job.projectConfig.repositoryOwner,
        repo: job.projectConfig.repositoryName,
        baseBranch: job.projectConfig.defaultBaseBranch,
        branchName: job.branchName ?? `ai/${job.jiraIssueKey.toLowerCase()}`,
      });
      validationState = this.createValidationState(snapshot.packageJson, snapshot.fileList);
      const referenceBlueprint = this.buildFeatureBlueprint(
        snapshot.fileList,
        issueStrategy.referenceFeature,
      );
      const planState = this.createPlanState();

      const initialContext = this.buildInitialContext({
        jiraIssueKey: job.jiraIssueKey,
        jiraIssueTitle: job.jiraIssueTitle,
        promptTrigger: job.promptTrigger,
        repository: `${job.projectConfig.repositoryOwner}/${job.projectConfig.repositoryName}`,
        snapshot,
        jiraIssueContext,
        issueStrategy,
        referenceBlueprint,
      });

      const maxSteps = Number(process.env.CODEX_MAX_STEPS ?? 16);
      let response = await client.responses.create({
        model,
        reasoning: { effort: reasoningEffort },
        tools: this.buildTools(),
        tool_choice: 'auto',
        instructions: this.buildInstructions(),
        input: initialContext,
      });

      for (let step = 1; step <= maxSteps; step += 1) {
        this.appendTrace(trace.steps, `step ${step}: received model response`);
        const functionCalls = this.extractFunctionCalls(response);

        if (functionCalls.length === 0) {
          const reminder = [
            'You must respond using function calls only.',
            'If the work is done, call finish_task.',
            'If the task cannot be completed safely, call block_task.',
            'Do not reply with plain text summaries.',
            'For architecture replication tasks, first identify the source feature files and then create the target equivalents.',
          ].join(' ');

          response = await client.responses.create({
            model,
            reasoning: { effort: reasoningEffort },
            tools: this.buildTools(),
            tool_choice: 'auto',
            previous_response_id: response.id,
            input: reminder,
          });
          continue;
        }

        const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> =
          [];

        for (const call of functionCalls) {
          this.appendTrace(trace.steps, `step ${step}: call ${call.name}`);
          const result = await this.handleFunctionCall({
            call,
            snapshot,
            testsRun,
            trace,
            issueStrategy,
            referenceBlueprint,
            planState,
            job: {
              id: job.id,
              jiraIssueKey: job.jiraIssueKey,
              jiraIssueTitle: job.jiraIssueTitle,
              slackChannel: job.projectConfig.slackChannel,
              repositoryOwner: job.projectConfig.repositoryOwner,
              repositoryName: job.projectConfig.repositoryName,
            },
          });

          if (result.kind === 'continue') {
            toolOutputs.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(result.payload),
            });
            continue;
          }

          if (result.kind === 'blocked') {
            await this.prisma.agentJob.update({
              where: { id: job.id },
              data: {
                status: JobStatus.blocked,
                summary: result.reason,
              },
            });

            await this.slackService.sendFailureSummary({
              jiraIssueKey: job.jiraIssueKey,
              summary: this.appendTraceSummary(result.reason, trace),
              slackChannel: job.projectConfig.slackChannel,
            });

            return {
              jobId: job.id,
              status: 'failed',
              reason: this.appendTraceSummary(result.reason, trace),
            };
          }

          if (!validationState) {
            throw new Error(`Validation state was not initialized for ${job.jiraIssueKey}.`);
          }

          const finishResolution = await this.handleFinishAction({
            job: {
              id: job.id,
              jiraIssueKey: job.jiraIssueKey,
              jiraIssueTitle: job.jiraIssueTitle,
              slackChannel: job.projectConfig.slackChannel,
              repositoryOwner: job.projectConfig.repositoryOwner,
              repositoryName: job.projectConfig.repositoryName,
            },
            snapshot,
            finish: result.finish,
            testsRun,
            validationState,
          });

          if (finishResolution.kind === 'continue') {
            toolOutputs.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(finishResolution.payload),
            });
            this.appendTrace(
              trace.steps,
              `step ${step}: validation feedback ${this.summarizeForTrace(finishResolution.payload)}`,
            );
            continue;
          }

          return {
            jobId: job.id,
            status: 'completed',
            pullRequestUrl: finishResolution.pullRequestUrl,
          };
        }

        response = await client.responses.create({
          model,
          reasoning: { effort: reasoningEffort },
          tools: this.buildTools(),
          tool_choice: 'auto',
          previous_response_id: response.id,
          input: toolOutputs,
        });
      }

      const reason = this.appendTraceSummary(
        `Codex exceeded the maximum number of execution steps without finishing ${job.jiraIssueKey}.`,
        trace,
      );
      await this.failJob(job.id, job.jiraIssueKey, job.projectConfig.slackChannel, reason);
      return { jobId: job.id, status: 'failed', reason };
    } catch (error) {
      const reason = this.appendTraceSummary(
        error instanceof Error ? error.message : 'Unknown Codex execution error.',
        trace,
      );
      this.logger.error(`Codex execution failed for ${job.id}: ${reason}`);
      await this.failJob(job.id, job.jiraIssueKey, job.projectConfig.slackChannel, reason);
      return {
        jobId: job.id,
        status: 'failed',
        reason,
      };
    } finally {
      await this.executionWorkspaceService.cleanup(snapshot);
    }
  }

  private buildInstructions(): string {
    return [
      'You are Codex acting as an autonomous coding agent.',
      'Work only on the provided ai/ branch and never target the main branch directly.',
      'Use the available function tools to inspect the repository, edit files, and run validations.',
      'Prefer small, safe edits and verify the change with tests or build commands whenever possible.',
      'Minimize open-ended exploration. Build a concrete plan quickly, then execute against the most likely files.',
      'When a task says to create a new page, module, or feature based on an existing one, treat it as an architecture replication task.',
      'For architecture replication tasks, first identify the source feature files, map them to target files, and then adapt names, types, routes, labels, and API references deliberately.',
      'For architecture replication tasks, you must call submit_plan before any write_file call.',
      'Never read environment or secret files such as .env. They are irrelevant to implementation.',
      'When you believe the implementation is ready, call finish_task and the orchestrator will enforce final validations.',
      'If build validation fails, you will receive the error output back and you must fix the issue before calling finish_task again.',
      'Treat the Jira description and subtasks as binding implementation context.',
      'If the issue references a specific screen, modal, button label, or component area, you must target that exact area.',
      'If multiple files or UI elements could match and the issue does not disambiguate them sufficiently, call block_task instead of guessing.',
      'Do not claim success in plain text. Signal completion only by calling finish_task.',
      'If the task is underspecified or unsafe, call block_task with a concise reason.',
    ].join('\n');
  }

  private buildInitialContext(input: {
    jiraIssueKey: string;
    jiraIssueTitle: string;
    promptTrigger: string;
    repository: string;
    snapshot: WorkspaceSnapshot;
    jiraIssueContext: JiraIssueExecutionContext;
    issueStrategy: IssueStrategyContext;
    referenceBlueprint: FeatureBlueprint | null;
  }): string {
    return [
      `Issue: ${input.jiraIssueKey}`,
      `Title: ${input.jiraIssueTitle}`,
      input.jiraIssueContext.description
        ? `Description:\n${input.jiraIssueContext.description}`
        : 'Description: unavailable',
      input.jiraIssueContext.subtasks.length
        ? `Subtasks:\n- ${input.jiraIssueContext.subtasks.join('\n- ')}`
        : 'Subtasks: none',
      `Trigger: ${input.promptTrigger}`,
      `Repository: ${input.repository}`,
      `Base branch: ${input.snapshot.baseBranch}`,
      `Working branch: ${input.snapshot.branchName}`,
      `Execution mode: ${input.issueStrategy.mode}`,
      input.issueStrategy.reasoning.length
        ? `Execution reasoning:\n- ${input.issueStrategy.reasoning.join('\n- ')}`
        : 'Execution reasoning: none',
      input.issueStrategy.focusHints.length
        ? `Focus hints:\n- ${input.issueStrategy.focusHints.join('\n- ')}`
        : 'Focus hints: none',
      input.issueStrategy.executionPlan.length
        ? `Suggested plan:\n- ${input.issueStrategy.executionPlan.join('\n- ')}`
        : 'Suggested plan: none',
      input.referenceBlueprint
        ? [
            `Reference feature blueprint: ${input.referenceBlueprint.featureName}`,
            `Blueprint files:\n- ${input.referenceBlueprint.files.join('\n- ')}`,
            input.referenceBlueprint.routeFiles.length
              ? `Route files:\n- ${input.referenceBlueprint.routeFiles.join('\n- ')}`
              : 'Route files: none',
            input.referenceBlueprint.serviceFiles.length
              ? `Service files:\n- ${input.referenceBlueprint.serviceFiles.join('\n- ')}`
              : 'Service files: none',
            input.referenceBlueprint.interfaceFiles.length
              ? `Interface files:\n- ${input.referenceBlueprint.interfaceFiles.join('\n- ')}`
              : 'Interface files: none',
            input.referenceBlueprint.componentFiles.length
              ? `Component files:\n- ${input.referenceBlueprint.componentFiles.join('\n- ')}`
              : 'Component files: none',
          ].join('\n')
        : 'Reference feature blueprint: unavailable',
      `Tracked files count: ${input.snapshot.fileList.length}`,
      `Tracked file sample: ${input.snapshot.fileList.slice(0, 60).join(' | ')}`,
      input.snapshot.packageJson
        ? `package.json excerpt:\n${input.snapshot.packageJson}`
        : 'package.json excerpt: unavailable',
      input.snapshot.readme ? `README excerpt:\n${input.snapshot.readme}` : 'README excerpt: unavailable',
      input.issueStrategy.mode === 'architecture_replication'
        ? 'Start by locating the source feature/page mentioned in the issue, enumerate its main files, and then create the target equivalents.'
        : 'Start by locating the exact implementation area for the requested change.',
    ].join('\n\n');
  }

  private buildIssueStrategy(input: {
    title: string;
    description: string;
    subtasks: string[];
  }): IssueStrategyContext {
    const corpus = [input.title, input.description, ...input.subtasks].join(' ').toLowerCase();
    const replicationPattern =
      /(mesma arquitetura|mesma estrutura|basead[oa] na|espelh|igual a|similar a|replicar|replica)/i;
    const mode: IssueStrategyContext['mode'] = replicationPattern.test(corpus)
      ? 'architecture_replication'
      : 'targeted_change';

    const referencedFeatures = this.extractFeatureMentions(corpus);
    const targetFeature = this.extractTargetFeature(corpus);

    if (mode === 'architecture_replication') {
      return {
        mode,
        reasoning: [
          'The issue describes a new feature/page based on an existing architecture.',
          'Success depends on reusing the reference feature structure instead of exploring the repository broadly.',
        ],
        focusHints: [
          ...(referencedFeatures.length
            ? [`Reference features mentioned: ${referencedFeatures.join(', ')}`]
            : []),
          ...(targetFeature ? [`Target feature suggested by the issue: ${targetFeature}`] : []),
          'Look for routes, page containers, form components, interfaces, service hooks, and localization/text labels that match the reference feature.',
        ],
        executionPlan: [
          'Find the source feature/page mentioned in the task and inspect its route, page, components, interfaces, and service usage.',
          'Submit a concise implementation plan with the target files to create or update before editing.',
          'Create or adapt the equivalent target feature files with consistent naming and imports.',
          'Update route registration, navigation links, and exports only where required for the new feature to be reachable.',
          'Run build first and fix build failures before attempting final completion.',
        ],
        referenceFeature: referencedFeatures[0] ?? null,
        targetFeature,
      };
    }

    return {
      mode,
      reasoning: [
        'The issue appears to target a specific change rather than replicating an entire feature.',
      ],
      focusHints: [
        'Use the exact labels, component names, and screen references from the issue to avoid changing the wrong area.',
      ],
      executionPlan: [
        'Locate the exact implementation area mentioned in the issue.',
        'Make the smallest viable change that satisfies the request.',
        'Run build first and fix any resulting errors before finishing.',
      ],
      referenceFeature: referencedFeatures[0] ?? null,
      targetFeature,
    };
  }

  private async loadJiraIssueContext(jiraIssueUrl?: string | null): Promise<JiraIssueExecutionContext> {
    if (!jiraIssueUrl) {
      return { description: '', subtasks: [] };
    }

    const email = process.env.JIRA_EMAIL?.trim();
    const token = process.env.JIRA_API_TOKEN?.trim();
    if (!email || !token) {
      return { description: '', subtasks: [] };
    }

    const response = await fetch(`${jiraIssueUrl}?fields=description,subtasks`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      this.logger.warn(`Failed to load Jira issue context from ${jiraIssueUrl}: ${response.status}`);
      return { description: '', subtasks: [] };
    }

    const payload = (await response.json()) as {
      fields?: {
        description?: unknown;
        subtasks?: Array<{
          key?: string;
          fields?: {
            summary?: string;
          };
        }>;
      };
    };

    return {
      description: this.extractJiraDocumentText(payload.fields?.description),
      subtasks:
        payload.fields?.subtasks
          ?.map((subtask) => [subtask.key, subtask.fields?.summary].filter(Boolean).join(': '))
          .filter(Boolean) ?? [],
    };
  }

  private extractJiraDocumentText(description: unknown): string {
    if (typeof description === 'string') {
      return description;
    }

    if (!description || typeof description !== 'object') {
      return '';
    }

    const visit = (node: unknown): string[] => {
      if (!node || typeof node !== 'object') {
        return [];
      }

      const record = node as {
        text?: string;
        content?: unknown[];
      };

      return [
        ...(record.text ? [record.text] : []),
        ...((record.content ?? []).flatMap((child) => visit(child))),
      ];
    };

    return visit(description).join(' ').replace(/\s+/g, ' ').trim();
  }

  private buildTools(): OpenAI.Responses.Tool[] {
    return [
      {
        type: 'function',
        name: 'list_files',
        description: 'List files and folders under a workspace path.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Directory path relative to the repository root.' },
          },
          required: ['path'],
        },
      },
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a UTF-8 text file from the repository workspace.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'File path relative to the repository root.' },
          },
          required: ['path'],
        },
      },
      {
        type: 'function',
        name: 'search_text',
        description: 'Search literal text in tracked files and return matching lines.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Literal text to search for.' },
          },
          required: ['query'],
        },
      },
      {
        type: 'function',
        name: 'write_file',
        description: 'Replace the contents of a UTF-8 text file in the workspace.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'File path relative to the repository root.' },
            content: { type: 'string', description: 'Full replacement content for the file.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        type: 'function',
        name: 'submit_plan',
        description:
          'Submit the implementation plan before editing files, especially for architecture replication tasks.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            files_to_create: {
              type: 'array',
              items: { type: 'string' },
            },
            files_to_update: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['summary', 'files_to_create', 'files_to_update'],
        },
      },
      {
        type: 'function',
        name: 'run_command',
        description: 'Run an allowed validation command such as npm test, npm run build, or git diff.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Allowed command to execute.' },
          },
          required: ['command'],
        },
      },
      {
        type: 'function',
        name: 'finish_task',
        description: 'Finish the task after making real code changes and validating them.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            commit_message: { type: 'string' },
            tests_ran: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['summary', 'commit_message', 'tests_ran'],
        },
      },
      {
        type: 'function',
        name: 'block_task',
        description: 'Block the task when it cannot be completed safely with the available context.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ];
  }

  private extractFunctionCalls(
    response: OpenAI.Responses.Response,
  ): Array<{ name: string; call_id: string; arguments: string }> {
    return response.output
      .filter(
        (item): item is Extract<typeof item, { type: 'function_call' }> =>
          item.type === 'function_call',
      )
      .map((item) => ({
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments,
      }));
  }

  private async handleFunctionCall(input: {
    call: { name: string; call_id: string; arguments: string };
    snapshot: WorkspaceSnapshot;
    testsRun: string[];
    trace: ExecutionTrace;
    issueStrategy: IssueStrategyContext;
    referenceBlueprint: FeatureBlueprint | null;
    planState: PlanState;
    job: {
      id: string;
      jiraIssueKey: string;
      jiraIssueTitle: string;
      slackChannel: string;
      repositoryOwner: string;
      repositoryName: string;
    };
  }): Promise<
    | { kind: 'continue'; payload: unknown }
    | { kind: 'blocked'; reason: string }
    | { kind: 'finish'; finish: FinishAction }
  > {
    const args = JSON.parse(input.call.arguments || '{}') as Record<string, unknown>;

    switch (input.call.name) {
      case 'list_files': {
        const path = this.requireString(args.path, 'path');
        const files = await this.executionWorkspaceService.listFiles(input.snapshot.repoDir, path);
        this.appendTrace(input.trace.steps, `list_files ${path}`);
        return { kind: 'continue', payload: { path, files } };
      }
      case 'read_file': {
        const path = this.requireString(args.path, 'path');
        this.assertSafeReadPath(path);
        const content = await this.executionWorkspaceService.readWorkspaceFile(
          input.snapshot.repoDir,
          path,
        );
        this.appendTrace(input.trace.filesRead, path);
        return { kind: 'continue', payload: { path, content } };
      }
      case 'search_text': {
        const query = this.requireString(args.query, 'query');
        const matches = await this.executionWorkspaceService.searchWorkspace(
          input.snapshot.repoDir,
          query,
        );
        this.appendTrace(input.trace.searchQueries, query);
        return { kind: 'continue', payload: { query, matches } };
      }
      case 'write_file': {
        const path = this.requireString(args.path, 'path');
        const content = this.requireString(args.content, 'content');
        if (input.issueStrategy.mode === 'architecture_replication' && !input.planState.submitted) {
          return {
            kind: 'continue',
            payload: {
              write_blocked: true,
              instruction:
                'You must call submit_plan with the files to create and update before writing files for this architecture replication task.',
              reference_feature: input.issueStrategy.referenceFeature,
              target_feature: input.issueStrategy.targetFeature,
              blueprint_files: input.referenceBlueprint?.files ?? [],
            },
          };
        }
        await this.executionWorkspaceService.writeWorkspaceFile(
          input.snapshot.repoDir,
          path,
          content,
        );
        this.appendTrace(input.trace.filesWritten, path);
        return { kind: 'continue', payload: { path, written: true } };
      }
      case 'submit_plan': {
        const summary = this.requireString(args.summary, 'summary');
        const filesToCreate = this.requireStringArray(args.files_to_create, 'files_to_create');
        const filesToUpdate = this.requireStringArray(args.files_to_update, 'files_to_update');
        input.planState.submitted = true;
        input.planState.summary = summary;
        input.planState.filesToCreate = filesToCreate;
        input.planState.filesToUpdate = filesToUpdate;
        this.appendTrace(input.trace.steps, `plan submitted: ${summary}`);
        return {
          kind: 'continue',
          payload: {
            plan_accepted: true,
            summary,
            files_to_create: filesToCreate,
            files_to_update: filesToUpdate,
          },
        };
      }
      case 'run_command': {
        const command = this.requireString(args.command, 'command');
        const output = await this.executionWorkspaceService.runAllowedCommand(
          input.snapshot.repoDir,
          command,
        );
        input.testsRun.push(command);
        this.appendTrace(input.trace.commands, command);
        return { kind: 'continue', payload: { command, output } };
      }
      case 'block_task': {
        return {
          kind: 'blocked',
          reason:
            this.requireString(args.summary, 'summary') ||
            `Codex blocked execution for ${input.job.jiraIssueKey}.`,
        };
      }
      case 'finish_task': {
        return {
          kind: 'finish',
          finish: {
            summary: this.requireString(args.summary, 'summary'),
            commit_message: this.requireString(args.commit_message, 'commit_message'),
            tests_ran: this.requireStringArray(args.tests_ran, 'tests_ran'),
          },
        };
      }
      default:
        throw new Error(`Unsupported Codex function call "${input.call.name}".`);
    }
  }

  private async handleFinishAction(input: {
    job: {
      id: string;
      jiraIssueKey: string;
      jiraIssueTitle: string;
      slackChannel: string;
      repositoryOwner: string;
      repositoryName: string;
    };
    snapshot: WorkspaceSnapshot;
    finish: FinishAction;
    testsRun: string[];
    validationState: ValidationState;
  }): Promise<
    | { kind: 'continue'; payload: unknown }
    | { kind: 'completed'; pullRequestUrl: string }
  > {
    const validationFeedback = await this.runValidationGate({
      jiraIssueKey: input.job.jiraIssueKey,
      snapshot: input.snapshot,
      testsRun: input.testsRun,
      validationState: input.validationState,
    });

    if (validationFeedback) {
      return {
        kind: 'continue',
        payload: validationFeedback,
      };
    }

    const pullRequestUrl = await this.finalizeJob(input);
    return {
      kind: 'completed',
      pullRequestUrl,
    };
  }

  private async runValidationGate(input: {
    jiraIssueKey: string;
    snapshot: WorkspaceSnapshot;
    testsRun: string[];
    validationState: ValidationState;
  }): Promise<unknown | null> {
    if (input.validationState.build.available && !input.validationState.build.passed) {
      input.validationState.build.attempts += 1;
      const buildCommand = this.getValidationCommand(input.validationState.packageManager, 'build');
      const buildResult = await this.runValidationCommand(input.snapshot.repoDir, buildCommand);
      input.testsRun.push(buildCommand);

      if (buildResult.ok) {
        input.validationState.build.passed = true;
      } else if (input.validationState.build.attempts < 3) {
        return {
          validation_status: 'build_failed_retry',
          command: buildCommand,
          attempt: input.validationState.build.attempts,
          max_attempts: 3,
          output: buildResult.output,
          instruction:
            'Build failed. Inspect the error, fix the code, and call finish_task again when ready. You still have remaining build retries.',
        };
      } else {
        throw new Error(
          [
            `Build validation failed after 3 attempts for ${input.jiraIssueKey}.`,
            `Command: ${buildCommand}`,
            'Output:',
            buildResult.output,
          ].join('\n'),
        );
      }
    }

    if (input.validationState.test.available && !input.validationState.test.passed) {
      input.validationState.test.attempts += 1;
      const testCommand = this.getValidationCommand(input.validationState.packageManager, 'test');
      const testResult = await this.runValidationCommand(input.snapshot.repoDir, testCommand);
      input.testsRun.push(testCommand);

      if (!testResult.ok) {
        throw new Error(
          [
            `Test validation failed for ${input.jiraIssueKey}.`,
            `Command: ${testCommand}`,
            'Output:',
            testResult.output,
          ].join('\n'),
        );
      }

      input.validationState.test.passed = true;
    }

    if (input.validationState.lint.available && !input.validationState.lint.passed) {
      input.validationState.lint.attempts += 1;
      const lintCommand = this.getValidationCommand(input.validationState.packageManager, 'lint');
      const lintResult = await this.runValidationCommand(input.snapshot.repoDir, lintCommand);
      input.testsRun.push(lintCommand);

      if (!lintResult.ok) {
        throw new Error(
          [
            `Lint validation failed for ${input.jiraIssueKey}.`,
            `Command: ${lintCommand}`,
            'Output:',
            lintResult.output,
          ].join('\n'),
        );
      }

      input.validationState.lint.passed = true;
    }

    return null;
  }

  private extractFeatureMentions(corpus: string): string[] {
    const matches = [...corpus.matchAll(/(?:pagina|página|page|modulo|m[oó]dulo|feature)\s+([a-z0-9_-]+)/gi)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));

    return [...new Set(matches)].slice(0, 5);
  }

  private buildFeatureBlueprint(
    fileList: string[],
    referenceFeature: string | null,
  ): FeatureBlueprint | null {
    if (!referenceFeature) {
      return null;
    }

    const escapedFeature = referenceFeature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const featurePattern = new RegExp(`(^|/|\\\\)${escapedFeature}([./_-]|$)`, 'i');
    const files = fileList.filter((path) => featurePattern.test(path)).slice(0, 40);

    if (!files.length) {
      return null;
    }

    return {
      featureName: referenceFeature,
      files,
      routeFiles: fileList
        .filter((path) => /src\/routes\//i.test(path))
        .slice(0, 12),
      serviceFiles: files.filter((path) => /service|api/i.test(path)),
      interfaceFiles: files.filter((path) => /interface|types?/i.test(path)),
      componentFiles: files.filter((path) => /component/i.test(path)),
    };
  }

  private extractTargetFeature(corpus: string): string | null {
    const targetMatch = corpus.match(/(?:criar|nova|novo|adicionar)\s+(?:pagina|página|page|modulo|m[oó]dulo|feature)\s+([a-z0-9_-]+)/i);
    return targetMatch?.[1]?.trim() ?? null;
  }

  private async finalizeJob(input: {
    job: {
      id: string;
      jiraIssueKey: string;
      jiraIssueTitle: string;
      slackChannel: string;
      repositoryOwner: string;
      repositoryName: string;
    };
    snapshot: WorkspaceSnapshot;
    finish: FinishAction;
    testsRun: string[];
    validationState: ValidationState;
  }): Promise<string> {
    const diff = await this.executionWorkspaceService.getGitDiff(input.snapshot.repoDir);
    const hasChanges = await this.executionWorkspaceService.hasChanges(input.snapshot.repoDir);
    const validationCommands = this.extractValidationCommands(input.testsRun);

    if (!hasChanges) {
      throw new Error(
        `Codex called finish_task for ${input.job.jiraIssueKey}, but no workspace changes were detected.`,
      );
    }

    await this.prisma.agentJob.update({
      where: { id: input.job.id },
      data: { status: JobStatus.pr_opened },
    });

    await this.executionWorkspaceService.commitAndPush({
      repoDir: input.snapshot.repoDir,
      branchName: input.snapshot.branchName,
      commitMessage:
        input.finish.commit_message?.trim() || `feat(ai): implement ${input.job.jiraIssueKey}`,
    });

    const pullRequestUrl = await this.createPullRequest({
      token: process.env.GITHUB_TOKEN!.trim(),
      owner: input.job.repositoryOwner,
      repo: input.job.repositoryName,
      title: `[AI] ${input.job.jiraIssueKey}: ${input.job.jiraIssueTitle}`,
      head: input.snapshot.branchName,
      base: input.snapshot.baseBranch,
      body: [
        input.finish.summary || `Automated implementation for ${input.job.jiraIssueKey}.`,
        '',
        `- Branch: ${input.snapshot.branchName}`,
        `- Validations run: ${validationCommands.join(' | ') || 'none reported'}`,
        '',
        'Generated by CodexExecutionService with function calling workspace tools.',
        '',
        'Diff summary:',
        diff || 'No diff available.',
      ].join('\n'),
    });

    await this.prisma.agentJob.update({
      where: { id: input.job.id },
      data: {
        status: JobStatus.completed,
        pullRequestUrl,
        summary:
          input.finish.summary ||
          `Codex completed ${input.job.jiraIssueKey} and opened a pull request successfully.`,
      },
    });

    await this.slackService.sendCompletionSummary({
      jiraIssueKey: input.job.jiraIssueKey,
      pullRequestUrl,
      summary:
        input.finish.summary ||
        `Codex completed ${input.job.jiraIssueKey} and opened a pull request successfully.`,
      slackChannel: input.job.slackChannel,
    });

    return pullRequestUrl;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Codex tool call is missing required string field "${field}".`);
    }

    return value;
  }

  private requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`Codex tool call is missing required string[] field "${field}".`);
    }

    return value;
  }

  private extractValidationCommands(commands: string[]): string[] {
    return commands.filter((command) =>
      /(^|\s)(npm|pnpm|yarn)\s+(run\s+)?(build|test|lint)\b/.test(command.trim()),
    );
  }

  private createValidationState(packageJson: string | null, fileList: string[]): ValidationState {
    const scripts = this.extractScripts(packageJson);
    return {
      packageManager: this.detectPackageManager(packageJson, fileList),
      build: {
        available: typeof scripts.build === 'string',
        attempts: 0,
        passed: false,
      },
      test: {
        available: typeof scripts.test === 'string',
        attempts: 0,
        passed: false,
      },
      lint: {
        available: typeof scripts.lint === 'string',
        attempts: 0,
        passed: false,
      },
    };
  }

  private extractScripts(packageJson: string | null): Record<string, string> {
    if (!packageJson) {
      return {};
    }

    try {
      const parsed = JSON.parse(packageJson) as {
        scripts?: Record<string, string>;
      };

      return parsed.scripts ?? {};
    } catch {
      return {};
    }
  }

  private detectPackageManager(
    packageJson: string | null,
    fileList: string[],
  ): 'npm' | 'pnpm' | 'yarn' {
    if (packageJson) {
      try {
        const parsed = JSON.parse(packageJson) as {
          packageManager?: string;
        };
        const packageManager = parsed.packageManager?.toLowerCase() ?? '';

        if (packageManager.startsWith('pnpm')) {
          return 'pnpm';
        }

        if (packageManager.startsWith('yarn')) {
          return 'yarn';
        }
      } catch {
        // ignore
      }
    }

    if (fileList.includes('pnpm-lock.yaml')) {
      return 'pnpm';
    }

    if (fileList.includes('yarn.lock')) {
      return 'yarn';
    }

    return 'npm';
  }

  private getValidationCommand(
    packageManager: 'npm' | 'pnpm' | 'yarn',
    script: 'build' | 'test' | 'lint',
  ): string {
    if (packageManager === 'yarn') {
      return `yarn ${script}`;
    }

    if (packageManager === 'pnpm') {
      return `pnpm run ${script}`;
    }

    return `npm run ${script}`;
  }

  private async runValidationCommand(
    repoDir: string,
    command: string,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const output = await this.executionWorkspaceService.runAllowedCommand(repoDir, command);
      return {
        ok: true,
        output: output || '(command completed without output)',
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : 'Unknown command failure.',
      };
    }
  }

  private createTrace(): ExecutionTrace {
    return {
      steps: [],
      filesRead: [],
      filesWritten: [],
      searchQueries: [],
      commands: [],
    };
  }

  private createPlanState(): PlanState {
    return {
      submitted: false,
      summary: null,
      filesToCreate: [],
      filesToUpdate: [],
    };
  }

  private assertSafeReadPath(path: string): void {
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    if (normalized === '.env' || normalized.startsWith('.env.') || normalized.endsWith('/.env')) {
      throw new Error(`Reading ${path} is not allowed for Codex execution.`);
    }
  }

  private appendTrace(target: string[], entry: string): void {
    const normalized = entry.trim();
    if (!normalized) {
      return;
    }

    target.push(normalized);
    if (target.length > 10) {
      target.splice(0, target.length - 10);
    }
  }

  private appendTraceSummary(reason: string, trace: ExecutionTrace): string {
    const sections = [
      trace.steps.length ? `Recent steps: ${trace.steps.join(' -> ')}` : '',
      trace.filesRead.length ? `Files read: ${trace.filesRead.join(', ')}` : '',
      trace.filesWritten.length ? `Files written: ${trace.filesWritten.join(', ')}` : '',
      trace.searchQueries.length ? `Searches: ${trace.searchQueries.join(' | ')}` : '',
      trace.commands.length ? `Commands: ${trace.commands.join(' | ')}` : '',
    ].filter(Boolean);

    if (!sections.length) {
      return reason;
    }

    return `${reason}\n${sections.join('\n')}`;
  }

  private summarizeForTrace(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable payload]';
    }
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
    const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls`, {
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
    });

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

  private async failJob(
    jobId: string,
    jiraIssueKey: string,
    slackChannel: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.agentJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.failed,
        summary: reason,
      },
    });

    await this.slackService.sendFailureSummary({
      jiraIssueKey,
      summary: reason,
      slackChannel,
    });
  }
}
