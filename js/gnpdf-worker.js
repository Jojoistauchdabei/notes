/* PDF-Render-Worker für GoodNotes-Hintergründe.
   Läuft abseits vom Main-Thread: hängt sich pdf.js auf (defektes PDF,
   Sandbox ohne Canvas), terminiert die App den Worker per Timeout –
   der Main-Thread blockiert nie. */
self.onmessage = async (e) => {
  const { libUrl, workerUrl, pdf, pageNo, targetW } = e.data || {};
  const fail = (msg) => self.postMessage({ ok: false, error: String(msg) });
  try {
    if (typeof OffscreenCanvas === 'undefined') return fail('no-offscreen-canvas');
    const pdfjs = await import(libUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: pdf, isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(Math.max(1, Math.min(pageNo || 1, doc.numPages)));
      const v1 = page.getViewport({ scale: 1 });
      if (!v1.width || !v1.height) return fail('leere seite');
      const vp = page.getViewport({ scale: targetW / v1.width });
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return fail('kein 2d-kontext im worker');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
      }
      self.postMessage({ ok: true, url: 'data:image/jpeg;base64,' + btoa(bin) });
    } finally {
      try { await doc.destroy(); } catch { /* ignore */ }
    }
  } catch (err) {
    fail((err && err.message) || err);
  }
};
