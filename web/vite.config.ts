import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 백엔드(backend/app.py)에는 CORS 미들웨어가 없다. 개발 서버에서 8000을 직접 부르면
// 전부 차단되므로 /api를 프록시로 같은 오리진에 묶는다. 배포(D02)의 Nginx 구조와 같다.
const CONTROL_API = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("../contracts/types.generated.ts", import.meta.url)),
      "@samples": fileURLToPath(new URL("../contracts/samples.generated.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // contracts/는 web/ 바깥이라 명시적으로 허용한다.
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: CONTROL_API, changeOrigin: false },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
