-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "AgentJobApproval" (
    "id" TEXT NOT NULL,
    "agentJobId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "approvalToken" TEXT NOT NULL,
    "slackChannel" TEXT NOT NULL,
    "slackMessageTs" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "rejectionReason" TEXT,

    CONSTRAINT "AgentJobApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentJobApproval_approvalToken_key" ON "AgentJobApproval"("approvalToken");

-- CreateIndex
CREATE INDEX "AgentJobApproval_agentJobId_status_idx" ON "AgentJobApproval"("agentJobId", "status");

-- AddForeignKey
ALTER TABLE "AgentJobApproval" ADD CONSTRAINT "AgentJobApproval_agentJobId_fkey" FOREIGN KEY ("agentJobId") REFERENCES "AgentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
