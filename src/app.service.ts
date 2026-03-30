import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async getHealth() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      service: 'ai-pr-automation',
      status: 'ok',
      database: 'connected',
      rules: {
        pullRequestRequired: true,
        protectedBranchWritesBlocked: true,
        agentBranchPrefix: 'ai/',
      },
    };
  }
}

