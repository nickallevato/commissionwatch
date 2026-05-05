import * as path from 'path';
import type { ParsedDocument, ParseOptions } from './types';
import { parsePdf } from './pdf-parser';
import { parseHtml } from './html-parser';

export async function parseDocument(options: ParseOptions): Promise<ParsedDocument> {
  const type = options.type ?? detectType(options.input);

  let result: ParsedDocument;
  if (type === 'pdf') {
    result = await parsePdf(options.input);
  } else {
    result = await parseHtml(options.input);
  }

  if (options.sourceUrl) {
    result.sourceUrl = options.sourceUrl;
  }

  return result;
}

function detectType(input: string): 'pdf' | 'html' {
  const ext = path.extname(input).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  // Default to HTML for unknown extensions
  return 'html';
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
  const type = typeIdx !== -1 ? (args[typeIdx + 1] as 'pdf' | 'html') : undefined;

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
