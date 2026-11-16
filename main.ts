import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type CaseRecord = { id: string; markdown: string };

const inputPath = join(process.env.MAKEFUN_INPUT_DIR || '/input', 'cases.json');
const outputPath = join(process.env.MAKEFUN_OUTPUT_DIR || '/output', 'html.json');
const cases = JSON.parse(readFileSync(inputPath, 'utf8')) as CaseRecord[];
const html = cases.map(({ markdown }) => parse(markdown));

writeFileSync(outputPath, JSON.stringify(html));
