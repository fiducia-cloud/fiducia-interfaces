// Service declaration reuses the independently admitted request/response models.
// HTTP and Protobuf bindings are projections and must preserve this operation identity.
import "./main.tsp";

using FiduciaTransportParityCanary;

namespace FiduciaTransportParityCanaryService;

op evaluate_opportunity_admission(
  request: OpportunityAdmissionRequest
): OpportunityAdmissionResponse;
