import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { AgentJobsModule } from '../agent-jobs/agent-jobs.module';
import { ProjectConfigsModule } from '../project-configs/project-configs.module';
import { SlackModule } from '../slack/slack.module';
import { JiraAdminController } from './jira-admin.controller';
import { JiraController } from './jira.controller';
import { JiraService } from './jira.service';

@Module({
  imports: [ProjectConfigsModule, AgentJobsModule, SlackModule, ExecutionModule],
  controllers: [JiraController, JiraAdminController],
  providers: [JiraService],
})
export class JiraModule {}
