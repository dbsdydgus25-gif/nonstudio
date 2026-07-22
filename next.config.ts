import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // (2026-07-22) AI 영상 GIF 변환이 런타임에 죽던 문제:
  //   spawn /ROOT/node_modules/ffmpeg-static/ffmpeg ENOENT
  // ffmpeg-static은 __dirname 기준으로 바이너리 경로를 계산하는데, 번들러가 그 경로를
  // 재작성해버려서 존재하지 않는 /ROOT/... 를 가리키게 된다. 번들 대상에서 빼서
  // 네이티브 require로 해결하게 하고, 배포 시 바이너리 자체도 트레이싱에 포함시킨다.
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/detail-video': ['./node_modules/ffmpeg-static/**/*'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
