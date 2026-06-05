const required = [
	'VITE_VENDURE_PROD_URL',
	'VITE_VENDURE_LOCAL_URL',
	'VITE_VENDURE_DEV_URL',
	'VITE_IS_READONLY_INSTANCE',
	'VITE_SHOW_PAYMENT_STEP',
	'VITE_SHOW_REVIEWS',
	'VITE_SECURE_COOKIE',
	'VITE_GOOGLE_ADDRESS_VALIDATION_API_KEY',
] as const;

const optional = ['VITE_SEZZLE_MERCHANT_UUID'] as const;

type RequiredKey = (typeof required)[number];
type OptionalKey = (typeof optional)[number];

const env = import.meta.env as Record<string, unknown>;
const out: Record<string, string> = {};

for (const k of required) {
	const v = env[k];
	if (typeof v !== 'string') throw new Error(`Missing env ${k}`);
	out[k] = v;
}
for (const k of optional) {
	const v = env[k];
	if (typeof v === 'string') out[k] = v;
}

export const ENV_VARIABLES = out as Record<RequiredKey, string> & Partial<Record<OptionalKey, string>>;
