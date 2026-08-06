import express from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health";
import versionRouter from "./routes/version";
import jurisdictionsRouter from "./routes/jurisdictions";
import meetingsRouter from "./routes/meetings";
import membersRouter from "./routes/members";
import votesRouter from "./routes/votes";
import anomaliesRouter from "./routes/anomalies";
import subscriptionsRouter from "./routes/subscriptions";
import notificationsRouter from "./routes/notifications";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/version", versionRouter);
app.use("/api/jurisdictions", jurisdictionsRouter);
app.use("/api/meetings", meetingsRouter);
app.use("/api/members", membersRouter);
app.use("/api/votes", votesRouter);
app.use("/api/anomalies", anomaliesRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/notifications", notificationsRouter);

app.use(errorHandler);

export default app;
