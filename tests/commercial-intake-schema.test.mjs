import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = JSON.parse(
  await readFile(new URL("../schema/commercial_intake.schema.json", import.meta.url), "utf8"),
);

const definitions = schema.$defs;

function walk(value, visitor, path = "$") {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, visitor, `${path}.${key}`);
    }
  }
}

function resolveLocalRef(ref) {
  assert.match(ref, /^#\/\$defs\/[A-Za-z0-9_]+$/u);
  return definitions[ref.slice("#/$defs/".length)];
}

test("commercial intake uses a stable Draft 2020-12 identity", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(
    schema.$id,
    "https://fiducia.cloud/schemas/commercial_intake.schema.json",
  );
  assert.equal(schema.title, "FiduciaCommercialIntake");
  assert.match(schema.description, /non-binding.+signed order form/iu);
});

test("quote, pre-interest, and enterprise request and receipt contracts are present", () => {
  for (const name of [
    "QuoteRequest",
    "QuoteReceipt",
    "PreInterestRequest",
    "PreInterestReceipt",
    "EnterpriseApplicationRequest",
    "EnterpriseApplicationReceipt",
  ]) {
    assert.ok(definitions[name], `${name} missing from $defs`);
  }
});

test("every local reference resolves to a checked-in definition", () => {
  const unresolved = [];
  walk(schema, (value, path) => {
    if (value && typeof value === "object" && typeof value.$ref === "string") {
      try {
        assert.ok(resolveLocalRef(value.$ref), `${value.$ref} does not resolve`);
      } catch (error) {
        unresolved.push(`${path}: ${error.message}`);
      }
    }
  });
  assert.deepEqual(unresolved, []);
});

test("all customer-submitted request envelopes are closed objects", () => {
  for (const name of [
    "QuoteRequest",
    "PreInterestRequest",
    "EnterpriseApplicationRequest",
  ]) {
    const contract = definitions[name];
    assert.equal(contract.type, "object", name);
    assert.equal(contract.additionalProperties, false, name);
    assert.ok(Array.isArray(contract.required) && contract.required.length > 0, name);
    assert.ok(contract.properties && typeof contract.properties === "object", name);
  }
});

test("commercial contacts enforce bounded email and identity fields", () => {
  const contact = definitions.Contact;
  assert.equal(contact.additionalProperties, false);
  assert.deepEqual(contact.required, ["email", "full_name", "role"]);
  assert.equal(contact.properties.email.format, "email");
  assert.equal(contact.properties.email.maxLength, 254);
  assert.equal(contact.properties.full_name.minLength, 1);
  assert.equal(contact.properties.full_name.maxLength, 160);
  assert.equal(contact.properties.role.maxLength, 160);
});

test("technical requirement lists are nonempty, bounded, and duplicate-free", () => {
  const technical = definitions.TechnicalRequirements.properties;
  for (const name of [
    "capabilities",
    "deployment_models",
    "client_languages",
    "regions",
    "data_classes",
  ]) {
    const property = technical[name];
    assert.equal(property.type, "array", name);
    assert.equal(property.uniqueItems, true, name);
    assert.equal(property.minItems, 1, name);
    assert.ok(property.maxItems >= property.minItems, name);
  }
  assert.ok(
    technical.peak_operations_per_second.maximum >=
      technical.average_operations_per_second.maximum,
  );
});

test("regulated data selections explicitly require separate review", () => {
  const dataClasses = definitions.TechnicalRequirements.properties.data_classes.items;
  for (const value of ["regulated_health", "payment_card", "government_restricted"]) {
    assert.ok(dataClasses.enum.includes(value), value);
  }
  assert.match(dataClasses.description, /separate written approval/iu);
  assert.match(dataClasses.description, /unsupported/iu);
});

test("compliance framework selection cannot be read as a certification claim", () => {
  const frameworks =
    definitions.SecurityRequirements.properties.compliance_frameworks.items;
  for (const value of ["soc_2", "iso_27001", "hipaa", "pci_dss", "fedramp"]) {
    assert.ok(frameworks.enum.includes(value), value);
  }
  assert.match(frameworks.description, /does not assert/iu);
  assert.match(frameworks.description, /certification|eligibility/iu);
});

test("requested service levels remain non-binding until a signed order form", () => {
  const serviceLevels = definitions.ServiceLevelRequest.properties;
  assert.match(
    serviceLevels.requested_availability.description,
    /only a signed order form can create a contractual SLA/iu,
  );
  assert.equal(serviceLevels.custom_availability_percent.minimum, 90);
  assert.equal(serviceLevels.custom_availability_percent.maximum, 99.999);

  const supportPlan = definitions.SupportRequirements.properties.support_plan;
  assert.match(supportPlan.description, /not an accepted entitlement/iu);
});

test("enterprise submissions require affirmative authorization and safety acknowledgements", () => {
  const application = definitions.EnterpriseApplicationRequest;
  const acknowledgements = [
    "authorized_to_submit",
    "acknowledges_requested_terms_are_non_binding",
    "acknowledges_no_credentials_or_secrets",
    "privacy_notice_accepted",
  ];
  for (const name of acknowledgements) {
    assert.ok(application.required.includes(name), `${name} must be required`);
    assert.equal(application.properties[name].type, "boolean", name);
    assert.equal(application.properties[name].const, true, name);
  }
});

test("request contracts do not define credential-bearing input fields", () => {
  const prohibited = new Set([
    "api_key",
    "access_token",
    "password",
    "private_key",
    "client_secret",
    "connection_string",
    "database_url",
  ]);
  const violations = [];
  for (const name of [
    "QuoteRequest",
    "PreInterestRequest",
    "EnterpriseApplicationRequest",
  ]) {
    walk(definitions[name], (value, path) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
      }
      for (const key of Object.keys(value.properties ?? {})) {
        if (prohibited.has(key)) {
          violations.push(`${name}:${path}.properties.${key}`);
        }
      }
    });
  }
  assert.deepEqual(violations, []);
});

test("required and enum arrays contain no duplicate values", () => {
  const duplicates = [];
  walk(schema, (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    for (const key of ["required", "enum"]) {
      const entries = value[key];
      if (Array.isArray(entries) && new Set(entries.map(JSON.stringify)).size !== entries.length) {
        duplicates.push(`${path}.${key}`);
      }
    }
  });
  assert.deepEqual(duplicates, []);
});
