// The build's commerce flow (read once; Vite inlines the value). Kept apart from flow.ts, which vite.config.ts loads in Node.
import { commerceFlowFrom, type CommerceFlow } from './flow';

export const COMMERCE_FLOW: CommerceFlow = commerceFlowFrom(import.meta.env.VITE_SR_COMMERCE_FLOW as string | undefined);
