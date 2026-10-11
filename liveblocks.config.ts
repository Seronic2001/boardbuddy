import { LiveList, LiveMap, LiveObject, createClient } from "@liveblocks/client";
import { createRoomContext } from "@liveblocks/react";
import { Color, Layer } from "./types/canvas";

const client = createClient({
  authEndpoint: "/api/liveblocks-auth",
  throttle: 16,
});

type Presence = {
  cursor: { x: number, y: number } | null,
  selection: string[];
  pencilDraft: [x: number, y: number, pressure: number][] | null;
  penColor: Color | null;
};

type Storage = {
  layers: LiveMap<string, LiveObject<Layer>>;
  layerIds: LiveList<string>;
};

type UserMeta = {
  id?: string;
  info?: {
    name?: string;
    picture?: string;
  };
};

export const {
  suspense: {
    RoomProvider,
    useSelf,
    useOthers,
    useOthersMapped,
    useOthersConnectionIds,
    useOther,
    useStorage,
    useHistory,
    useCanUndo,
    useCanRedo,
    useMutation,
  }
} = createRoomContext<Presence, Storage, UserMeta>(client);
