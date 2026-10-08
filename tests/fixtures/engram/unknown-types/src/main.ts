import vertex from './shader.glsl'
import { scene } from './scene.ts'

export function draw(): string {
  return scene(vertex)
}
