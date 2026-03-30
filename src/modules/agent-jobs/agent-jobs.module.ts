import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SlackModule } from '../slack/slack.module';
import { AgentJobExecutorService } from './agent-job-executor.service';
import { AgentJobsController } from './agent-jobs.controller';
import { AgentJobsService } from './agent-jobs.service';

@Module({
  imports: [SlackModule],
  controllers: [AgentJobsController],
  providers: [AgentJobsService, AgentJobExecutorService, PrismaService],
  exports: [AgentJobsService, AgentJobExecutorService],
})
export class AgentJobsModule {}
