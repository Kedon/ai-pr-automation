-- Create the new enum with the streamlined lifecycle.
CREATE TYPE "JobStatus_new" AS ENUM (
    'queued',
    'sent_to_codex',
    'running',
    'pr_opened',
    'completed',
    'failed',
    'blocked'
);

-- Drop the old default so we can cast the column safely.
ALTER TABLE "AgentJob" ALTER COLUMN "status" DROP DEFAULT;

-- Convert existing rows to the new lifecycle values.
ALTER TABLE "AgentJob"
ALTER COLUMN "status" TYPE "JobStatus_new"
USING (
    CASE "status"::text
        WHEN 'pending_approval' THEN 'queued'
        WHEN 'approved' THEN 'sent_to_codex'
        ELSE "status"::text
    END
)::"JobStatus_new";

-- Swap enum types.
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
DROP TYPE "JobStatus_old";

-- Restore the default lifecycle status.
ALTER TABLE "AgentJob" ALTER COLUMN "status" SET DEFAULT 'queued';

-- Approval records are no longer used in the auto-start flow.
DROP TABLE "AgentJobApproval";
DROP TYPE "ApprovalStatus";
