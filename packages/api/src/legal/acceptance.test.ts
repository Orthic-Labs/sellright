import { describe, expect, it } from "vitest";
import type { LegalManifest } from "@rightkit/legal";
import { legalReceiptForOrder } from "./acceptance.js";
import { legalManifestForApp } from "./manifests.js";

/**
 * Generic-engine fixture: a complete, assertLegalManifest-valid manifest built
 * inline (no committed suite JSON lives in SellRight — manifests arrive through
 * store.config.legalManifests). Six roles are required by assertLegalManifest;
 * checkout collects the five CHECKOUT_ROLES (third_party_notices is
 * notice-only, never presented for agreement).
 */
function fixtureManifest(appKey = "testapp"): LegalManifest {
  const doc = (role: string, treatment: string, material: boolean, over: Record<string, unknown> = {}) => ({
    id: `${appKey}-${role}`,
    role,
    title: `${appKey} ${role}`,
    version: "1.0",
    sha256: "a".repeat(64),
    path: `${role.toUpperCase()}.md`,
    publicUrl: `https://${appKey}.example.com/legal/${role}/`,
    treatment,
    material,
    ...over,
  });
  return {
    schema: 2,
    suite: "right-suite-desktop",
    appKey,
    productName: "TestApp",
    licensor: "Test Co",
    effectiveDate: "2026-08-01",
    acceptanceVersion: `${appKey}-2026-08-01-v1`,
    documents: [
      doc("license", "agree", true),
      doc("eula", "agree", true),
      doc("acceptable_use", "agree", true),
      doc("product_schedule", "agree", true),
      doc("privacy_notice", "acknowledge", false),
      doc("third_party_notices", "notice", false),
    ],
  } as LegalManifest;
}

const manifest = fixtureManifest();
const config = { legalManifests: { testapp: manifest } };

// Built from the resolved manifest (not hand-copied), so this fixture can
// never drift from what the registry actually validates against.
const valid = {
  acceptanceVersion: manifest.acceptanceVersion,
  eligibilityBasis: "individual" as const,
  authorityConfirmed: true,
  agreementStatement: "I agree to the EULA, Ownership Notice, Acceptable Use Policy, and Product Schedule.",
  documents: manifest.documents
    .filter((document) => document.role !== "third_party_notices")
    .map((document) => ({
      role: document.role,
      id: document.id,
      version: document.version,
      sha256: document.sha256,
      url: document.publicUrl,
      treatment: document.treatment,
    })),
};

describe("configured legal manifest registry", () => {
  it("resolves a manifest by appKey from store.config.legalManifests and validates it", () => {
    expect(legalManifestForApp(config, "testapp")).toBe(manifest);
    expect(legalManifestForApp(config, "unconfigured-app")).toBeNull();
    expect(legalManifestForApp(null, "testapp")).toBeNull();
    expect(legalManifestForApp({}, "testapp")).toBeNull();
    expect(legalManifestForApp({ legalManifests: "nonsense" }, "testapp")).toBeNull();
  });

  it("fails closed on a malformed manifest entry (store misconfiguration)", () => {
    const bad = { legalManifests: { testapp: { ...manifest, appKey: "different-app" } } };
    expect(() => legalManifestForApp(bad, "testapp")).toThrow(/appKey/i);
    const malformed = { legalManifests: { testapp: { appKey: "testapp" } } };
    expect(() => legalManifestForApp(malformed, "testapp")).toThrow();
  });
});

describe("checkout legal acceptance receipt", () => {
  it("verifies the happy path against the configured manifest and requires all fields", () => {
    const receipt = legalReceiptForOrder(manifest, valid, new Date("2026-08-01T12:00:00.000Z"));
    expect(receipt.accepted_at).toBe("2026-08-01T12:00:00.000Z");
    expect(receipt.app_key).toBe("testapp");
    expect(receipt.acceptance_version).toBe(manifest.acceptanceVersion);
    expect(receipt.documents).toHaveLength(5);
    expect(receipt.documents.map((d) => d.role).sort()).toEqual(
      ["acceptable_use", "eula", "license", "privacy_notice", "product_schedule"].sort(),
    );
    expect(() => legalReceiptForOrder(manifest, { ...valid, authorityConfirmed: false }, new Date())).toThrow(/authority/i);
    expect(() => legalReceiptForOrder(manifest, { ...valid, documents: valid.documents.slice(1) }, new Date())).toThrow(/license/i);
    expect(() => legalReceiptForOrder(manifest, null, new Date())).toThrow(/receipt is required/i);
  });

  it("rejects an acceptanceVersion that does not match the configured manifest", () => {
    expect(() => legalReceiptForOrder(manifest, { ...valid, acceptanceVersion: "testapp-2020-01-01-v0" }, new Date())).toThrow(
      /acceptanceVersion/i,
    );
  });

  it("rejects forged hashes, tampered ids/versions, unsupported eligibility, and mismatched document URLs", () => {
    expect(() =>
      legalReceiptForOrder(manifest, { ...valid, documents: [{ ...valid.documents[0]!, sha256: "b".repeat(64) }, ...valid.documents.slice(1)] }, new Date()),
    ).toThrow(/sha-?256/i);
    expect(() =>
      legalReceiptForOrder(manifest, { ...valid, documents: [{ ...valid.documents[0]!, id: "forged-id" }, ...valid.documents.slice(1)] }, new Date()),
    ).toThrow(/id/i);
    expect(() =>
      legalReceiptForOrder(manifest, { ...valid, documents: [{ ...valid.documents[0]!, version: "9.9" }, ...valid.documents.slice(1)] }, new Date()),
    ).toThrow(/version/i);
    expect(() => legalReceiptForOrder(manifest, { ...valid, eligibilityBasis: "organization_10_plus" as never }, new Date())).toThrow(/eligibility/i);
    const forgedHost = valid.documents.map((document) => ({
      ...document,
      url: document.url.replace("testapp.example.com", "testapp.example.com.attacker.example"),
    }));
    expect(() => legalReceiptForOrder(manifest, { ...valid, documents: forgedHost }, new Date())).toThrow(/URL/i);
  });
});
