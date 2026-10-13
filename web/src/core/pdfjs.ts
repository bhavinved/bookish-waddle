import * as pdfjs from 'pdfjs-dist';
// Vite resolves `?url` to the emitted worker asset URL, which is the supported way to ship the pdf.js worker.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/** Loads a PDF from a Blob. Always import this module dynamically so pdf.js stays out of the main bundle. */
export async function loadPdf(blob: Blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}
