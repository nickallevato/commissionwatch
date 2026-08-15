import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where a prerendered page lives on disk, and the two rules about that.
 *
 * **A page is written as `{path}/index.html`, not `{path}.html`.** That is not a
 * style choice, it is what `frontend/nginx.conf`'s existing
 * `try_files $uri $uri/ /index.html` can already find: `/meetings/{uuid}` has no
 * extension, so `$uri` never matches a `.html` file, while `$uri/` matches a
 * directory and the `index index.html` directive serves what is inside it. The
 * deployment note in the plan spells out what still has to be mounted for that
 * to be true in production; nothing in this file assumes it has been.
 *
 * **A path is validated, not trusted.** Every path this store is handed today
 * is built from a uuid or a 64-hex content address, and every one of them is
 * fine. The check exists because the day a slug derived from a scraped agenda
 * title reaches `pathFor`, a `..` inside it would write outside the output
 * directory — and the file that would be overwritten is on the machine serving
 * the public site. The refusal is a thrown error rather than a sanitised path,
 * because a page whose address we had to repair is a page nobody asked for.
 */

/** Site paths are ASCII by construction here. Anything else is a bug upstream. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PrerenderPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrerenderPathError";
  }
}

/**
 * `PRERENDER_OUTPUT_DIR`, defaulting inside the repository.
 *
 * The default is deliberately a directory this process is known to be able to
 * write, rather than the production mount point: an unset variable must produce
 * pages nobody serves, never a crash on a path that does not exist. Production
 * sets the variable to the mounted volume.
 */
export function prerenderOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PRERENDER_OUTPUT_DIR;
  if (configured !== undefined && configured.trim() !== "") return resolve(configured.trim());
  return resolve(process.cwd(), ".prerender");
}

export function assertSitePath(path: string): string {
  if (path === "/") return "/";
  if (!path.startsWith("/")) {
    throw new PrerenderPathError(`prerender path must be site-absolute: ${path}`);
  }
  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new PrerenderPathError(`prerender path segment is not writable as a name: ${path}`);
    }
  }
  return `/${segments.join("/")}`;
}

export interface PrerenderWriteResult {
  path: string;
  file: string;
  bytes: number;
}

export class PrerenderStore {
  readonly root: string;

  constructor(root: string = prerenderOutputDir()) {
    this.root = resolve(root);
  }

  /** The absolute file a site path is served from. */
  fileFor(path: string): string {
    const site = assertSitePath(path);
    const file = join(this.root, site === "/" ? "" : site.slice(1), "index.html");
    // Belt and braces over `assertSitePath`: if the segment rule is ever
    // loosened, this is the check that still holds the boundary.
    if (file !== this.root + sep + "index.html" && !file.startsWith(this.root + sep)) {
      throw new PrerenderPathError(`prerender path escapes the output directory: ${path}`);
    }
    return file;
  }

  /**
   * Writes a page. Temp file then rename, so a crawler mid-fetch never reads
   * half a document — `rename` within one filesystem is atomic, and the temp
   * file is created in the destination directory so it always is one.
   */
  async write(path: string, html: string): Promise<PrerenderWriteResult> {
    const file = this.fileFor(path);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, html, "utf8");
    await rename(temporary, file);
    return { path: assertSitePath(path), file, bytes: Buffer.byteLength(html, "utf8") };
  }

  /**
   * Removes a page and the directory it occupied.
   *
   * The whole directory, not just `index.html`: a left-behind empty directory
   * still satisfies nginx's `$uri/` and would then be served by the `index`
   * directive as a 403 or a directory listing rather than falling through to
   * the SPA. Withdrawal has to leave nothing.
   */
  async remove(path: string): Promise<boolean> {
    const file = this.fileFor(path);
    const existed = await this.exists(path);
    await rm(dirname(file), { recursive: true, force: true });
    return existed;
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.fileFor(path), "utf8");
    } catch {
      return undefined;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path)) !== undefined;
  }

  /** Every site path currently on disk. Used by the tests and by a rebuild. */
  async list(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (directory: string, sitePath: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), `${sitePath}/${entry.name}`);
        } else if (entry.name === "index.html") {
          found.push(sitePath === "" ? "/" : sitePath);
        }
      }
    };
    await walk(this.root, "");
    return found.sort();
  }
}
