import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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

  @Post(':jobId/fail')
  failJob(
    @Param('jobId') jobId: string,
    @Body() body: { summary?: string },
  ) {
    return this.agentJobsService.markFailed(
      jobId,
      body?.summary?.trim() || 'Job manually marked as failed.',
    );
  }
}
