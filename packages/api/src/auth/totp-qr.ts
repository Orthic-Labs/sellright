/** Authenticator QR (issue #333): the otpauth URI rendered as SVG on the server with a bundled encoder (uqr) — the
 *  secret never leaves the API for a third-party QR service. Error-correction M; a quiet zone of 4 modules. */
import { renderSVG } from 'uqr';

export function totpQrSvg(otpauthUri: string): string {
  return renderSVG(otpauthUri, { ecc: 'M', border: 4, whiteColor: '#ffffff', blackColor: '#000000' });
}
