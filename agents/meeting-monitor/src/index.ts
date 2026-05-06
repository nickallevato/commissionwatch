import { scrape, ScrapeOptions } from './scraper/scraper';
import { closeDb } from './db';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'scrape') {
    console.error('Usage: npx ts-node src/index.ts scrape --target <target> [--limit N] [--dry-run]');
    process.exit(1);
  }

  const options = parseArgs(args.slice(1));

  try {
    const result = await scrape(options);
    console.log('\n--- Scrape Summary ---');
    console.log(`Discovered: ${result.discovered}`);
    console.log(`Inserted:   ${result.inserted}`);
    console.log(`Skipped:    ${result.skipped}`);
    if (result.errors.length > 0) {
      console.log(`Errors:     ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`  - ${err}`);
      }
    }
  } finally {
    await closeDb();
  }
}

function parseArgs(args: string[]): ScrapeOptions {
  let target = '';
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--target':
        target = args[++i] || '';
        break;
      case '--limit':
        limit = parseInt(args[++i], 10);
        if (isNaN(limit)) {
          console.error('--limit must be a number');
          process.exit(1);
        }
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  if (!target) {
    console.error('--target is required (supported: bozeman)');
    process.exit(1);
  }

  return { target, limit, dryRun };
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
