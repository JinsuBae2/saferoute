/**
 * 라우팅만 담당한다. 배포(D02)는 Nginx 정적 서빙이므로 서버 rewrite가 필요 없는
 * 해시 라우팅을 쓴다.
 *
 *   /#/            관제 화면 (조회 전용)
 *   /#/sign/<id>   별도 유도등 단말 (관제와 독립 실행)
 */
import { HashRouter, Navigate, Route, Routes, useParams } from "react-router-dom";

import { ControlDashboard } from "./control/ControlDashboard";
import { SignTerminal } from "./terminal/SignTerminal";

function SignRoute() {
  const { signId } = useParams();
  if (signId === undefined || signId.length === 0) return <Navigate to="/" replace />;
  // sign_id가 바뀌면 단말 인스턴스도 새로 시작한다.
  return <SignTerminal key={signId} signId={signId} />;
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<ControlDashboard />} />
        <Route path="/sign/:signId" element={<SignRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <footer className="source-notice">
        <a href={`https://github.com/JinsuBae2/saferoute/tree/${__SOURCE_COMMIT__}`} target="_blank" rel="noopener noreferrer">소스 코드</a>
        {" · "}
        <a href={`https://github.com/JinsuBae2/saferoute/blob/${__SOURCE_COMMIT__}/LICENSE`} target="_blank" rel="noopener noreferrer">라이선스 (AGPL-3.0)</a>
      </footer>
    </HashRouter>
  );
}
