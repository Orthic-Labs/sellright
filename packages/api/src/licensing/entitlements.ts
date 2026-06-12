export type FulfillmentType = 'physical' | 'digital_download' | 'license' | 'update_pass';

export interface LicenseGrantInput {
  orderLineId: string;
  quantity: number;
  fulfillmentType: FulfillmentType;
  appKey: string | null;
  licenseSeats: number | null;
  updatesDurationDays: number | null;
  licenseDurationDays: number | null;
  metadata: unknown;
}

export interface LicenseGrant {
  orderLineId: string;
  appKey: string;
  seats: number;
  expiresAt: Date | null;
  updatesUntil: Date | null;
  metadata: unknown;
}

function addDays(d: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(d.getTime() + days * 86_400_000);
}

export function buildLicenseGrants(lines: LicenseGrantInput[], now = new Date()): LicenseGrant[] {
  const grants: LicenseGrant[] = [];
  for (const line of lines) {
    if (!['digital_download', 'license', 'update_pass'].includes(line.fulfillmentType) || !line.appKey) continue;
    for (let i = 0; i < line.quantity; i++) {
      grants.push({
        orderLineId: line.orderLineId,
        appKey: line.appKey,
        seats: line.licenseSeats ?? 1,
        expiresAt: addDays(now, line.licenseDurationDays),
        updatesUntil: addDays(now, line.updatesDurationDays),
        metadata: line.metadata,
      });
    }
  }
  return grants;
}

export function canReceiveUpdate(license: { status: string; updatesUntil: Date | null }, now = new Date()): boolean {
  return license.status === 'active' && license.updatesUntil != null && license.updatesUntil.getTime() >= now.getTime();
}

export function canAccessDownload(license: { status: string; expiresAt: Date | null }, now = new Date()): boolean {
  return license.status === 'active' && (license.expiresAt == null || license.expiresAt.getTime() >= now.getTime());
}
