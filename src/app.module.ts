import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentJobsModule } from './modules/agent-jobs/agent-jobs.module';
import { JiraModule } from './modules/jira/jira.module';
import { ProjectConfigsModule } from './modules/project-configs/project-configs.module';
import { SlackModule } from './modules/slack/slack.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [ProjectConfigsModule, AgentJobsModule, JiraModule, SlackModule],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
