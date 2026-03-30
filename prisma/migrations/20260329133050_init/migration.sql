-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending_approval', 'approved', 'running', 'completed', 'failed', 'blocked');

-- CreateTable
CREATE TABLE "ProjectConfig" (
    "id" TEXT NOT NULL,
    "jiraProjectKey" TEXT NOT NULL,
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "defaultBaseBranch" TEXT NOT NULL DEFAULT 'main',
    "slackChannel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "jiraIssueKey" TEXT NOT NULL,
    "jiraIssueTitle" TEXT NOT NULL,
    "jiraIssueUrl" TEXT,
    "promptTrigger" TEXT NOT NULL,
    "branchName" TEXT,
    "pullRequestUrl" TEXT,
    "summary" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'pending_approval',
    "projectConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectConfig_jiraProjectKey_key" ON "ProjectConfig"("jiraProjectKey");

-- CreateIndex
CREATE INDEX "AgentJob_jiraIssueKey_idx" ON "AgentJob"("jiraIssueKey");

-- CreateIndex
CREATE INDEX "AgentJob_status_idx" ON "AgentJob"("status");

-- AddForeignKey
ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_projectConfigId_fkey" FOREIGN KEY ("projectConfigId") REFERENCES "ProjectConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
