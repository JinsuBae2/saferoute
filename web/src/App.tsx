/**
 * 라우팅만 담당한다. 배포(D02)는 Nginx 정적 서빙이므로 서버 rewrite가 필요 없는
 * 해시 라우팅을 쓴다.
 *
 *   /#/                개인 체험방으로 보낸다. 처음 온 사람은 '개인 체험 시작'을 본다
 *   /#/room            개인 체험방의 관제 (나만 쓰는 실행)
 *   /#/shared          공동 시연 관제 (모두가 같은 실행을 본다)
 *   /#/sign/<id>       공동 시연의 유도등 단말 (관제와 독립 실행)
 *   /#/room/sign/<id>  개인 체험방에 연결된 유도등 단말
 */
import { HashRouter, Navigate, Route, Routes, useParams } from "react-router-dom";

import { ControlDashboard } from "./control/ControlDashboard";
import { RoomGate } from "./room/RoomGate";
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
        <Route path="/" element={<Navigate to="/room" replace />} />
        <Route path="/shared" element={<ControlDashboard />} />
        <Route path="/sign/:signId" element={<SignRoute />} />
        <Route path="/room" element={<RoomGate><ControlDashboard /></RoomGate>} />
        <Route path="/room/sign/:signId" element={<RoomGate><SignRoute /></RoomGate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
