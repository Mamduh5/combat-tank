(() => {
  const g = globalThis.__combatTank;
  const scene = g.scene;
  const cam = scene.activeCamera;
  const root = g.tankVisual.root;
  const p = root.position;

  // The orbit rig repositions the camera every frame, so any position set here is undone before the
  // next render. Neutralise it by making its update a no-op, then place the camera by hand. Visual
  // review only; the running game is unaffected because this runs in a throwaway page.
  g.orbitCamera.update = () => {};

  cam.position.set(p.x + 15, p.y + 4.0, p.z + 1);
  cam.setTarget(root.position);

  return { movedTo: cam.position.asArray().map((n) => Number(n.toFixed(1))) };
})()