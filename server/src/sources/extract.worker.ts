// Worker-thread half of text extraction (see extract.ts). The main thread
// posts one job at a time — { absPath, ext } — and this answers with the
// extracted text or the failure message, so CPU-bound parsing (unpdf/
// mammoth/JSZip/hwp) never blocks the server. Imported ONLY as a worker
// entry; on the main thread parentPort is null and this file does nothing.
import { isMainThread, parentPort } from 'node:worker_threads';
import { extractTextInProcess, type ExtractReply } from './extract.js';

interface ExtractJob {
  absPath: string;
  ext: string;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', async (job: ExtractJob) => {
    const reply: ExtractReply = await extractTextInProcess(job.absPath, job.ext).then(
      (text): ExtractReply => ({ ok: true, text }),
      (err): ExtractReply => ({ ok: false, error: (err as Error)?.message ?? String(err) }),
    );
    port.postMessage(reply);
  });
}
