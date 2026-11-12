"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { AuthLoading, Authenticated, ConvexProvider, ConvexReactClient} from "convex/react"
import { usePathname } from "next/navigation";
import { Loading } from "@/components/auth/loading";

interface ConvexClientProviderProps {
    children: React.ReactNode;
};

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

export const ConvexClientProvider = ({ children }: ConvexClientProviderProps) => {
    const pathname = usePathname();

    // Allow static prerender / build without env vars (Vercel sets them at runtime).
    if (!convex) {
        return (
            <ClerkProvider>
                {children}
            </ClerkProvider>
        );
    }

    // Test-only pages (lib/e2e.ts) have no signed-in user. They get a Convex client so
    // shared components can mount, but nothing waits for sign-in. The pages themselves
    // 404 unless test mode is enabled.
    if (pathname?.startsWith("/e2e/")) {
        return (
            <ClerkProvider>
                <ConvexProvider client={convex}>{children}</ConvexProvider>
            </ClerkProvider>
        );
    }

    return (
        <ClerkProvider>
            <ConvexProviderWithClerk useAuth={useAuth} client={convex}>
                <Authenticated>{children}</Authenticated>
                <AuthLoading>
                    <Loading />
                </AuthLoading>
            </ConvexProviderWithClerk>
        </ClerkProvider>
    );
}
