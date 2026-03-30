import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectConfig } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateProjectConfigInput {
  jiraProjectKey: string;
  repositoryOwner: string;
  repositoryName: string;
  defaultBaseBranch?: string;
  slackChannel: string;
  enabled?: boolean;
}

@Injectable()
export class ProjectConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateProjectConfigInput): Promise<ProjectConfig> {
    const jiraProjectKey = input.jiraProjectKey.trim().toUpperCase();
    const repositoryOwner = input.repositoryOwner.trim();
    const repositoryName = input.repositoryName.trim();
    const defaultBaseBranch = input.defaultBaseBranch?.trim() || 'main';
    const slackChannel = input.slackChannel.trim();

    if (!jiraProjectKey || !repositoryOwner || !repositoryName || !slackChannel) {
      throw new BadRequestException('Missing required project configuration fields.');
    }

    try {
      return await this.prisma.projectConfig.create({
        data: {
          jiraProjectKey,
          repositoryOwner,
          repositoryName,
          defaultBaseBranch,
          slackChannel,
          enabled: input.enabled ?? true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(
          `Project config for Jira key "${jiraProjectKey}" already exists.`,
        );
      }

      throw error;
    }
  }

  async findAll(): Promise<ProjectConfig[]> {
    return this.prisma.projectConfig.findMany({
      orderBy: {
        jiraProjectKey: 'asc',
      },
    });
  }

  async findByJiraProjectKey(jiraProjectKey: string): Promise<ProjectConfig> {
    const projectConfig = await this.prisma.projectConfig.findUnique({
      where: {
        jiraProjectKey: jiraProjectKey.trim().toUpperCase(),
      },
    });

    if (!projectConfig) {
      throw new NotFoundException(
        `Project config for Jira key "${jiraProjectKey}" was not found.`,
      );
    }

    return projectConfig;
  }
}

