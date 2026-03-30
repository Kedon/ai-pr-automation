import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateProjectConfigInput,
  ProjectConfigsService,
} from './project-configs.service';

@Controller('project-configs')
export class ProjectConfigsController {
  constructor(private readonly projectConfigsService: ProjectConfigsService) {}

  @Get()
  list() {
    return this.projectConfigsService.findAll();
  }

  @Get(':jiraProjectKey')
  getByJiraProjectKey(@Param('jiraProjectKey') jiraProjectKey: string) {
    return this.projectConfigsService.findByJiraProjectKey(jiraProjectKey);
  }

  @Post()
  create(@Body() body: CreateProjectConfigInput) {
    return this.projectConfigsService.create(body);
  }
}

