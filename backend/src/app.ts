import express from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health";
import jurisdictionsRouter from "./routes/jurisdictions";
import meetingsRouter from "./routes/meetings";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/jurisdictions", jurisdictionsRouter);
app.use("/api/meetings", meetingsRouter);

app.use(errorHandler);

export default app;
