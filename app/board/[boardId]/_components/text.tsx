import { TextLayer } from "@/types/canvas";
import { colorToCss } from "@/lib/utils";

import { LayerContent } from "./layer-content";

interface TextProps {
  id: string;
  layer: TextLayer;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  selectionColor?: string;
};

export const Text = ({
  layer,
  onPointerDown,
  id,
  selectionColor,
}: TextProps) => {
  const { x, y, width, height, fill, value } = layer;

  return (
    <foreignObject
      x={x}
      y={y}
      width={width}
      height={height}
      onPointerDown={(e) => onPointerDown(e, id)}
      style={{
        outline: selectionColor ? `1px solid ${selectionColor}` : "none"
      }}
    >
      <LayerContent
        id={id}
        value={value}
        width={width}
        height={height}
        scaleFactor={0.5}
        color={fill ? colorToCss(fill) : "#000"}
        className="drop-shadow-md"
      />
    </foreignObject>
  );
};
