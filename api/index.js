// Vercel entry point: every /api/* request is rewritten here (see vercel.json)
// and handled by the same Express app the local launcher uses.
import { app, finalize } from "../server/app.js";

finalize();

export default app;
