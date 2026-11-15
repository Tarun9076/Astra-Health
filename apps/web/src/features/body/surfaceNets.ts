// Turns a signed distance shape into a triangle mesh (naive surface nets): one vertex per grid cell
// the surface passes through, one quad per grid edge it crosses. Normals come from the shape's
// gradient, so the skin shades smoothly. Pure TypeScript; runs in the body-model worker.
import type { Shape } from './anatomy'

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

// the 12 edges of a cell as pairs of corner numbers (corner bits: 1 = +x, 2 = +y, 4 = +z)
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]

export function meshShape(shape: Shape, step: number): MeshData {
  const pad = 2 * step
  const x0 = shape.lo[0] - pad, y0 = shape.lo[1] - pad, z0 = shape.lo[2] - pad
  const nx = Math.ceil((shape.hi[0] + pad - x0) / step) + 1
  const ny = Math.ceil((shape.hi[1] + pad - y0) / step) + 1
  const nz = Math.ceil((shape.hi[2] + pad - z0) / step) + 1
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)

  // sample a coarse grid first; fine samples far from the surface keep the coarse value (only the
  // sign matters there), so the shape is evaluated in detail only near its surface
  const C = 4
  const mx = Math.ceil((nx - 1) / C) + 1, my = Math.ceil((ny - 1) / C) + 1, mz = Math.ceil((nz - 1) / C) + 1
  const coarse = new Float32Array(mx * my * mz)
  for (let k = 0; k < mz; k++) {
    for (let j = 0; j < my; j++) {
      for (let i = 0; i < mx; i++) coarse[i + mx * (j + my * k)] = shape.d(x0 + i * C * step, y0 + j * C * step, z0 + k * C * step)
    }
  }
  const far = 1.8 * C * step
  const value = new Float32Array(nx * ny * nz)
  for (let k = 0; k < nz; k++) {
    const z = z0 + k * step
    const ck = Math.round(k / C)
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * step
      const cj = Math.round(j / C)
      for (let i = 0; i < nx; i++) {
        const near = coarse[Math.round(i / C) + mx * (cj + my * ck)]
        value[at(i, j, k)] = Math.abs(near) > far ? near : shape.d(x0 + i * step, y, z)
      }
    }
  }

  // one vertex per cell the surface crosses, at the mean of the edge crossings
  const cx = nx - 1, cy = ny - 1
  const cellVertex = new Int32Array(cx * cy * (nz - 1)).fill(-1)
  const pos: number[] = []
  const corner = new Float32Array(8)
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const v = value[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]
          corner[c] = v
          if (v < 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0, sy = 0, sz = 0, n = 0
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b]
          if ((va < 0) === (vb < 0)) continue
          const t = va / (va - vb)
          sx += (a & 1) + t * ((b & 1) - (a & 1))
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1))
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1))
          n++
        }
        cellVertex[i + cx * (j + cy * k)] = pos.length / 3
        pos.push(x0 + (i + sx / n) * step, y0 + (j + sy / n) * step, z0 + (k + sz / n) * step)
      }
    }
  }
  const cell = (i: number, j: number, k: number) => cellVertex[i + cx * (j + cy * k)]

  // a quad around every grid edge with a sign change, facing out of the shape
  const idx: number[] = []
  const quad = (a: number, b: number, c: number, d: number, axis: number, outward: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2]
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2]
    const nrm = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx][axis]
    if (nrm * outward >= 0) idx.push(a, b, c, a, c, d)
    else idx.push(a, c, b, a, d, c)
  }
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const v0 = value[at(i, j, k)]
        const inside = v0 < 0
        const out = inside ? 1 : -1
        if (inside !== (value[at(i + 1, j, k)] < 0)) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), 0, out)
        if (inside !== (value[at(i, j + 1, k)] < 0)) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), 1, out)
        if (inside !== (value[at(i, j, k + 1)] < 0)) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), 2, out)
      }
    }
  }

  // smooth normals from the distance field's gradient
  const positions = new Float32Array(pos)
  const normals = new Float32Array(pos.length)
  const e = step * 0.5
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2]
    const gx = shape.d(x + e, y, z) - shape.d(x - e, y, z)
    const gy = shape.d(x, y + e, z) - shape.d(x, y - e, z)
    const gz = shape.d(x, y, z + e) - shape.d(x, y, z - e)
    const l = Math.hypot(gx, gy, gz) || 1
    normals[v] = gx / l
    normals[v + 1] = gy / l
    normals[v + 2] = gz / l
  }
  return { positions, normals, indices: new Uint32Array(idx) }
}
