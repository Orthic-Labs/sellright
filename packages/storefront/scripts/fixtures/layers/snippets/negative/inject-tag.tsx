// expect-shape: inject-tag
export const A = () => <script>{'alert(1)'}</script>;
export const B = () => <iframe src="/x" />;
export const C = () => <link rel="stylesheet" href="/x.css" />;
