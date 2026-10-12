// Fixture reviewed pure util (listed in layers.json imports.transitiveL1Allow): reaching it is allowed.
export const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '');
