/**
 * #406 fulfil dialog, shared by the orders list (quick view + bulk) and the order page.
 * Contract is fixed; the implementation lane owns this file.
 */
export interface FulfilDialogProps {
  /** Order code to fulfil. */
  code: string;
  open: boolean;
  onClose: () => void;
  /** Called after the API committed the shipment. */
  onDone?: (r: { fulfillmentId: string }) => void;
}

export function FulfilDialog(_props: FulfilDialogProps) {
  return null;
}
