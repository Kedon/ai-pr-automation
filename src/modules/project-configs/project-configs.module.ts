import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectConfigsController } from './project-configs.controller';
import { ProjectConfigsService } from './project-configs.service';

@Module({
  controllers: [ProjectConfigsController],
  providers: [ProjectConfigsService, PrismaService],
  exports: [ProjectConfigsService],
})
export class ProjectConfigsModule {}

