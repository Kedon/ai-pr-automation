import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { JiraService } from './jira.service';

@Controller('jira')
export class JiraAdminController {
  constructor(private readonly jiraService: JiraService) {}

  @Get('connection')
  testConnection() {
    return this.jiraService.testConnection();
  }

  @Get('projects')
  listProjects() {
    return this.jiraService.listProjects();
  }

  @Get('issues/eligible')
  listEligibleIssues(@Query('projectKey') projectKey?: string) {
    return this.jiraService.searchEligibleIssues(projectKey);
  }

  @Get('issues/:issueKey/transitions')
  listTransitions(@Param('issueKey') issueKey: string) {
    return this.jiraService.listIssueTransitions(issueKey);
  }

  @Post('issues/:issueKey/move-to-ai-agent')
  moveToAiAgent(@Param('issueKey') issueKey: string) {
    return this.jiraService.moveIssueToAiAgent(issueKey);
  }

  @Post('issues/:issueKey/enqueue')
  enqueueIssue(@Param('issueKey') issueKey: string) {
    return this.jiraService.enqueueIssueByKey(issueKey);
  }
}
