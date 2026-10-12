// expect-imports: import-node
import fs from 'node:fs';
import { join } from 'path';

export const f = () => fs.readFileSync(join('a', 'b'));
