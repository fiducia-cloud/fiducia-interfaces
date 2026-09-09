import assert from "node:assert/strict";
import { test } from "node:test";

import {
  opportunityApplicationPolicy,
  validateOpportunityApplicationPacket,
} from "./opportunity-application-policy.mjs";

const digest = "a".repeat(64);

function packet(overrides = {}) {
  const base = {
    contractVersion: "fiducia.opportunity-application/v1",
    packetId: "fiducia:example-program:2026:conference",
    provider: "Example Provider",
    program: "Example Program",
    cycle: "2026",
    kind: "conference",
    state: "prepared",
    intakeMode: "portal",
    officialIntakeRoute: "https://example.com/cfp",
    references: {
      website: "https://fiducia.cloud",
      githubOrganization: "https://github.com/fiducia-cloud",
      founderLinkedIn: "https://www.linkedin.com",
      officialContactEmail: "hello@fiducia.cloud",
    },
    approval: {
      shownToAlex: false,
      approvedByAlex: false,
      packetDigestSha256: "",
    },
    commitments: {
      legalTermsAccepted: false,
      paymentObligationAccepted: false,
      travelCommitmentAccepted: false,
      recordingPublicityConsentAccepted: false,
      relocationCommitmentAccepted: false,
    },
    verifiedFacts: ["Official intake route verified"],
    unresolvedFacts: ["Recording terms"],
  };
  return structuredClone({ ...base, ...overrides });
}

function approved(overrides = {}) {
  return packet({
    state: "approved",
    approval: {
      shownToAlex: true,
      approvedByAlex: true,
      packetDigestSha256: digest,
      approvedAt: "2026-09-08T20:00:00Z",
    },
    ...overrides,
  });
}

test("accepts a prepared packet without consequential authority", () => {
  assert.equal(validateOpportunityApplicationPacket(packet()).state, "prepared");
});

test("accepts an explicitly approved packet with no submission timestamp", () => {
  assert.equal(validateOpportunityApplicationPacket(approved()).state, "approved");
});

test("accepts submitted evidence only after explicit packet approval", () => {
  const value = approved({
    state: "submitted",
    submittedAt: "2026-09-08T20:01:00Z",
  });
  assert.equal(validateOpportunityApplicationPacket(value).state, "submitted");
});

test("keeps the canonical company contact fixed", () => {
  const value = packet();
  value.references.officialContactEmail = "alex@example.com";
  assert.throws(() => validateOpportunityApplicationPacket(value), /hello@fiducia\.cloud/u);
});

test("requires a newly completed packet to be shown and explicitly approved", () => {
  const value = approved();
  value.approval.shownToAlex = false;
  assert.throws(() => validateOpportunityApplicationPacket(value), /shown to and approved by Alex/u);
});

test("rejects a fabricated or missing approval digest", () => {
  const value = approved();
  value.approval.packetDigestSha256 = "not-a-digest";
  assert.throws(() => validateOpportunityApplicationPacket(value), /lowercase SHA-256/u);
});

test("does not let generic authorization satisfy a consequential packet state", () => {
  const value = packet({ state: "approved" });
  assert.throws(() => validateOpportunityApplicationPacket(value), /shown to and approved by Alex/u);
});

test("rejects legal, payment, travel, publicity, and relocation commitments", () => {
  for (const key of opportunityApplicationPolicy.commitmentKeys) {
    const value = packet();
    value.commitments[key] = true;
    assert.throws(
      () => validateOpportunityApplicationPacket(value),
      new RegExp(`${key} must remain false`, "u"),
    );
  }
});

test("requires submittedAt for submitted and decision states", () => {
  for (const state of ["submitted", "acknowledged", "rejected", "withdrawn"]) {
    const value = approved({ state });
    assert.throws(() => validateOpportunityApplicationPacket(value), /require submittedAt/u);
  }
});

test("rejects timestamps that place submission before approval", () => {
  const value = approved({
    state: "submitted",
    submittedAt: "2026-09-08T19:59:59Z",
  });
  assert.throws(() => validateOpportunityApplicationPacket(value), /must not precede/u);
});

test("keeps email and portal routes type-specific and public", () => {
  assert.doesNotThrow(() => validateOpportunityApplicationPacket(packet({
    intakeMode: "email",
    officialIntakeRoute: "grants@example.com",
  })));
  assert.throws(() => validateOpportunityApplicationPacket(packet({
    officialIntakeRoute: "http://example.com/cfp",
  })), /HTTPS URL/u);
  assert.throws(() => validateOpportunityApplicationPacket(packet({
    officialIntakeRoute: "https://user:secret@example.com/cfp",
  })), /without embedded credentials/u);
});

test("rejects duplicate and contradictory fact classifications", () => {
  const duplicate = packet({ verifiedFacts: ["Official route", "official route"] });
  assert.throws(() => validateOpportunityApplicationPacket(duplicate), /duplicates/u);

  const overlap = packet({
    verifiedFacts: ["Location unresolved"],
    unresolvedFacts: ["location unresolved"],
  });
  assert.throws(() => validateOpportunityApplicationPacket(overlap), /both verified and unresolved/u);
});

test("rejects unknown fields instead of silently accepting unverified facts", () => {
  const value = packet();
  value.traction = "lots";
  assert.throws(() => validateOpportunityApplicationPacket(value), /traction is not allowed/u);
});

test("rejects credential-shaped values anywhere in the packet", () => {
  const value = packet({ unresolvedFacts: [`token ghp_${"x".repeat(24)}`] });
  assert.throws(() => validateOpportunityApplicationPacket(value), /credential-shaped/u);
});

test("requires normalized packet identities and bounded single-line text", () => {
  assert.throws(() => validateOpportunityApplicationPacket(packet({ packetId: "Bad ID" })), /normalized stable identity/u);
  assert.throws(() => validateOpportunityApplicationPacket(packet({ provider: "bad\nprovider" })), /single-line/u);
});
