/**
 * Prerendering — a complete HTML document per published object, written at
 * publish time and served as a file.
 *
 * Not SSR. The site's content changes when an operator publishes something,
 * which is a handful of events a day; rendering every page on every request, with
 * its database queries, to serve content that changed hours ago is work in the
 * wrong place. `consumer.ts` has the reasoning and the two places the spec was
 * wrong about the mechanism.
 */

export { escapeHtml, jsonLdScript, clip, type JsonObject, type JsonValue } from "./escape";
export {
  absoluteUrl,
  renderDocument,
  type Block,
  type PageDocument,
} from "./document";
export {
  PrerenderStore,
  PrerenderPathError,
  assertSitePath,
  prerenderOutputDir,
  type PrerenderWriteResult,
} from "./store";
export {
  FLAG_LABEL,
  SCHEMA_CONTEXT,
  buildDataPage,
  buildFindingPage,
  buildMeetingPage,
  buildOfficialPage,
  buildSourcePage,
  flagLabel,
  formatRecordDate,
  meetingIdForClaim,
  meetingSources,
} from "./pages";
export {
  PrerenderConsumer,
  PrerenderConfigError,
  DEFAULT_PRERENDER_BATCH_SIZE,
  DEFAULT_PRERENDER_INTERVAL_MS,
  prerenderBaseUrl,
  prerenderEnabled,
  targetPath,
  type PrerenderConsumerOptions,
  type PrerenderCursor,
  type PrerenderLogger,
  type PrerenderTarget,
  type PrerenderTargetKind,
  type PrerenderTickResult,
} from "./consumer";
