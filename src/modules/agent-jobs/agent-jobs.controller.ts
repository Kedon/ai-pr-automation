import { Controller, Get, Param } from '@nestjs/common';
import { AgentJobsService } from './agent-jobs.service';

@Controller('agent-jobs')
export class AgentJobsController {
  constructor(private readonly agentJobsService: AgentJobsService) {}

  @Get()
  list() {
    return this.agentJobsService.findAll();
  }

  @Get(':jobId')
  getById(@Param('jobId') jobId: string) {
    return this.agentJobsService.findById(jobId);
  }
}
