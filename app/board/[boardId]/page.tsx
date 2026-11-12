import { Room } from "@/components/room";
import { resolveSyncBackend } from "@/lib/sync/flag";
import { Canvas } from "./_components/canvas";
import { Loading } from "./_components/loading";


interface BoardIdPageProps {
    params: Promise<{
        boardId: string;
    }>;
    searchParams: Promise<{
        sync?: string | string[];
    }>;
}

const BoardIdPage = async ({
    params,
    searchParams,
} : BoardIdPageProps) => {
  const { boardId } = await params;
  const { sync } = await searchParams;

  return (
    <Room roomId={boardId} fallback={<Loading/>} backend={resolveSyncBackend(boardId, sync)}>
    <Canvas boardId={boardId} />
    </Room>
  );
};

export default BoardIdPage;
