import { startServer } from '../src/server/index.ts';

startServer().catch((err) => {
  console.error('[GitDock] Fatal startup error:', err);
  process.exit(1);
});
