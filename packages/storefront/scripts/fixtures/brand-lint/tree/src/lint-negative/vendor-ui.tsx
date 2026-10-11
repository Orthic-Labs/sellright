// expect: vendor-ui
export const label = 'Continue to Sezzle';
export const logo = '/sezzle-color.svg';
export const copy = <p>Pay in 4 with Sezzle</p>;
// the provider id itself is exempt, the label next to it is not
export const method = { provider: 'sezzle', label: 'Sezzle checkout' };
