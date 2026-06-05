"""
Standalone Blender image-to-video test.

This script is intentionally isolated from the main app flow.
It renders a single image into a short vertical MP4 using a slow cinematic move.

Run from Blender in background mode:
  blender -b --python scripts/blender-image-to-video-test.py -- --image <input> --output <output>
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import bpy


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IMAGE = REPO_ROOT / "dashboard-test.png"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "blender-test-output" / "blender-image-to-video-test.mp4"


def parse_args() -> argparse.Namespace:
  argv = sys.argv
  if "--" in argv:
    argv = argv[argv.index("--") + 1:]
  else:
    argv = []

  parser = argparse.ArgumentParser(description="Render a single image to a short MP4 in Blender.")
  parser.add_argument("--image", default=str(DEFAULT_IMAGE), help="Input image path.")
  parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output MP4 path.")
  parser.add_argument("--duration", type=float, default=11.0, help="Video duration in seconds.")
  parser.add_argument("--fps", type=int, default=30, help="Frames per second.")
  parser.add_argument("--width", type=int, default=1080, help="Render width.")
  parser.add_argument("--height", type=int, default=1920, help="Render height.")
  return parser.parse_args(argv)


def clear_scene() -> None:
  bpy.ops.object.select_all(action="SELECT")
  bpy.ops.object.delete()

  for block in list(bpy.data.meshes):
    if block.users == 0:
      bpy.data.meshes.remove(block)

  for block in list(bpy.data.materials):
    if block.users == 0:
      bpy.data.materials.remove(block)

  for block in list(bpy.data.images):
    if block.users == 0:
      bpy.data.images.remove(block)


def set_render_engine(scene) -> str:
  for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
    try:
      scene.render.engine = engine
      return engine
    except Exception:
      continue
  return scene.render.engine


def setup_scene(scene, width: int, height: int, fps: int, frame_end: int, output_path: Path) -> None:
  scene.frame_start = 1
  scene.frame_end = frame_end
  scene.render.fps = fps
  scene.render.resolution_x = width
  scene.render.resolution_y = height
  scene.render.resolution_percentage = 100
  scene.render.film_transparent = False
  scene.render.filepath = str(output_path)
  scene.render.image_settings.file_format = "FFMPEG"
  scene.render.ffmpeg.format = "MPEG4"
  scene.render.ffmpeg.codec = "H264"
  scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
  scene.render.ffmpeg.ffmpeg_preset = "GOOD"

  world = bpy.data.worlds.new("World")
  world.use_nodes = True
  bg = world.node_tree.nodes.get("Background")
  if bg:
    bg.inputs[0].default_value = (0.03, 0.03, 0.03, 1.0)
    bg.inputs[1].default_value = 0.9
  scene.world = world


def create_camera(scene, frame_end: int) -> None:
  camera_data = bpy.data.cameras.new("Camera")
  camera = bpy.data.objects.new("Camera", camera_data)
  bpy.context.collection.objects.link(camera)
  camera.location = (0.0, 0.0, 6.4)
  camera.rotation_euler = (0.0, 0.0, 0.0)
  camera_data.lens = 50
  scene.camera = camera

  camera.location = (0.0, 0.0, 6.4)
  camera.keyframe_insert(data_path="location", frame=1)

  camera.location = (0.08, -0.06, 5.35)
  camera.keyframe_insert(data_path="location", frame=frame_end)


def create_light() -> None:
  light_data = bpy.data.lights.new("Soft Light", type="AREA")
  light = bpy.data.objects.new("Soft Light", light_data)
  bpy.context.collection.objects.link(light)
  light.location = (0.0, 0.0, 8.0)
  light_data.energy = 800
  light_data.shape = "RECTANGLE"
  light_data.size = 8.0
  light_data.size_y = 8.0


def create_image_plane(image_path: Path, width: int, height: int):
  image = bpy.data.images.load(str(image_path), check_existing=True)
  image_width = max(int(image.size[0] or width), 1)
  image_height = max(int(image.size[1] or height), 1)
  image_ratio = image_width / image_height
  frame_ratio = width / height

  bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0.0, 0.0, 0.0))
  plane = bpy.context.object
  plane.name = "ImagePlane"

  material = bpy.data.materials.new(name="ImageMaterial")
  material.use_nodes = True
  material.blend_method = "BLEND"
  material.shadow_method = "NONE"

  nodes = material.node_tree.nodes
  links = material.node_tree.links
  for node in list(nodes):
    nodes.remove(node)

  output = nodes.new("ShaderNodeOutputMaterial")
  shader = nodes.new("ShaderNodeBsdfPrincipled")
  texture = nodes.new("ShaderNodeTexImage")
  texture.image = image

  texture.interpolation = "Smart"
  shader.inputs["Roughness"].default_value = 1.0
  specular_socket = shader.inputs.get("Specular IOR Level") or shader.inputs.get("Specular")
  if specular_socket is not None:
    specular_socket.default_value = 0.0

  links.new(texture.outputs["Color"], shader.inputs["Base Color"])
  if "Alpha" in texture.outputs and "Alpha" in shader.inputs:
    links.new(texture.outputs["Alpha"], shader.inputs["Alpha"])
  links.new(shader.outputs["BSDF"], output.inputs["Surface"])

  plane.data.materials.append(material)

  base_scale = 3.2
  if image_ratio >= frame_ratio:
    plane.scale = (base_scale, base_scale * frame_ratio / image_ratio, 1.0)
  else:
    plane.scale = (base_scale * image_ratio / frame_ratio, base_scale, 1.0)

  return plane


def add_soft_overlay(plane):
  empty = bpy.data.objects.new("ZoomTarget", None)
  bpy.context.collection.objects.link(empty)
  empty.location = plane.location
  return empty


def main() -> int:
  args = parse_args()
  image_path = Path(args.image).expanduser().resolve()
  output_path = Path(args.output).expanduser().resolve()

  if not image_path.exists():
    print(f"Input image not found: {image_path}", file=sys.stderr)
    return 1

  output_path.parent.mkdir(parents=True, exist_ok=True)

  clear_scene()
  scene = bpy.context.scene
  engine = set_render_engine(scene)
  frame_end = max(1, int(args.duration * args.fps))
  setup_scene(scene, args.width, args.height, args.fps, frame_end, output_path)
  create_camera(scene, frame_end)
  create_light()
  plane = create_image_plane(image_path, args.width, args.height)
  add_soft_overlay(plane)

  bpy.context.view_layer.update()
  bpy.ops.render.render(animation=True)
  print(f"Rendered {output_path} using engine {engine}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
