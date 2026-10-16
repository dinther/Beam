/**
 * @file The 3D view as a PNG on the system clipboard.
 *
 * The drawing buffer is not preserved between frames, so the picture is taken
 * in the render loop itself: after the frame is drawn and before the move
 * gizmo is drawn over it. The navigation gizmo and the perf readout are not part of
 * the 3D canvas, so they are not in it either.
 */

/** The request waiting for the next drawn frame, or null. */
let waiting = null;

/**
 * Copies the next drawn frame of the 3D view to the clipboard.
 *
 * @public
 * @returns {Promise<void>} settles once the image is on the clipboard
 */
function copyView() {
  if (waiting) return waiting.promise;
  const request = {};
  request.promise = new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
  });
  waiting = request;
  return request.promise;
}

/**
 * Takes the waiting request's picture from the canvas. Called by the render
 * loop once the frame is drawn.
 *
 * @public
 * @param {HTMLCanvasElement} canvas the 3D view's canvas
 */
function frameDrawn(canvas) {
  if (!waiting) return;
  const request = waiting;
  waiting = null;
  // toBlob copies the canvas when it is called, which is while this frame is
  // still in it; the encoding and the clipboard write follow later.
  canvas.toBlob(async (blob) => {
    try {
      if (!blob) throw new Error('the view gave no image');
      // eslint-disable-next-line no-undef
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      request.resolve();
    } catch (err) {
      request.reject(err);
    }
  }, 'image/png');
}

export default { copyView, frameDrawn };
