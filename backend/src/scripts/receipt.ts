import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import db from "../config/database";
import { buildReceipt } from "../services/export/receipt";

/**
 * Write a dated record receipt to disk.
 *
 *   npm run receipt -- --out ./receipts
 *   npm run receipt -- --out ./receipts --dry-run
 *
 * It writes files and stops. Committing and pushing them is a deliberate
 * operator step, because the publishing credential is a deploy key in Parameter
 * Store and a service that could push is a service that must hold one. See
 * `services/export/receipt.ts`.
 */

interface Args {
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: "receipts", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    if (argv[i] === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out needs a directory");
      args.out = value;
      i += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await buildReceipt(db);

  if (args.dryRun) {
    console.log(`receipt ${receipt.date} — ${receipt.files.length} files`);
    for (const file of receipt.files) {
      console.log(`  ${file.sha256.slice(0, 12)}…  ${file.name}  (${file.contents.length} bytes)`);
    }
    return;
  }

  const dir = resolve(args.out, receipt.date);
  mkdirSync(dir, { recursive: true });
  for (const file of receipt.files) {
    writeFileSync(join(dir, file.name), file.contents, "utf8");
  }
  writeFileSync(join(dir, "MANIFEST.sha256"), receipt.manifest, "utf8");

  console.log(`Wrote ${receipt.files.length + 1} files to ${dir}`);
  console.log("Verify with:  sha256sum -c MANIFEST.sha256");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.destroy();
  });
