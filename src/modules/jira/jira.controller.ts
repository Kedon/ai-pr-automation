import { Body, Controller, Post } from '@nestjs/common';
import { JiraService } from './jira.service';

@Controller('jira')
export class JiraController {
  constructor(private readonly jiraService: JiraService) {}

  @Post('webhook')
  handleWebhook(@Body() body: unknown) {
    return this.jiraService.handleWebhook(body as never);
  }
}
