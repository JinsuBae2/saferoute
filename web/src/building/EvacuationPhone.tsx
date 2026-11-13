import { useEffect, useMemo, useState } from "react";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import type { BuildingGeometry } from "./geometry";
import { nearbyQr, phoneGuidance } from "./phoneGuide";
import type { FollowPose } from "./phoneGuide";
import { qrMounts } from "./signMount";
import "./phone.css";

type Props = { building: Building; display: BuildingDisplay | null; geometry: BuildingGeometry; state: StateSnapshot; pose: FollowPose | null; stale: boolean;
  /** 시연 인물이 스스로 휴대폰을 꺼내 가까운 QR을 비춘다. 평소에는 사용자가 꺼내고 누른다. */
  acting?: boolean };

/** QR을 비춘 채로 있어야 하는 시간(ms). 지나가며 잠깐 비추면 된다. 그 사이 대상이 시야에서 벗어나면 취소한다. */
const QR_HOLD_MS = 350;

export function PhoneGuide({ building, display, geometry, state, pose, stale, acting = false }: Props) {
  // 휴대폰은 처음부터 펼쳐 두지 않는다. 필요할 때 꺼낸다.
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const walls = geometry.floors.find(f => f.floor_id === building.nodes.find(node => node.node_id === pose?.routeNodeId)?.floor_id)?.walls ?? [];
  // 연결이 늦으면 위치가 오래된 것이라 QR을 잡지 않는다. 이 화면은 실행·사람마다 새로 만들어져 다른 실행의 확인이 남지 않는다.
  const mounts = useMemo(() => qrMounts(building, geometry.floors, geometry.stairs), [building, geometry]);
  const qr = pose === null || stale ? null : nearbyQr(building, pose, mounts, walls);
  useEffect(() => { if (acting) setOpen(true); }, [acting]);
  useEffect(() => {
    if (acting && open && scan === null && qr !== undefined && qr !== null && qr.sign_id !== confirmed) setScan(qr.sign_id);
  }, [acting, open, scan, qr, confirmed]);
  useEffect(() => {
    if (scan === null) return;
    if (qr?.sign_id !== scan) { setScan(null); return; }
    const timer = setTimeout(() => { setConfirmed(scan); setScan(null); }, QR_HOLD_MS);
    return () => clearTimeout(timer);
  }, [scan, qr?.sign_id]);
  const guide = pose === null ? null : phoneGuidance(building, display, state, pose, stale);
  const floorId = pose === null ? null : building.nodes.find(node => node.node_id === pose.routeNodeId)?.floor_id;
  const floorLabel = display?.floor_labels[floorId ?? ""] ?? building.floors.find(f => f.floor_id === floorId)?.label ?? "위치 확인 중";
  const floor = geometry.floors.find(f => f.floor_id === floorId);
  const points = floor?.slab ?? [];
  const minX = Math.min(...points.map(p => p.x)) - 2;
  const minZ = Math.min(...points.map(p => p.z)) - 2;
  const width = Math.max(...points.map(p => p.x)) - minX + 2;
  const height = Math.max(...points.map(p => p.z)) - minZ + 2;
  const path = guide?.kind === "ROUTE" ? guide.path.map(id => building.nodes.find(n => n.node_id === id)!) : [];
  const currentPath = path.flatMap((node, i) => i > 0 && (i > 1 || pose?.routeNodeId !== pose?.nodeId) && node.floor_id === floorId && path[i - 1].floor_id === floorId ? [{ from: path[i - 1].position, to: node.position }] : []);
  const next = pose?.routeNodeId !== pose?.nodeId ? path[0] : path[1] ?? path[0];
  // 화재 전에는 방향을 지시하지 않는다. 평소에 "지금 우회전"이 뜨면 이미 대피 중인 것처럼 읽힌다.
  const idle = !stale && guide?.kind === "ROUTE" && pose?.evacuating !== true;
  const status = stale ? "연결 확인 중" : guide?.kind === "BLOCKED" ? "안내 중단" : pose?.evacuating ? "대피 중" : "평상시 · 출발 대기";
  return <div className={`phone-overlay${open ? " phone-overlay--open" : ""}`}>
    <div className={`phone-handset${pose?.moving && !stale ? " phone-handset--walking" : ""}`} aria-hidden={!open} inert={!open}>
      <svg className="phone-hand" viewBox="0 0 360 580" aria-hidden="true">
        <defs>
          <linearGradient id="phone-skin" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#a96e50"/><stop offset=".5" stopColor="#e0ad86"/><stop offset="1" stopColor="#b77b58"/></linearGradient>
          <linearGradient id="phone-sleeve"><stop stopColor="#253e5b"/><stop offset=".65" stopColor="#466382"/><stop offset="1" stopColor="#1d3149"/></linearGradient>
        </defs>
        <path d="M208 580 202 462C166 437 152 408 153 359L166 242Q170 224 182 236L197 294 246 264Q266 250 280 267L317 325Q326 348 308 403L285 460 334 580Z" fill="url(#phone-skin)" stroke="#9d664b" strokeWidth="2"/>
        <path d="M191 480Q234 491 289 461L347 580H196Z" fill="url(#phone-sleeve)"/>
        <path d="M195 489Q244 504 296 474" fill="none" stroke="#617b95" strokeWidth="7"/>
        <path d="M281 281Q302 279 308 297L318 326Q318 342 306 341L287 316Z" fill="url(#phone-skin)" stroke="#a97050" strokeWidth="2"/>
      </svg>
      <section className="phone-device" aria-label="휴대폰 대피 안내">
        <div className="phone-speaker" aria-hidden="true"/>
        <div className="phone-screen">
          <header className="phone-header"><span>SafeRoute</span><span className="phone-signal" aria-hidden="true">▂▄▆</span></header>
          <div className={`phone-status${stale || guide?.kind === "BLOCKED" ? " phone-status--alert" : ""}`}><span/>{status}</div>
          {scan !== null ? <div className="phone-scanner" role="status">
            <p>QR 위치 확인 중</p>
            <div className="phone-scan-frame"><img src={`/qr/${encodeURIComponent(scan)}.png`} alt="시연용 위치 QR"/><i/></div>
            <small>모의 인식 · 실제 카메라로 읽지 않습니다</small>
          </div> : <>
            <div className={`phone-direction${guide?.kind !== "ROUTE" ? " phone-direction--paused" : ""}`}>
              <span className="phone-arrow" aria-hidden="true">{idle ? "✓" : guide?.kind === "ROUTE" ? guide.icon : "!"}</span>
              <div><strong>{idle ? "평상시" : guide?.instruction ?? "현재 위치 확인 중"}</strong><p>{idle ? "화재가 나면 여기에 대피 방향이 나옵니다" : guide?.detail ?? "선택한 사람의 위치를 연결합니다"}</p></div>
            </div>
            <div className="phone-floor-info" role="status">
              <strong>{guide?.kind === "ROUTE" && guide.floorTransition !== null ? guide.floorTransition : `${stale ? "마지막 확인" : "현재"} ${floorLabel}`}</strong>
              <span>{guide?.kind === "ROUTE" && guide.floorTransition !== null ? "계단 이동 중" : "내 위치"}</span>
            </div>
            <div className="phone-map-title"><strong>{floorLabel} 지도</strong><span>{guide?.kind === "ROUTE" ? guide.mapHint : "현재 위치만 표시"}</span></div>
            {floor && pose && <svg key={floor.floor_id} className="phone-map" viewBox={`${minX} ${minZ} ${width} ${height}`} role="img" aria-label={`${floorLabel} 대피 미니맵`}>
              <polygon points={floor.slab.map(p => `${p.x},${p.z}`).join(" ")} fill="#e5e8e8" stroke="#a6afb1" strokeWidth=".4"/>
              {floor.walls.map(([x0,z0,x1,z1],i) => <rect key={i} x={x0} y={z0} width={x1-x0} height={z1-z0} fill="#899599"/>)}
              {floor.slab_holes.map((hole,i) => <polygon key={i} points={hole.polygon.map(p=>`${p.x},${p.z}`).join(" ")} fill="#f7faf9"/>)}
              {currentPath.map((segment,i) => <line key={i} x1={segment.from.x} y1={segment.from.z} x2={segment.to.x} y2={segment.to.z} stroke="#008465" strokeWidth="1.05" strokeLinecap="round"/>)}
              {guide?.kind === "ROUTE" && next?.floor_id === floorId && <line x1={pose.x} y1={pose.z} x2={next.position.x} y2={next.position.z} stroke="#008465" strokeWidth="1.05"/>}
              {building.exits.filter(exit => building.nodes.find(n=>n.node_id===exit.node_id)?.floor_id===floorId).map(exit => { const n=building.nodes.find(n=>n.node_id===exit.node_id)!; return <rect key={exit.exit_id} x={n.position.x-1} y={n.position.z-1} width="2" height="2" fill="#008465" stroke="white" strokeWidth=".4"/>; })}
              <circle cx={pose.x} cy={pose.z} r="2" fill="#1f5fd0" opacity=".15"/>
              <circle cx={pose.x} cy={pose.z} r=".9" fill="#1f5fd0" stroke="white" strokeWidth=".5"/>
              <path d="M0,-2.5 -1,-.6 1,-.6Z" transform={`translate(${pose.x} ${pose.z}) rotate(${180-pose.yaw*180/Math.PI})`} fill="#1f5fd0"/>
            </svg>}
            <div className="phone-destination"><span>도착 출구</span><strong>{guide?.kind === "ROUTE" ? guide.exitLabel : "안내 확인 필요"}</strong></div>
          </>}
          <div className="phone-qr">
            <button type="button" disabled={qr === null || scan !== null} onClick={() => setScan(qr!.sign_id)}>{scan !== null ? "인식 중…" : qr !== null ? "QR 비추기 · 위치 확인" : "보이는 QR 없음"}</button>
            <small role="status">{confirmed !== null ? `위치 확인 · ${display?.node_labels[building.signs.find(s=>s.sign_id===confirmed)?.node_id ?? ""] ?? confirmed} (모의 인식)` : "QR을 비추지 않아도 대피와 경로 갱신은 계속됩니다"}</small>
          </div>
          <div className="phone-home" aria-hidden="true"/>
        </div>
      </section>
      <svg className="phone-thumb" viewBox="0 0 75 170" aria-hidden="true"><path d="M66 161Q34 141 19 107L6 57Q1 35 16 30 33 25 42 50L58 83 72 101Z" fill="#d39a73" stroke="#ac7655" strokeWidth="2"/><path d="M12 45Q17 35 26 43L34 63Q26 71 20 65Z" fill="#e8b994"/></svg>
    </div>
    <button type="button" className="phone-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "휴대폰 내리기" : "휴대폰 꺼내기"}</button>
  </div>;
}
