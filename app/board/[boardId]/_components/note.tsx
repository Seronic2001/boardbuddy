import { NoteLayer } from "@/types/canvas";
import { colorToCss, getContrastingTextColor } from "@/lib/utils";

import { LayerContent } from "./layer-content";

interface NoteProps {
  id: string;
  layer: NoteLayer;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  selectionColor?: string;
};

export const Note = ({
  layer,
  onPointerDown,
  id,
  selectionColor,
}: NoteProps) => {
  const { x, y, width, height, fill, value } = layer;

  return (
    <foreignObject
      x={x}
      y={y}
      width={width}
      height={height}
      onPointerDown={(e) => onPointerDown(e, id)}
      style={{
        outline: selectionColor ? `1px solid ${selectionColor}` : "none",
        backgroundColor: fill ? colorToCss(fill) : "#000",
      }}
      className="shadow-md drop-shadow-xl"
    >
      <LayerContent
        id={id}
        value={value}
        width={width}
        height={height}
        scaleFactor={0.15}
        color={fill ? getContrastingTextColor(fill) : "#000"}
      />
    </foreignObject>
  );
};
