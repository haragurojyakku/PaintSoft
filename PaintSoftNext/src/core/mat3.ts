import type { Point } from './Selection';

/**
 * 2D affine transforms as a 3x3 matrix in **column-major** order, which is the layout
 * `uniformMatrix3fv` uploads without transposing:
 *
 *   [ a, b, 0,  c, d, 0,  tx, ty, 1 ]   ==   | a c tx |
 *                                            | b d ty |
 *                                            | 0 0  1 |
 */
export type Mat3 = Float32Array;

export function identity(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function multiply(left: Mat3, right: Mat3): Mat3 {
  const out = new Float32Array(9);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[column * 3 + row] =
        left[row]! * right[column * 3]! +
        left[3 + row]! * right[column * 3 + 1]! +
        left[6 + row]! * right[column * 3 + 2]!;
    }
  }
  return out;
}

export function translation(x: number, y: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]);
}

export function scaling(x: number, y: number): Mat3 {
  return new Float32Array([x, 0, 0, 0, y, 0, 0, 0, 1]);
}

export function rotation(radians: number): Mat3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Float32Array([cos, sin, 0, -sin, cos, 0, 0, 0, 1]);
}

export function apply(matrix: Mat3, point: Point): Point {
  return {
    x: matrix[0]! * point.x + matrix[3]! * point.y + matrix[6]!,
    y: matrix[1]! * point.x + matrix[4]! * point.y + matrix[7]!,
  };
}

export function invert(matrix: Mat3): Mat3 | null {
  const [a, b, , c, d, , tx, ty] = matrix as unknown as number[];
  const determinant = a! * d! - b! * c!;
  if (determinant === 0) return null;

  const inverseDeterminant = 1 / determinant;
  const ia = d! * inverseDeterminant;
  const ib = -b! * inverseDeterminant;
  const ic = -c! * inverseDeterminant;
  const id = a! * inverseDeterminant;

  return new Float32Array([
    ia,
    ib,
    0,
    ic,
    id,
    0,
    -(ia * tx! + ic * ty!),
    -(ib * tx! + id * ty!),
    1,
  ]);
}

/**
 * Builds the transform for a handle-driven edit: scale then rotate about `pivot`, then
 * translate. Composing in that order is what makes the pivot stay put while the shape
 * grows and turns around it, rather than drifting as each operation is applied.
 */
export function composeAround(
  pivot: Point,
  translate: Point,
  scale: Point,
  radians: number,
): Mat3 {
  return multiply(
    translation(pivot.x + translate.x, pivot.y + translate.y),
    multiply(rotation(radians), multiply(scaling(scale.x, scale.y), translation(-pivot.x, -pivot.y))),
  );
}
