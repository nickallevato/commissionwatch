import { Router } from 'express';
import sessionRouter from './session';
import channelsRouter from './channels';
import recordsRouter from './records';
import pressroomRouter from './pressroom';
import reviewRouter from './review';
import claimsRouter from './claims';
import placeLinksRouter from './place-links';
import rosterRouter from './roster';
import featuresRouter from './features';
import { requireOperator } from '../../middleware/requireOperator';

const router = Router();

// The session routes carry their own guard: POST is the sign-in and cannot
// require what it issues, while GET and DELETE call requireOperator themselves.
router.use('/session', sessionRouter);

// Everything mounted after this line requires a live operator session.
// B-d's record uploads land here too.
router.use(requireOperator);

router.use('/channels', channelsRouter);
router.use('/records', recordsRouter);
// P2's Pressroom console: sources, runs, meetings, corrections, publication.
router.use('/pressroom', pressroomRouter);
// B-a's review queue. The only route in this product that makes a generated
// claim about a named person public lives behind this line.
router.use('/review', reviewRouter);
// The claims review path. `minute_claims` is the other table whose rows name a
// living person, and this is the only thing that can make one of them public.
router.use('/claims', claimsRouter);
// The place-link review path. A link is what puts a decision on the map, so an
// unreviewed one is a coordinate we inferred and have not stood behind yet.
router.use('/place-links', placeLinksRouter);
// The per-body roster roll. `/api/metrics` publishes the same facts with every
// body name stripped out, because that endpoint is public and id-less; this one
// names the body and the unmatched officeholders, which is what makes it
// actionable and what makes it an operator surface.
router.use('/roster', rosterRouter);
// The feature switches. Turning one on is how a capability that shipped dark
// starts running, so it belongs behind this line for the same reason the review
// queue does — and it writes an actor and a reason for every change, because
// enabling the delivery pipeline is a larger act than approving one claim and
// until now it left no trace at all. Nothing reachable here gates a wall: the
// keys come from the compiled manifest, and `feature-registry-audit.test.ts`
// holds that key set to capabilities rather than checks.
router.use('/features', featuresRouter);

// A guarded catch-all. Without it an unknown admin path 404s before the guard
// runs, which confirms to an unauthenticated caller which routes exist.
router.use((_req, res) => {
  res.status(404).json({ error: 'Not found', statusCode: 404 });
});

export default router;
