import type { GraphNode, MaterialNodeDef, ParamDef, PortDef } from "./types";
import { fbmNode } from "./nodes/texture/fbm";
import { domainWarpNode } from "./nodes/vector/domain-warp";
import { tileableNoiseNode } from "./nodes/texture/tileable-noise";
import { screenNoiseNode } from "./nodes/texture/screen-noise";
import { tileableWarpNode } from "./nodes/vector/tileable-warp";
import { voronoiNode } from "./nodes/texture/voronoi";
import { checkerNode } from "./nodes/texture/checker";
import { tileNode } from "./nodes/texture/tile";
import { scatterNode } from "./nodes/texture/scatter";
import { shapeNode } from "./nodes/texture/shape";
import { gradientNode } from "./nodes/texture/gradient";
import { waveNode } from "./nodes/texture/wave";
import { anisotropicStripesNode } from "./nodes/texture/anisotropic-stripes";
import { mathNode } from "./nodes/converter/math";
import { levelsNode } from "./nodes/converter/levels";
import { colorRampNode } from "./nodes/converter/color-ramp";
import { heightBlendNode } from "./nodes/converter/height-blend";
import { blendNode } from "./nodes/color/blend";
import { invertNode } from "./nodes/color/invert";
import { brightContrastNode } from "./nodes/color/bright-contrast";
import { hueSatValNode } from "./nodes/color/hue-sat-val";
import { rgbCurvesNode } from "./nodes/color/rgb-curves";
import { luminanceNode, splitChannelsNode, combineChannelsNode } from "./nodes/converter/adapters";
import { clampNode } from "./nodes/converter/clamp";
import { separateXyzNode, combineXyzNode } from "./nodes/converter/xyz";
import { constantFieldNode, constantColorNode } from "./nodes/input/constant";
import { texCoordNode } from "./nodes/input/tex-coordinate";
import { vectorMathNode } from "./nodes/vector/vector-math";
import { vectorRotateNode } from "./nodes/vector/vector-rotate";
import { normalFromHeightNode } from "./nodes/vector/normal-from-height";
import { normalMapNode } from "./nodes/vector/normal-map";
import { mappingNode } from "./nodes/vector/mapping";
import { shaderMaterialNode } from "./nodes/shader/shader-material";
import { principledBsdfNode } from "./nodes/shader/principled-bsdf";
import { emissionNode } from "./nodes/shader/emission";
import { mixShaderNode } from "./nodes/shader/mix-shader";
import { materialOutputNode } from "./nodes/output/material-output";
import { groupNode, groupInputNode, groupOutputNode } from "./nodes/group/group";

// A node's effective ports: instance-specific (group / group-input / group-output carry `ports`), then a
// mode-driven `declare(params)` interface, else the static MaterialNodeDef. The single lookup used by the
// compiler, controller, and editor adapter.
export function nodePorts(
  node: GraphNode,
  registry: NodeRegistry,
): { inputs: PortDef[]; outputs: PortDef[] } {
  if (node.ports) return node.ports;
  const def = registry.get(node.type);
  if (def.declare) return def.declare(node.params);
  return { inputs: def.inputs, outputs: def.outputs };
}

// A node's effective PARAMS: the context-sensitive `paramsFor(params)` subset (controls that take effect in the
// current mode), else the static def.params. The param-level parallel of nodePorts — used by the editor to
// filter which controls to render. See MaterialNodeDef.paramsFor.
export function nodeParamDefs(node: GraphNode, registry: NodeRegistry): ParamDef[] {
  const def = registry.get(node.type);
  return def.paramsFor ? def.paramsFor(node.params) : def.params;
}

// Maps node type -> definition. The single source of truth for ports, params, and the TSL builder.
export class NodeRegistry {
  private readonly defs = new Map<string, MaterialNodeDef>();

  register(def: MaterialNodeDef): this {
    if (this.defs.has(def.type)) throw new Error(`Duplicate node type: ${def.type}`);
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): MaterialNodeDef {
    const def = this.defs.get(type);
    if (!def) throw new Error(`Unknown node type: ${type}`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  all(): MaterialNodeDef[] {
    return [...this.defs.values()];
  }
}

// Only generic nodes register by default; wood-specific nodes stay out of the registry (and out of the
// palette) — bark is expressed as a preset document wiring these generics (material-graph-plan.md).
export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(fbmNode)
    .register(domainWarpNode)
    .register(tileableNoiseNode)
    .register(screenNoiseNode)
    .register(tileableWarpNode)
    .register(voronoiNode)
    .register(checkerNode)
    .register(tileNode)
    .register(scatterNode)
    .register(shapeNode)
    .register(gradientNode)
    .register(waveNode)
    .register(anisotropicStripesNode)
    .register(mathNode)
    .register(levelsNode)
    .register(colorRampNode)
    .register(heightBlendNode)
    .register(blendNode)
    .register(invertNode)
    .register(brightContrastNode)
    .register(hueSatValNode)
    .register(rgbCurvesNode)
    .register(luminanceNode)
    .register(splitChannelsNode)
    .register(combineChannelsNode)
    .register(clampNode)
    .register(separateXyzNode)
    .register(combineXyzNode)
    .register(constantFieldNode)
    .register(constantColorNode)
    .register(texCoordNode)
    .register(vectorMathNode)
    .register(vectorRotateNode)
    .register(normalFromHeightNode)
    .register(normalMapNode)
    .register(mappingNode)
    .register(shaderMaterialNode)
    .register(principledBsdfNode)
    .register(emissionNode)
    .register(mixShaderNode)
    .register(materialOutputNode)
    .register(groupNode)
    .register(groupInputNode)
    .register(groupOutputNode);
}

export const defaultRegistry = createDefaultRegistry();
