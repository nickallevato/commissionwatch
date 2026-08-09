import { Router } from 'express';
import sessionRouter from './session';
import channelsRouter from './channels';
import recordsRouter from './records';
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

// A guarded catch-all. Without it an unknown admin path 404s before the guard
// runs, which confirms to an unauthenticated caller which routes exist.
router.use((_req, res) => {
  res.status(404).json({ error: 'Not found', statusCode: 404 });
});

export default router;
