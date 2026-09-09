import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = "fiducia.opportunity-application/v1";
const OFFICIAL_CONTACT = "hello@fiducia.cloud";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const PACKET_ID_RE = /^[a-z0-9][a-z0-9._:-]{7,159}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /lin_api_[A-Za-z0-9_-]{20,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:access|secret)[_-]?key\s*[:=]/iu,
];
const ROOT_KEYS = new Set([
  "contractVersion",
  "packetId",
  "provider",
  "program",
  "cycle",
  "kind",
  "state",
  "intakeMode",
  "officialIntakeRoute",
  "references",
  "approval",
  "commitments",
  "verifiedFacts",
  "unresolvedFacts",
  "requisition",
  "deadline",
  "submittedAt",
]);
const REQUIRED_ROOT_KEYS = new Set([
  "contractVersion",
  "packetId",
  "provider",
  "program",
  "cycle",
  "kind",
  "state",
  "intakeMode",
  "officialIntakeRoute",
  "references",
  "approval",
  "commitments",
  "verifiedFacts",
  "unresolvedFacts",
]);
const REFERENCE_KEYS = new Set([
  "website",
  "githubOrganization",
  "founderLinkedIn",
  "officialContactEmail",
]);
const APPROVAL_KEYS = new Set([
  "shownToAlex",
  "approvedByAlex",
  "packetDigestSha256",
  "approvedAt",
]);
const COMMITMENT_KEYS = new Set([
  "legalTermsAccepted",
  "paymentObligationAccepted",
  "travelCommitmentAccepted",
  "recordingPublicityConsentAccepted",
  "relocationCommitmentAccepted",
]);
const KINDS = new Set(["fundraising", "computing_credit", "ai_credit", "conference", "job"]);
const STATES = new Set(["prepared", "approved", "submitted", "acknowledged", "rejected", "withdrawn"]);
const INTAKE_MODES = new Set(["email", "portal"]);
const SUBMITTED_STATES = new Set(["submitted", "acknowledged", "rejected", "withdrawn"]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, allowed, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
}

function nonEmptyString(value, label, maxLength = 2048) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > maxLength) {
    fail(`${label} must be a trimmed non-empty string of at most ${maxLength} characters`);
  }
  if (/[\r\n\0]/u.test(value)) fail(`${label} must be single-line text`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function timestamp(value, label) {
  nonEmptyString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return value;
}

function publicHttpsUrl(value, label) {
  nonEmptyString(value, label, 2048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(`${label} must be an HTTPS URL without embedded credentials`);
  }
  if (parsed.search || parsed.hash) fail(`${label} must not contain a query string or fragment`);
  return value;
}

function checkedStringArray(value, label) {
  if (!Array.isArray(value) || value.length > 32) fail(`${label} must be an array with at most 32 entries`);
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`, 320));
  if (new Set(normalized.map((entry) => entry.toLowerCase())).size !== normalized.length) {
    fail(`${label} must not contain duplicates`);
  }
  return normalized;
}

function scanCredentials(value, label = "packet") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanCredentials(entry, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) scanCredentials(entry, `${label}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) fail(`${label} contains credential-shaped material`);
  }
}

export function validateOpportunityApplicationPacket(packet) {
  scanCredentials(packet);
  exactKeys(packet, REQUIRED_ROOT_KEYS, ROOT_KEYS, "packet");

  if (packet.contractVersion !== CONTRACT_VERSION) {
    fail(`packet.contractVersion must equal ${CONTRACT_VERSION}`);
  }
  if (typeof packet.packetId !== "string" || !PACKET_ID_RE.test(packet.packetId)) {
    fail("packet.packetId must be a normalized stable identity");
  }
  nonEmptyString(packet.provider, "packet.provider", 160);
  nonEmptyString(packet.program, "packet.program", 240);
  nonEmptyString(packet.cycle, "packet.cycle", 80);
  if (!KINDS.has(packet.kind)) fail("packet.kind is invalid");
  if (!STATES.has(packet.state)) fail("packet.state is invalid");
  if (!INTAKE_MODES.has(packet.intakeMode)) fail("packet.intakeMode is invalid");

  nonEmptyString(packet.officialIntakeRoute, "packet.officialIntakeRoute", 2048);
  if (packet.intakeMode === "email") {
    if (!EMAIL_RE.test(packet.officialIntakeRoute)) fail("email intake route must be an email address");
  } else {
    publicHttpsUrl(packet.officialIntakeRoute, "packet.officialIntakeRoute");
  }

  exactKeys(packet.references, REFERENCE_KEYS, REFERENCE_KEYS, "packet.references");
  publicHttpsUrl(packet.references.website, "packet.references.website");
  publicHttpsUrl(packet.references.githubOrganization, "packet.references.githubOrganization");
  publicHttpsUrl(packet.references.founderLinkedIn, "packet.references.founderLinkedIn");
  if (packet.references.officialContactEmail !== OFFICIAL_CONTACT) {
    fail(`packet.references.officialContactEmail must equal ${OFFICIAL_CONTACT}`);
  }

  exactKeys(
    packet.approval,
    new Set(["shownToAlex", "approvedByAlex", "packetDigestSha256"]),
    APPROVAL_KEYS,
    "packet.approval",
  );
  boolean(packet.approval.shownToAlex, "packet.approval.shownToAlex");
  boolean(packet.approval.approvedByAlex, "packet.approval.approvedByAlex");
  if (typeof packet.approval.packetDigestSha256 !== "string") {
    fail("packet.approval.packetDigestSha256 must be a string");
  }

  exactKeys(packet.commitments, COMMITMENT_KEYS, COMMITMENT_KEYS, "packet.commitments");
  for (const key of COMMITMENT_KEYS) {
    boolean(packet.commitments[key], `packet.commitments.${key}`);
    if (packet.commitments[key] !== false) {
      fail(`packet.commitments.${key} must remain false in the opportunity automation boundary`);
    }
  }

  const verifiedFacts = checkedStringArray(packet.verifiedFacts, "packet.verifiedFacts");
  const unresolvedFacts = checkedStringArray(packet.unresolvedFacts, "packet.unresolvedFacts");
  const verifiedSet = new Set(verifiedFacts.map((entry) => entry.toLowerCase()));
  for (const fact of unresolvedFacts) {
    if (verifiedSet.has(fact.toLowerCase())) fail("a fact cannot be both verified and unresolved");
  }

  if (packet.requisition !== undefined) nonEmptyString(packet.requisition, "packet.requisition", 160);
  if (packet.deadline !== undefined) timestamp(packet.deadline, "packet.deadline");

  const requiresApproval = packet.state !== "prepared";
  if (!requiresApproval) {
    if (packet.approval.shownToAlex || packet.approval.approvedByAlex) {
      fail("prepared packets must not claim approval");
    }
    if (packet.approval.packetDigestSha256 !== "") {
      fail("prepared packets must use an empty approval digest");
    }
    if (packet.approval.approvedAt !== undefined) fail("prepared packets must not include approvedAt");
    if (packet.submittedAt !== undefined) fail("prepared packets must not include submittedAt");
  } else {
    if (!packet.approval.shownToAlex || !packet.approval.approvedByAlex) {
      fail("consequential states require the completed packet to be shown to and approved by Alex");
    }
    if (!SHA256_RE.test(packet.approval.packetDigestSha256)) {
      fail("approved packets require a lowercase SHA-256 packet digest");
    }
    if (packet.approval.approvedAt === undefined) fail("approved packets require approvedAt");
    timestamp(packet.approval.approvedAt, "packet.approval.approvedAt");
  }

  if (SUBMITTED_STATES.has(packet.state)) {
    if (packet.submittedAt === undefined) fail("submitted or post-submission states require submittedAt");
    timestamp(packet.submittedAt, "packet.submittedAt");
    if (Date.parse(packet.submittedAt) < Date.parse(packet.approval.approvedAt)) {
      fail("packet.submittedAt must not precede packet.approval.approvedAt");
    }
  } else if (packet.submittedAt !== undefined) {
    fail("prepared and approved packets must not include submittedAt");
  }

  return packet;
}

export const opportunityApplicationPolicy = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  officialContact: OFFICIAL_CONTACT,
  kinds: Object.freeze([...KINDS]),
  states: Object.freeze([...STATES]),
  intakeModes: Object.freeze([...INTAKE_MODES]),
  commitmentKeys: Object.freeze([...COMMITMENT_KEYS]),
});

function main() {
  const input = process.argv[2];
  if (!input) fail("usage: node src/opportunity-application-policy.mjs '<json>'");
  validateOpportunityApplicationPacket(JSON.parse(input));
  process.stdout.write("opportunity application packet accepted\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
