/**
 * 라우팅만 담당한다. 배포(D02)는 Nginx 정적 서빙이므로 서버 rewrite가 필요 없는
 * 해시 라우팅을 쓴다. 단말 주소는 /#/sign/<sign_id>다.
 */
import { useEffect, useState } from "react";
import { HashRouter, Link, Navigate, Route, Routes, useParams } from "react-router-dom";

import type { Building, Session } from "@contracts";

import { fetchBuilding, fetchSession } from "./api/client";
import { SignTerminal } from "./terminal/SignTerminal";

function SignRoute() {
  const { signId } = useParams();
  if (signId === undefined || signId.length === 0) return <Navigate to="/" replace />;
  // sign_id가 바뀌면 단말 인스턴스도 새로 시작한다.
  return <SignTerminal key={signId} signId={signId} />;
}

function Home() {
  const [building, setBuilding] = useState<Building | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const [loadedBuilding, loadedSession] = await Promise.all([
          fetchBuilding(abort.signal),
          fetchSession(abort.signal),
        ]);
        setBuilding(loadedBuilding);
        setSession(loadedSession);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "제어기에 연결하지 못했습니다");
      }
    })();
    return () => abort.abort();
  }, []);

  return (
    <main className="home">
      <h1>saferoute 유도등 단말</h1>
      <p className="home__lead">
        단말은 관제 화면과 독립적으로 자기 sign_id의 명령만 조회합니다. 서로 다른 유도등 두 개를
        <strong> 각각 다른 창</strong>으로 띄워 확인하세요. 같은 sign_id를 두 개 띄우면 서버가
        <code>DUPLICATE_TERMINAL</code>로 표시하며 이 기록은 reset 전까지 남습니다.
      </p>

      {error !== null && <p className="home__error">{error}</p>}

      {session !== null && (
        <p className="home__session">
          실행 <code>{session.run_id}</code> · {session.building_id} v{session.building_version} · 접속 시점{" "}
          {session.controller_mode}
        </p>
      )}

      {building !== null && (
        <ul className="home__signs">
          {building.signs.map((sign) => (
            <li key={sign.sign_id}>
              <Link to={`/sign/${encodeURIComponent(sign.sign_id)}`}>
                <span className="home__sign-id">{sign.sign_id}</span>
                <span className="home__sign-meta">
                  지점 {sign.node_id} · 표시면 {sign.faces.map((face) => face.face_id).join(", ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/sign/:signId" element={<SignRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
