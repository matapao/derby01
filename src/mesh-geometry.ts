import * as THREE from 'three';

// box helper: size, position and rotation baked into the geometry.
// With `tile` the texture repeats every `tile` metres instead of stretching over each face.
export function boxGeo(
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  tile = 0,
) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile) {
    const uv = g.getAttribute('uv'),
      faceSize: readonly (readonly [number, number])[] = [
        [d, h],
        [d, h],
        [w, d],
        [w, d],
        [w, h],
        [w, h],
      ]; // px nx py ny pz nz
    if (!uv) throw new Error('Box geometry has no UV attribute');
    for (let i = 0; i < uv.count; i++) {
      const face = faceSize[i >> 2];
      if (!face) throw new RangeError('Box geometry has more than six faces');
      const [su, sv] = face;
      uv.setXY(i, (uv.getX(i) * su) / tile, (uv.getY(i) * sv) / tile);
    }
  }
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1),
    ),
  );
  return g;
}
