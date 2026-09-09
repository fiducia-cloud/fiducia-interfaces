// Independently authored TypeSpec authority for Fiducia opportunity packets.
// JSON Schema generated from this file is comparison evidence only and must
// never overwrite the independently authored Draft 2020-12 peer authority.
import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace FiduciaOpportunityContract;

@id("OpportunityKind")
enum OpportunityKind {
  fundraising: "fundraising",
  computingCredit: "computing_credit",
  aiCredit: "ai_credit",
  conference: "conference",
  job: "job",
}

@id("PacketState")
enum PacketState {
  prepared: "prepared",
  approved: "approved",
  submitted: "submitted",
  acknowledged: "acknowledged",
  rejected: "rejected",
  withdrawn: "withdrawn",
}

@id("IntakeMode")
enum IntakeMode {
  email: "email",
  portal: "portal",
}

@id("PublicCompanyReferences")
model PublicCompanyReferences {
  website: string;
  githubOrganization: string;
  founderLinkedIn: string;
  officialContactEmail: string;
}

@id("ExplicitApproval")
model ExplicitApproval {
  shownToAlex: boolean;
  approvedByAlex: boolean;
  packetDigestSha256: string;
  approvedAt?: utcDateTime;
}

@id("ConsequentialCommitments")
model ConsequentialCommitments {
  legalTermsAccepted: boolean;
  paymentObligationAccepted: boolean;
  travelCommitmentAccepted: boolean;
  recordingPublicityConsentAccepted: boolean;
  relocationCommitmentAccepted: boolean;
}

@id("OpportunityApplicationPacket")
model OpportunityApplicationPacket {
  contractVersion: string;
  packetId: string;
  provider: string;
  program: string;
  cycle: string;
  kind: OpportunityKind;
  state: PacketState;
  intakeMode: IntakeMode;
  officialIntakeRoute: string;
  references: PublicCompanyReferences;
  approval: ExplicitApproval;
  commitments: ConsequentialCommitments;
  verifiedFacts: string[];
  unresolvedFacts: string[];
  requisition?: string;
  deadline?: utcDateTime;
  submittedAt?: utcDateTime;
}
