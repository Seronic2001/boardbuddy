"use client";

import { useState } from "react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { AuthLoading, Authenticated, ConvexReactClient} from "convex/react"
import { Loading } from "@/components/auth/loading";

interface ConvexClientProviderProps {
    children: React.ReactNode;
};

export const ConvexClientProvider = ({ children }: ConvexClientProviderProps) => {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

    // Allow static prerender / build without env vars (Vercel sets them at runtime).
    if (!convexUrl) {
        return (
            <ClerkProvider>
                {children}
            </ClerkProvider>
        );
    }

    const [convex] = useState(() => new ConvexReactClient(convexUrl));

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