/**
 * Micro-probe: establish empirically exactly what Chrome permits on `AudioBufferSourceNode`.
 *
 * The pool's recycle does `onended = null; stop(); buffer = null;` and the next claim assigns a buffer. Every
 * one of those steps follows the spec, yet assigning a second non-null buffer still throws in the running
 * game. This isolates the primitive from the game so the assumption can be checked rather than argued.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = globalThis.__combatTank;
  document.querySelector('canvas')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  g.audio.unlock();
  await sleep(2000);
  const ctx = g.audio.context;
  if (!ctx) return { error: 'no context' };

  const results = [];
  const attempt = (label, fn) => {
    try {
      fn();
      results.push({ label, ok: true });
    } catch (e) {
      results.push({ label, ok: false, message: String(e && e.message) });
    }
  };

  // A buffer with real content, so playback actually ends and `onended` can fire.
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = 0.2;

  // 1. First assignment, on a fresh node.
  const a = ctx.createBufferSource();
  attempt('fresh: assign buffer once', () => { a.buffer = buffer; });

  // 2. Assign a second non-null buffer WITHOUT clearing — the documented failure.
  attempt('no clear: assign again', () => { a.buffer = buffer; });

  // 3. Clear to null, then reassign.
  const b = ctx.createBufferSource();
  attempt('b: assign once', () => { b.buffer = buffer; });
  attempt('b: set buffer = null', () => { b.buffer = null; });
  attempt('b: reassign after null', () => { b.buffer = buffer; });

  // 4. The full recycle sequence, then reassign — exactly what the pool does.
  const c = ctx.createBufferSource();
  attempt('c: assign', () => { c.buffer = buffer; });
  attempt('c: start', () => { c.start(); });
  attempt('c: stop', () => { c.stop(); });
  attempt('c: buffer = null', () => { c.buffer = null; });
  attempt('c: reassign after stop+null', () => { c.buffer = buffer; });

  // 5. Does `onended` fire, and what is `buffer` at that moment?
  const d = ctx.createBufferSource();
  d.buffer = buffer;
  let endedSawBuffer = 'never-fired';
  d.onended = () => { endedSawBuffer = d.buffer === null ? 'null' : 'still-set'; };
  d.start();
  await sleep(600);

  // 6. A node that has *ended*: is its buffer writable again without nulling first?
  const e = ctx.createBufferSource();
  e.buffer = buffer;
  e.start();
  await sleep(500);
  attempt('ended node: assign again without clearing', () => { e.buffer = buffer; });

  // 7. Double start, which the spec also forbids.
  const f = ctx.createBufferSource();
  f.buffer = buffer;
  f.start();
  attempt('double start', () => { f.start(); });

  return { contextState: ctx.state, results, endedSawBuffer };
})()