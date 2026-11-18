/** @type {import('next').NextConfig} */
const nextConfig = {
    // Workspace packages ship TypeScript source.
    transpilePackages: ["@boardbuddy/sync-core", "@boardbuddy/sync-client"],
    images:{
        remotePatterns: [
            {
                protocol : 'https',
                hostname: 'img.clerk.com',
            }
        ]
    }
};

export default nextConfig;
