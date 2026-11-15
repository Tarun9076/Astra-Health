// Builds the 3D body (skin + organ systems) off the main thread, so the page stays responsive
// while the model is meshed (about a second). Sends the arrays back without copying them.
import { ORGANS, SKIN } from './anatomy'
import { meshShape, type MeshData } from './surfaceNets'

export type BodyMeshes = Record<string, MeshData>

const meshes: BodyMeshes = { whole_body: meshShape(SKIN, 0.008) }
for (const [id, shape] of Object.entries(ORGANS)) meshes[id] = meshShape(shape, id === 'eyes' ? 0.002 : 0.004)

const transfer = Object.values(meshes).flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer])
self.postMessage(meshes, { transfer })
