import DOMPurify from "dompurify";
import { Kalam } from "next/font/google";
import ContentEditable, { ContentEditableEvent } from "react-contenteditable";

import { cn } from "@/lib/utils";
import { useMutation } from "@/liveblocks.config";

const font = Kalam({
  subsets: ["latin"],
  weight: ["400"],
});

const MAX_FONT_SIZE = 96;

// Layer values are HTML written by any collaborator, so only inert formatting
// tags may ever reach the DOM.
const sanitize = (html: string) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ["b", "i", "u", "br", "div", "span", "p"],
  ALLOWED_ATTR: [],
});

interface LayerContentProps {
  id: string;
  value?: string;
  width: number;
  height: number;
  scaleFactor: number;
  color: string;
  className?: string;
};

export const LayerContent = ({
  id,
  value,
  width,
  height,
  scaleFactor,
  color,
  className,
}: LayerContentProps) => {
  const updateValue = useMutation((
    { storage },
    newValue: string,
  ) => {
    const liveLayers = storage.get("layers");

    liveLayers.get(id)?.set("value", newValue);
  }, [id]);

  const handleContentChange = (e: ContentEditableEvent) => {
    const html = sanitize(e.target.value);

    // Browsers leave a lone <br> behind once all text is deleted.
    updateValue(html === "<br>" ? "" : html);
  };

  return (
    <ContentEditable
      html={sanitize(value ?? "")}
      onChange={handleContentChange}
      className={cn(
        "h-full w-full flex items-center justify-center text-center outline-none empty:before:content-['Text'] empty:before:opacity-50",
        font.className,
        className
      )}
      style={{
        fontSize: Math.min(height * scaleFactor, width * scaleFactor, MAX_FONT_SIZE),
        color,
      }}
    />
  );
};
