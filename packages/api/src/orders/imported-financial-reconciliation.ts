import { importedFinancialReconciliationRequired } from '../import/source-compatibility.js';

export { importedFinancialReconciliationRequired };

export const IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED = 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED';

/** Kept independent of route/auth modules so every money owner uses one refusal. */
export class ImportedFinancialReconciliationError extends Error {
  readonly status = 409;
  readonly code = IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED;
  constructor() {
    super('Imported financial history requires reconciliation before changing money.');
    this.name = 'ImportedFinancialReconciliationError';
  }
}

/** Call only with freshly read order metadata under the caller's order lock. */
export function assertImportedFinancialReconciliationAllowed(metadata: unknown): void {
  if (importedFinancialReconciliationRequired(metadata)) throw new ImportedFinancialReconciliationError();
}
