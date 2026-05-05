import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDocument, ParseOptions } from './types';
import { parsePdf } from './pdf-parser';
import { parseHtml } from './html-parser';

const VALID_TYPES = ['pdf', 'html'] as const;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function parseDocument(options: ParseOptions): Promise<ParsedDocument> {
  const type = options.type ?? detectType(options.input);
  const resolvedPath = validateInputPath(options.input);

  let result: ParsedDocument;
  if (type === 'pdf') {
    result = await parsePdf(resolvedPath);
  } else {
    result = await parseHtml(resolvedPath);
  }

  if (options.sourceUrl) {
    result.sourceUrl = options.sourceUrl;
  }

  return result;
}

export function validateInputPath(input: string): string {
  const resolved = path.resolve(input);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum: ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`);
  }

  if (stat.size === 0) {
    throw new Error(`File is empty: ${resolved}`);
  }

  return resolved;
}

function detectType(input: string): 'pdf' | 'html' {
  const ext = path.extname(input).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'html';
}

function validateType(value: string): 'pdf' | 'html' {
  if (!VALID_TYPES.includes(value as typeof VALID_TYPES[number])) {
    throw new Error(`Invalid --type "${value}". Allowed: ${VALID_TYPES.join(', ')}`);
  }
  return value as 'pdf' | 'html';
}

export { ParsedDocument, ParseOptions } from './types';

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');
  const typeIdx = args.indexOf('--type');

  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error('Usage: npx tsx src/parser/parser.ts --input <path> [--type <pdf|html>]');
    process.exit(1);
  }

  const input = args[inputIdx + 1];
  let type: 'pdf' | 'html' | undefined;
  if (typeIdx !== -1) {
    const typeArg = args[typeIdx + 1];
    if (!typeArg) {
      console.error('--type requires a value (pdf or html)');
      process.exit(1);
    }
    type = validateType(typeArg);
  }

  parseDocument({ input, type })
    .then(result => {
      const output = {
        meetingDate: result.meetingDate,
        meetingTime: result.meetingTime,
        attendees: result.attendees,
        agendaItems: result.agendaItems,
        motions: result.motions,
        quotes: result.quotes,
        sourceType: result.sourceType,
      };
      console.log(JSON.stringify(output, null, 2));
    })
    .catch(err => {
      console.error('Parse failed:', err.message);
      process.exit(1);
    });
}
