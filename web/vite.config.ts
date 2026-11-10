import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 백엔드(backend/app.py)에는 CORS 미들웨어가 없다. 개발 서버에서 8000을 직접 부르면
// 전부 차단되므로 /api를 프록시로 같은 오리진에 묶는다. 배포(D02)의 Nginx 구조와 같다.
const CONTROL_API = process.env.SAFEROUTE_API ?? "http://127.0.0.1:8000";
// 시나리오 실행기는 별도 프로세스(8001)다. 꺼져 있어도 관제는 동작해야 한다.
const SCENARIO_API = process.env.SAFEROUTE_SIM_API ?? "http://127.0.0.1:8001";
// CCTV 미리보기는 또 다른 프로세스다. 꺼져 있어도 관제는 동작해야 한다.
const PREVIEW_API = process.env.SAFEROUTE_PREVIEW_API ?? "http://127.0.0.1:8003";
const EXPLANATION_API = process.env.SAFEROUTE_EXPLANATION_API ?? "http://127.0.0.1:8002";

export default defineConfig(({ command }) => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  // Production source links must identify the code actually being built.
  if (command === "build" && execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()) {
    throw new Error("소스 제공 링크 일치를 위해 변경을 커밋한 뒤 빌드하세요.");
  }
  return {
    define: { __SOURCE_COMMIT__: JSON.stringify(sourceCommit) },
    plugins: [react()],
    resolve: {
      alias: {
        "@contracts": fileURLToPath(new URL("../contracts/types.generated.ts", import.meta.url)),
        "@samples": fileURLToPath(new URL("../contracts/samples.generated.ts", import.meta.url)),
        // 3D 형상 자료는 Building 계약이 아니라 정적 자산으로 받는다(05번 2.3절).
        "@space": fileURLToPath(new URL("../data/space", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // contracts/는 web/ 바깥이라 명시적으로 허용한다.
      fs: { allow: [".."] },
      proxy: {
        "/api/explanations/": { target: EXPLANATION_API, changeOrigin: false },
        // 더 구체적인 경로를 먼저 둔다. /api 규칙이 먼저 걸리면 제어기로 가 버린다.
        // /internal/preview 는 로컬 생산자 전용이라 화면에 연결하지 않는다.
        "/api/previews": { target: PREVIEW_API, changeOrigin: false },
        "/api/preview-frames": { target: PREVIEW_API, changeOrigin: false },
        "/api": { target: CONTROL_API, changeOrigin: false },
        "/sim": { target: SCENARIO_API, changeOrigin: false },
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
