// Independently authored TypeSpec structural authority for the transport parity canary.
// The authored JSON Schema peer is maintained independently; generated schema is evidence only.
import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace FiduciaTransportParityCanary;

@id("OpportunityAdmissionRequest")
model OpportunityAdmissionRequest {
  shown_to_alex: boolean;
  approved_by_alex: boolean;
  legal_terms_accepted: boolean;
  payment_obligation_accepted: boolean;
  travel_commitment_accepted: boolean;
  recording_publicity_consent_accepted: boolean;
  relocation_commitment_accepted: boolean;
}

@id("OpportunityAdmissionResponse")
model OpportunityAdmissionResponse {
  admissible: boolean;
  violations: string[];
}
