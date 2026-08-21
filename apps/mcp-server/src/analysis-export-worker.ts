import { materializeAnalysisExportArtifact } from './storage';
import type { AnalysisTrack } from './track';

if (!process.send) throw new Error('Analysis export worker requires an IPC parent.');

process.once('message', async (message: { type?: string; projectPath?: string; track?: AnalysisTrack }) => {
  if (message?.type !== 'export' || !message.projectPath) return;
  try {
    const artifact = await materializeAnalysisExportArtifact(message.projectPath, message.track ? { track: message.track } : undefined);
    process.send?.({ type: 'result', artifact }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
