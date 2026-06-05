import { logger } from "../../../config/logger.js";
import { classifyEmailMilestone } from "../../ai/ai.service.js";
import { fetchMessages } from "./gmail.service.js";

export interface MilestoneHit {
  emailId: string;
  subject: string;
  date: string;
  direction: "sent" | "received" | "other";
  milestone: "forms_sent" | "receipt_confirmed" | "policy_issued" | "deposit_made" | "none";
  clientName: string | null;
  idNumber: string | null;
  policyNumber: string | null;
  evidence: string | null;
  needsAction: boolean;
  actionSummary: string | null;
}

export async function classifyMailbox(
  staffId: string,
  opts?: { q?: string; maxResults?: number },
): Promise<MilestoneHit[]> {
  const emails = await fetchMessages(staffId, {
    q: opts?.q ?? "newer_than:60d",
    maxResults: opts?.maxResults ?? 15,
  });

  const hits = await Promise.all(
    emails.map(async (email): Promise<MilestoneHit> => {
      const result = await classifyEmailMilestone({
        subject: email.subject,
        bodyText: email.bodyText,
        direction: email.direction,
      });

      return {
        emailId: email.id,
        subject: email.subject,
        date: email.date,
        direction: email.direction,
        milestone: result.milestone,
        clientName: result.clientName,
        idNumber: result.idNumber,
        policyNumber: result.policyNumber,
        evidence: result.evidence,
        needsAction: result.needsAction,
        actionSummary: result.actionSummary,
      };
    }),
  );

  const counts = hits.reduce<Record<string, number>>((acc, h) => {
    acc[h.milestone] = (acc[h.milestone] ?? 0) + 1;
    return acc;
  }, {});

  logger.info({ staffId, total: hits.length, counts }, "classifyMailbox: classification complete");

  return hits;
}
