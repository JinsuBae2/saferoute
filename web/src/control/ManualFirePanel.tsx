import { useEffect, useMemo, useRef, useState } from "react";
import type { Building, BuildingDisplay, StateSnapshot } from "@contracts";
import { ManualFireControl, manualFireSources } from "./manualFire";
import type { ManualAction, ManualResult } from "./manualFire";

type Props = { building: Building; display: BuildingDisplay | null; state: StateSnapshot; connected: boolean };

/** Keyed by run in the dashboard: reset drops selection and previous receipts. */
export function ManualFirePanel({ building, display, state, connected }: Props) {
  const control = useMemo(() => new ManualFireControl(building, state.run_id), [building, state.run_id]);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [zoneId, setZoneId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; result: ManualResult | null; failed: boolean } | null>(null);
  const sources = useMemo(() => manualFireSources(building), [building]);
  const source = sources.find((item) => item.zone_id === zoneId);
  const active = new Set(state.active_causes.filter((cause) => cause.hazard_type === "FIRE").map((cause) => cause.source_id));
  const activeSources = sources.filter((item) => active.has(item.source_id));
  const name = (id: string) => display?.zone_labels[id] ?? building.zones.find((zone) => zone.zone_id === id)?.label ?? id;
  const disabled = pending || !connected;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; control.cancel(); };
  }, [control]);

  async function act(action: ManualAction) {
    if (disabled || busy.current) return;
    busy.current = true;
    setPending(true); setNotice(null);
    const target = action.kind === "clear_all" ? "모든 시험 화재" : name(action.zoneId);
    try {
      const result = await control.run(action);
      if (mounted.current) setNotice({ text: `${target} · ${action.kind === "ignite" ? "발생" : "해제"} ${result.completed}건 서버 수락`, result, failed: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: `${target} · ${error instanceof Error ? error.message : "결과를 확인하지 못했습니다"}`, result: null, failed: true });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  /** 실행기에 재실행을 요청한다. 성공하면 run_id가 바뀌어 이 패널이 새로 열린다. */
  async function restart() {
    if (pending || busy.current) return;
    busy.current = true;
    setPending(true); setNotice(null);
    try {
      const response = await fetch("/sim/restart", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error([404, 405].includes(response.status) ? "지금 실행기는 재실행을 지원하지 않습니다" : `HTTP ${response.status}`);
      if (mounted.current) setNotice({ text: "시뮬레이션 재실행 · 새 실행으로 다시 시작합니다", result: null, failed: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: `시뮬레이션 재실행 실패 · ${error instanceof Error ? error.message : "응답을 확인하지 못했습니다"}`, result: null, failed: true });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <details className="panel manual-fire">
      <summary>시험 화재 조작 · 시뮬레이션 재실행 · AI 감지와 별도</summary>
      <p className="panel__note">구역 선택 후 버튼을 눌러 시험 입력을 보냅니다. 경로·표지 방향은 서버가 계산하며 단말 적용 여부는 아래 적용 현황에서 확인합니다.</p>
      <label className="manual-fire__zone">대상 구역
        <select value={zoneId} disabled={disabled} onChange={(event) => setZoneId(event.target.value)}>
          <option value="">구역을 선택하세요</option>
          {building.zones.map((zone) => <option key={zone.zone_id} value={zone.zone_id} disabled={!sources.some((item) => item.zone_id === zone.zone_id)}>
            {name(zone.zone_id)}{sources.some((item) => item.zone_id === zone.zone_id) ? "" : " · 시험 입력 미등록"}
          </option>)}
        </select>
      </label>
      <p className="panel__note">{source ? <>{name(source.zone_id)} · 시험 전용 입력 <code>{source.source_id}</code> · {active.has(source.source_id) ? "화재 활성" : "활성 화재 없음"}</> : "등록된 시험 관측원이 있는 구역만 선택할 수 있습니다."}</p>
      <div className="manual-fire__actions">
        <button type="button" disabled={disabled || !source || active.has(source.source_id)} onClick={() => void act({ kind: "ignite", zoneId })}>시험 화재 발생</button>
        <button type="button" disabled={disabled || !source || !active.has(source.source_id)} onClick={() => void act({ kind: "clear", zoneId })}>선택 화재 해제</button>
        <button type="button" disabled={disabled || activeSources.length === 0} onClick={() => void act({ kind: "clear_all" })}>시험 화재 모두 해제</button>
      </div>
      <p className="panel__note">시험 화재 {activeSources.length}건 활성 · 모두 해제해도 실제 AI·감지기 경보와 관측 장애는 유지됩니다.</p>
      {activeSources.length > 0 && <ul>{activeSources.map((item) => <li key={item.source_id}>{name(item.zone_id)} · 시험 화재</li>)}</ul>}
      <div className="manual-fire__actions">
        <button type="button" disabled={pending} onClick={() => void restart()}>시뮬레이션 재실행</button>
      </div>
      <p className="panel__note">제어기를 초기화하고 시나리오를 처음부터 다시 시작합니다. 모든 경보와 시험 화재가 지워지고, 접속한 모든 화면에 적용됩니다.</p>
      {!connected && <p role="alert">현재 제어 상태를 확인할 수 없어 조작을 잠시 막았습니다.</p>}
      {state.controller_mode === "INITIALIZING" && <p className="panel__note">제어기 준비 중입니다. 시험 입력이 수락돼도 필수 관측과 시작 확인 전에는 경로 안내를 시작하지 않습니다.</p>}
      <p role="status" aria-live="polite">{pending ? "서버 응답을 확인하고 있습니다…" : notice?.text ?? "현재 실행 기준입니다. 실행이 초기화되면 선택과 이전 조작 결과도 초기화됩니다."}
        {notice?.result && (state.guidance_version >= notice.result.guidanceVersion ? " · 현재 서버 상태 반영 확인" : " · 최신 상태 반영 대기")}
      </p>
      {notice?.failed && <p className="panel__note">자동 재시도하지 않습니다. 현재 활성 목록을 확인한 뒤 다시 조작하세요.</p>}
    </details>
  );
}
